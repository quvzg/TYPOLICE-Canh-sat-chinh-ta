import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { deviceScopeFromRequest, getWorkspace, saveWorkspace, uploadsDir } from "@/lib/server/db";
import { loadBrandKit } from "@/lib/brand/brandGuidelineLoader";
import {
  chooseDateFormatStandard,
  dateFormatLabel,
  findDateFormatTokens,
  formatDateToken,
  runRuleChecker,
  type DateFormatPattern,
  type DateFormatToken,
} from "@/lib/qa/ruleChecker";
import { mergeIssues, summarize, validateLLMIssues } from "@/lib/qa/issueMerger";
import { llmCaptionQA, llmClassifyOcrBoxes, llmImageCrossCheck, llmOcrTextQA, llmVerify, type LLMIssueCandidate } from "@/lib/models/adapters";
import { getModelConfig, isModelConfigured, isRoleConfigured } from "@/lib/models/gateway";
import { hasCurrentOcrBoxes, runOcr } from "@/lib/ocr/ocrService";
import { correctOcrWithVision } from "@/lib/ocr/ocrVisionCorrection";
import { runLinkSafetyChecks } from "@/lib/qa/linkSafety";
import { protectedTermsFromBrandKit } from "@/lib/qa/protectedText";
import {
  applyDeterministicOcrVisualRoles,
  applyVisionOcrVisualRoles,
  isVisualCheckableOcrBox,
  summarizeOcrVisualRoles,
} from "@/lib/qa/visualTextFilter";
import type { AgentModelConfig, AgentRunStep, AgentRunTrace, Asset, BrandKit, Issue, OcrBox, Workspace } from "@/types";

type Bbox = NonNullable<Issue["bbox"]>;
const PRIMARY_CAPTION_ARTBOARD_ID = "artboard_caption";
const IMAGE_RULE_MIN_CONFIDENCE = 0.62;
const IMAGE_REVIEW_CONFIDENCE = 0.5;
const OCR_TEXT_BATCH_MAX_BOXES = 36;
const OCR_TEXT_BATCH_MAX_CHARS = 5200;
const FAST_IMAGE_REVIEW_MAX_BOXES = 24;
const FAST_IMAGE_REVIEW_MIN_BOXES = 10;
const MODEL_BATCH_CONCURRENCY = 2;
const VISION_ASSET_CONCURRENCY = 2;
const IMAGE_ISSUE_TYPES = new Set<Issue["type"]>([
  "spelling",
  "spacing",
  "punctuation",
  "hashtag",
  "brand_term",
  "terminology",
  "grammar",
  "style",
  "ambiguity",
  "ocr_low_confidence",
]);
const ISSUE_SEVERITIES = new Set<Issue["severity"]>([
  "critical",
  "high",
  "medium",
  "low",
  "suggestion",
  "needs_review",
]);
const SEVERITY_RANK: Record<Issue["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  suggestion: 4,
  needs_review: 5,
};

interface DateConsistencyCandidate {
  token: DateFormatToken;
  text: string;
  source_type: Issue["source_type"];
  source_id: string;
  artboard_id: string | null;
  box_id: string | null;
  bbox: Bbox | null;
}

interface CaptionTarget {
  sourceId: string;
  artboardId: string | null;
  label: string;
  text: string;
}

type WorkspaceArtboard = Workspace["artboards"][number];

function artboardKind(ab: Workspace["artboards"][number]) {
  return ab.kind ?? (ab.format === "caption" ? "caption" : ab.format === "note" ? "note" : "visual");
}

function getCaptionTargets(ws: Workspace): CaptionTarget[] {
  const targets: CaptionTarget[] = [{
    sourceId: ws.caption.id,
    artboardId: null,
    label: "Caption Input 1",
    text: ws.caption.text,
  }];

  for (const artboard of ws.artboards) {
    if (artboard.id === PRIMARY_CAPTION_ARTBOARD_ID) continue;
    if (artboardKind(artboard) !== "caption") continue;
    targets.push({
      sourceId: artboard.id,
      artboardId: artboard.id,
      label: artboard.label,
      text: artboard.text ?? "",
    });
  }

  return targets;
}

function getScopedCaptionTargets(ws: Workspace, targetArtboard: WorkspaceArtboard | null): CaptionTarget[] {
  const targets = getCaptionTargets(ws);
  if (!targetArtboard) return targets;
  if (artboardKind(targetArtboard) !== "caption") return [];
  if (targetArtboard.id === PRIMARY_CAPTION_ARTBOARD_ID) {
    return targets.filter((target) => target.artboardId === null);
  }
  return targets.filter((target) => target.artboardId === targetArtboard.id);
}

function issueBelongsToTarget(
  issue: Issue,
  targetArtboard: WorkspaceArtboard,
  targetAssetIds: Set<string>
): boolean {
  const kind = artboardKind(targetArtboard);
  if (kind === "caption") {
    return targetArtboard.id === PRIMARY_CAPTION_ARTBOARD_ID
      ? issue.source_type === "caption" && issue.artboard_id === null
      : issue.source_type === "caption" && issue.artboard_id === targetArtboard.id;
  }
  if (kind === "visual") {
    return issue.artboard_id === targetArtboard.id ||
      (issue.source_type === "image" && targetAssetIds.has(issue.source_id));
  }
  return issue.artboard_id === targetArtboard.id || issue.source_id === targetArtboard.id;
}

function normalizeImageIssueType(type: string | undefined): Issue["type"] {
  if (type === "brand_consistency") return "brand_term";
  return IMAGE_ISSUE_TYPES.has(type as Issue["type"]) ? (type as Issue["type"]) : "spelling";
}

function normalizeSeverity(severity: string | undefined): Issue["severity"] {
  return ISSUE_SEVERITIES.has(severity as Issue["severity"]) ? (severity as Issue["severity"]) : "needs_review";
}

function isCaseOnlyChange(original: string, suggestion: string): boolean {
  return original !== suggestion && original.toLocaleLowerCase("vi-VN") === suggestion.toLocaleLowerCase("vi-VN");
}

function isTinyOcrNoise(text: string): boolean {
  const alnum = text.match(/[\p{L}\p{N}]/gu) ?? [];
  return alnum.length <= 2 && !/\d/.test(text);
}

function createTrace(models: AgentModelConfig): AgentRunTrace {
  return {
    run_id: `agent_run_${Date.now().toString(36)}`,
    track: "Automation & Integration",
    objective: "Tự động QA caption, poster/carousel text, brand guideline và xuất review report trước khi publish.",
    started_at: new Date().toISOString(),
    completed_at: null,
    models,
    steps: [],
  };
}

function addStep(
  trace: AgentRunTrace,
  step: Omit<AgentRunStep, "status" | "duration_ms"> & { status?: AgentRunStep["status"] }
): AgentRunStep {
  const next: AgentRunStep = {
    ...step,
    status: step.status ?? "running",
  };
  trace.steps.push(next);
  return next;
}

async function runStep<T>(
  trace: AgentRunTrace,
  step: Omit<AgentRunStep, "status" | "duration_ms">,
  fn: () => Promise<T> | T
): Promise<T> {
  const started = Date.now();
  const current = addStep(trace, step);
  try {
    const result = await fn();
    current.status = "completed";
    current.duration_ms = Date.now() - started;
    return result;
  } catch (err) {
    current.status = "failed";
    current.duration_ms = Date.now() - started;
    current.detail = err instanceof Error ? err.message : "Step failed.";
    throw err;
  }
}

function completeStep(step: AgentRunStep | null, detail: string, count?: number) {
  if (!step) return;
  step.status = "completed";
  step.detail = detail;
  if (typeof count === "number") step.count = count;
}

function skipStep(
  trace: AgentRunTrace,
  step: Omit<AgentRunStep, "status" | "duration_ms">
) {
  addStep(trace, { ...step, status: "skipped" });
}

function textRangeToBbox(lineText: string, lineBbox: Bbox, range: Issue["range"], original?: string): Bbox {
  let start = range?.start ?? -1;
  let end = range?.end ?? -1;

  if ((start < 0 || end <= start) && original) {
    const index = lineText.toLowerCase().indexOf(original.toLowerCase());
    if (index >= 0) {
      start = index;
      end = index + original.length;
    }
  }

  if (start < 0 || end <= start) return lineBbox;

  const leadingWhitespace = lineText.match(/^\s*/)?.[0].length ?? 0;
  const trailingWhitespace = lineText.match(/\s*$/)?.[0].length ?? 0;
  const visibleStart = leadingWhitespace;
  const visibleEnd = Math.max(visibleStart + 1, lineText.length - trailingWhitespace);
  const visibleLength = Math.max(1, visibleEnd - visibleStart);
  const clampedStart = Math.max(visibleStart, Math.min(start, visibleEnd));
  const clampedEnd = Math.max(clampedStart + 1, Math.min(end, visibleEnd));
  const lineWidth = Math.max(1, lineBbox[2] - lineBbox[0]);
  const pad = Math.max(4, Math.round(lineWidth * 0.01));
  const x0 = lineBbox[0] + ((clampedStart - visibleStart) / visibleLength) * lineWidth;
  const x1 = lineBbox[0] + ((clampedEnd - visibleStart) / visibleLength) * lineWidth;

  return [
    Math.max(lineBbox[0], Math.round(x0 - pad)),
    lineBbox[1],
    Math.min(lineBbox[2], Math.round(x1 + pad)),
    lineBbox[3],
  ];
}

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("vi-VN");
}

function isRelatedIssue(candidate: Issue, issue: Issue): boolean {
  if (
    candidate.source_type !== issue.source_type ||
    candidate.source_id !== issue.source_id ||
    candidate.box_id !== issue.box_id
  ) {
    return false;
  }
  if (candidate.source_type === "caption" || issue.source_type === "caption") {
    const rangesOverlap = Boolean(
      candidate.range &&
      issue.range &&
      candidate.range.start < issue.range.end &&
      issue.range.start < candidate.range.end
    );
    if (!rangesOverlap) return false;
  }
  const candidateOriginal = normalizedText(candidate.original);
  const issueOriginal = normalizedText(issue.original);
  const candidateSuggestion = normalizedText(candidate.suggestion);
  const issueSuggestion = normalizedText(issue.suggestion);
  const sameReplacement = candidateSuggestion === issueSuggestion;
  const nestedReplacement = candidateSuggestion.includes(issueSuggestion) || issueSuggestion.includes(candidateSuggestion);
  const sameOriginal = candidateOriginal === issueOriginal;
  const nestedOriginal = candidateOriginal.includes(issueOriginal) || issueOriginal.includes(candidateOriginal);
  return (sameOriginal && sameReplacement && candidate.type === issue.type) || (nestedOriginal && nestedReplacement);
}

function pushUniqueIssue(issues: Issue[], issue: Issue): boolean {
  const existing = issues.find((candidate) => isRelatedIssue(candidate, issue));

  if (!existing) {
    issues.push(issue);
    return true;
  }

  const existingSpan = existing.original.length;
  const issueSpan = issue.original.length;
  const preferNewSpan = issueSpan < existingSpan && normalizedText(existing.original).includes(normalizedText(issue.original));
  if (preferNewSpan) {
    existing.issue_id = issue.issue_id;
    existing.type = issue.type;
    existing.original = issue.original;
    existing.suggestion = issue.suggestion;
    existing.reason = issue.reason;
    existing.bbox = issue.bbox;
  }

  if (SEVERITY_RANK[issue.severity] < SEVERITY_RANK[existing.severity]) {
    existing.severity = issue.severity;
  }
  existing.confidence = Math.max(existing.confidence, issue.confidence);
  existing.is_definite_error = existing.is_definite_error || issue.is_definite_error;
  existing.bbox = existing.bbox ?? issue.bbox;
  const existingCreators = new Set(existing.created_by.split("+"));
  if (!existingCreators.has(issue.created_by)) {
    existing.created_by = `${existing.created_by}+${issue.created_by}`;
  }
  if (issue.reason && !existing.reason.includes(issue.reason)) {
    existing.reason = `${existing.reason} / ${issue.created_by}: ${issue.reason}`;
  }
  return false;
}

function validateOcrTextCandidates(
  candidates: LLMIssueCandidate[],
  assetId: string,
  artboardId: string | null,
  boxById: Map<string, OcrBox>,
  brandDoNotChange: string[],
  createdBy: string,
  idPrefix: string
): Issue[] {
  const valid: Issue[] = [];
  let n = 0;
  for (const candidate of candidates) {
    if (!candidate.box_id) continue;
    const box = boxById.get(candidate.box_id);
    if (!box || !candidate.original || !box.text.includes(candidate.original)) continue;
    if (!candidateSelfCheckPass(candidate)) continue;
    const type = normalizeImageIssueType(candidate.type);
    const suggestion = candidate.suggestion ?? candidate.original;
    if (normalizedText(candidate.original) === normalizedText(suggestion)) continue;
    if ((type === "brand_term" || type === "style") && isCaseOnlyChange(candidate.original, suggestion)) continue;

    const validated = validateLLMIssues(
      box.text,
      [{
        ...candidate,
        type,
        severity: normalizeSeverity(candidate.severity),
        suggestion,
        source_type: "image",
        source_id: assetId,
        artboard_id: artboardId,
        box_id: box.box_id,
        created_by: createdBy,
      }],
      brandDoNotChange
    );

    for (const issue of validated) {
      n += 1;
      const range = issue.range;
      issue.issue_id = `issue_${idPrefix}_${box.box_id}_${n}`;
      issue.bbox = textRangeToBbox(box.text, box.bbox, range, issue.original);
      issue.range = null;
      issue.confidence = Math.min(1, Math.max(0, issue.confidence));
      issue.is_definite_error = issue.is_definite_error || (issue.confidence >= 0.82 && issue.severity !== "suggestion");
      valid.push(issue);
    }
  }
  return valid;
}

function candidateSelfCheckPass(candidate: LLMIssueCandidate): boolean {
  const check = candidate.self_check;
  if (!check) return true;
  if (check.exact_substring === false) return false;
  if (check.visible_or_in_ocr === false) return false;
  if (check.not_protected_term === false) return false;
  if (check.not_ocr_uncertainty === false) {
    const severity = normalizeSeverity(candidate.severity);
    return severity === "needs_review" || candidate.is_definite_error === false;
  }
  return true;
}

interface OcrBoxMeta {
  box: OcrBox;
  assetId: string;
  artboardId: string | null;
}

function ocrStatusForBoxes(boxes: OcrBox[]): Asset["ocr_status"] {
  if (boxes.length === 0) return "done";
  const avg = boxes.reduce((sum, box) => sum + box.confidence, 0) / boxes.length;
  return avg < 0.6 ? "low_confidence" : "done";
}

function isReviewableOcrBox(box: OcrBox): boolean {
  return Boolean(box.text.trim()) && !isTinyOcrNoise(box.text) && box.confidence >= IMAGE_REVIEW_CONFIDENCE;
}

function chunkOcrBoxes(boxes: OcrBox[]): OcrBox[][] {
  const chunks: OcrBox[][] = [];
  let current: OcrBox[] = [];
  let chars = 0;

  for (const box of boxes) {
    const nextChars = box.text.length + 80;
    if (
      current.length > 0 &&
      (current.length >= OCR_TEXT_BATCH_MAX_BOXES || chars + nextChars > OCR_TEXT_BATCH_MAX_CHARS)
    ) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(box);
    chars += nextChars;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

function fastReviewScore(box: OcrBox): number {
  const text = box.text.toLocaleLowerCase("vi-VN");
  let score = 0;
  if (box.confidence < 0.8) score += 5;
  else if (box.confidence < 0.9) score += 3;
  if (/[;:]/.test(box.text)) score += 3;
  if (findDateFormatTokens(box.text).length > 0) score += 3;
  if (/ {2,}|#\s+|\S +[.,!?;:]/u.test(box.text)) score += 5;
  if (/(đối tượng|hình thức|thời gian|địa điểm|deadline|hạn chót|đăng ký|tham gia|giải thưởng|thể lệ|lưu ý|link|form)/u.test(text)) score += 4;
  if (/(green node|claw -|claw-a-thon|starter|ai agent|non-tech|no-tech)/u.test(text)) score += 3;
  if (box.text.length <= 140) score += 1;
  return score;
}

function chooseFastReviewBoxes(boxes: OcrBox[]): OcrBox[] {
  if (boxes.length <= FAST_IMAGE_REVIEW_MAX_BOXES) return boxes;
  const ranked = boxes
    .map((box, index) => ({ box, index, score: fastReviewScore(box) }))
    .sort((a, b) => b.score - a.score || a.box.confidence - b.box.confidence || a.index - b.index);
  const positiveCount = ranked.filter((item) => item.score > 0).length;
  const take = Math.min(
    FAST_IMAGE_REVIEW_MAX_BOXES,
    Math.max(FAST_IMAGE_REVIEW_MIN_BOXES, positiveCount)
  );
  return ranked.slice(0, take).map((item) => item.box);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function withModelRetry<T>(
  fn: () => Promise<T | null>,
  attempts = 2
): Promise<{ value: T | null; retries: number }> {
  let lastError: unknown = null;
  let retries = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const value = await fn();
      if (value !== null) return { value, retries };
    } catch (err) {
      lastError = err;
    }

    if (attempt < attempts) {
      retries += 1;
      await new Promise((resolve) => setTimeout(resolve, 650));
    }
  }
  if (lastError) {
    console.warn("[run-qa] model retry exhausted:", lastError instanceof Error ? lastError.message : lastError);
  }
  return { value: null, retries };
}

async function runOcrTextReviewerBatches(
  role: "caption_qa" | "verify",
  reviewerName: string,
  boxes: OcrBox[],
  brandKit: BrandKit,
  opts: { maxTokens?: number; timeoutMs?: number } = {}
): Promise<LLMIssueCandidate[]> {
  const chunks = chunkOcrBoxes(boxes);
  const results = await mapWithConcurrency(chunks, MODEL_BATCH_CONCURRENCY, async (chunk) => {
    const { value: issues } = await withModelRetry(() => llmOcrTextQA(role, reviewerName, chunk, brandKit, opts));
    return issues ?? [];
  });
  return results.flat();
}

function validateWorkspaceOcrTextCandidates(
  candidates: LLMIssueCandidate[],
  metaByBoxId: Map<string, OcrBoxMeta>,
  brandDoNotChange: string[],
  createdBy: string,
  idPrefix: string
): Issue[] {
  const grouped = new Map<string, LLMIssueCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.box_id || !metaByBoxId.has(candidate.box_id)) continue;
    const group = grouped.get(candidate.box_id) ?? [];
    group.push(candidate);
    grouped.set(candidate.box_id, group);
  }

  const valid: Issue[] = [];
  for (const [boxId, boxCandidates] of grouped) {
    const meta = metaByBoxId.get(boxId);
    if (!meta) continue;
    if (!isVisualCheckableOcrBox(meta.box)) continue;
    valid.push(...validateOcrTextCandidates(
      boxCandidates,
      meta.assetId,
      meta.artboardId,
      new Map([[boxId, meta.box]]),
      brandDoNotChange,
      createdBy,
      idPrefix
    ));
  }
  return valid;
}

function issueEvidenceSources(issue: Issue): Set<string> {
  return new Set(issue.created_by.split("+").map((source) => source.trim()).filter(Boolean));
}

function clusterRelatedIssues(issues: Issue[]): Issue[][] {
  const clusters: Issue[][] = [];
  for (const issue of issues) {
    const cluster = clusters.find((items) => items.some((candidate) => isRelatedIssue(candidate, issue)));
    if (cluster) cluster.push(issue);
    else clusters.push([issue]);
  }
  return clusters;
}

function acceptStableImageAiIssues(candidates: Issue[], currentIssues: Issue[]): {
  acceptedClusters: number;
  acceptedCandidates: number;
  addedIssues: number;
  stagedIssues: number;
  skippedIssues: number;
} {
  const clusters = clusterRelatedIssues(candidates.filter((issue) => issue.source_type === "image"));
  let acceptedClusters = 0;
  let acceptedCandidates = 0;
  let addedIssues = 0;
  let skippedIssues = 0;

  for (const cluster of clusters) {
    const evidenceSources = new Set(cluster.flatMap((issue) => Array.from(issueEvidenceSources(issue))));
    const backedByRule = currentIssues.some((existing) =>
      existing.source_type === "image" &&
      cluster.some((issue) => isRelatedIssue(existing, issue))
    );
    const maxConfidence = Math.max(...cluster.map((issue) => issue.confidence));
    const hasDefiniteHighConfidence = cluster.some((issue) =>
      issue.is_definite_error &&
      issue.confidence >= 0.9 &&
      issue.severity !== "suggestion" &&
      issue.severity !== "needs_review"
    );
    const hasIndependentAgreement = evidenceSources.size >= 2 && maxConfidence >= 0.68;
    const accept = backedByRule || hasIndependentAgreement || hasDefiniteHighConfidence;

    if (!accept) {
      skippedIssues += cluster.length;
      continue;
    }

    acceptedClusters += 1;
    const ranked = [...cluster].sort((a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.confidence - a.confidence ||
      b.original.length - a.original.length
    );
    for (const issue of ranked) {
      acceptedCandidates += 1;
      if (pushUniqueIssue(currentIssues, issue)) addedIssues += 1;
    }
  }

  return {
    acceptedClusters,
    acceptedCandidates,
    addedIssues,
    stagedIssues: candidates.length,
    skippedIssues,
  };
}

function mimeFromStoredName(storedName: string): string {
  const ext = path.extname(storedName).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function artboardIdForAsset(artboards: { id: string; layers: { asset_id: string }[] }[], assetId: string): string | null {
  return artboards.find((ab) => ab.layers.some((layer) => layer.asset_id === assetId))?.id ?? null;
}

function sameDateFormat(a: DateFormatPattern, b: DateFormatPattern): boolean {
  return a.dayWidth === b.dayWidth &&
    a.monthWidth === b.monthWidth &&
    a.separator === b.separator &&
    a.yearWidth === b.yearWidth;
}

function createDateConsistencyIssue(
  candidate: DateConsistencyCandidate,
  standard: DateFormatPattern,
  index: number
): Issue | null {
  if (sameDateFormat(candidate.token.format, standard)) return null;
  const suggestion = formatDateToken(candidate.token, standard);
  if (normalizedText(candidate.token.original) === normalizedText(suggestion)) return null;

  return {
    issue_id: `issue_datefmt_${Date.now().toString(36)}_${index}`,
    source_type: candidate.source_type,
    source_id: candidate.source_id,
    artboard_id: candidate.artboard_id,
    box_id: candidate.box_id,
    type: "style",
    severity: "medium",
    original: candidate.token.original,
    suggestion,
    reason: `Format ngày tháng không đồng bộ. Nên dùng thống nhất dạng ${dateFormatLabel(standard)} trong cùng nội dung.`,
    confidence: 0.9,
    is_definite_error: false,
    range: candidate.source_type === "caption"
      ? { start: candidate.token.start, end: candidate.token.end }
      : null,
    bbox: candidate.bbox
      ? textRangeToBbox(candidate.text, candidate.bbox, { start: candidate.token.start, end: candidate.token.end }, candidate.token.original)
      : null,
    context_before: candidate.text.slice(Math.max(0, candidate.token.start - 12), candidate.token.start),
    context_after: candidate.text.slice(candidate.token.end, candidate.token.end + 12),
    status: "open",
    created_by: "date_consistency_checker",
  };
}

/**
 * Run QA across the whole workspace:
 *  caption (rules + LLM) → image text (rules + optional vision model).
 * Image QA intentionally checks copy/text only, not design layout risks.
 * Preserves accepted/ignored statuses from the previous run.
 */
export async function POST(req: NextRequest) {
  const scope = deviceScopeFromRequest(req);
  const {
    visual_qa = false,
    caption_llm = false,
    target_artboard_id = null,
  } = await req.json().catch(() => ({}));
  const ws = getWorkspace(undefined, scope);
  const targetArtboardId = typeof target_artboard_id === "string" && target_artboard_id.trim()
    ? target_artboard_id.trim()
    : null;
  const targetArtboard = targetArtboardId
    ? ws.artboards.find((artboard) => artboard.id === targetArtboardId) ?? null
    : null;
  if (targetArtboardId && !targetArtboard) {
    return NextResponse.json({ error: "Artboard not found." }, { status: 404 });
  }
  const targetKind = targetArtboard ? artboardKind(targetArtboard) : null;
  const targetAssetIds = new Set(targetArtboard?.layers.map((layer) => layer.asset_id) ?? []);
  const qaAssets = targetArtboard
    ? targetKind === "visual"
      ? ws.assets.filter((asset) => targetAssetIds.has(asset.id))
      : []
    : ws.assets;
  const llmOk = isModelConfigured();
  const captionQaOk = isRoleConfigured("caption_qa");
  const verifierOk = isRoleConfigured("verify");
  const imageQaOk = isRoleConfigured("image_qa");
  const models = getModelConfig();
  const trace = createTrace(models);
  const brandKit = await runStep(trace, {
    id: "load_guidelines",
    label: "Load brand guidelines",
    tool: "brand_guideline_loader",
    detail: "Read brand terms, preferred spellings, protected terms and style notes.",
  }, () => loadBrandKit(undefined, scope));
  const protectedTerms = protectedTermsFromBrandKit(brandKit);
  const allIssues: Issue[] = [];
  const dateCandidates: DateConsistencyCandidate[] = [];

  // ---- 1. Caption QA ----
  const captionTargets = getScopedCaptionTargets(ws, targetArtboard);
  const nonEmptyCaptionTargets = captionTargets.filter((target) => target.text.trim());
  const captionIssueBuckets = new Map<string, { ruleIssues: Issue[]; llmIssues: Issue[] }>();

  for (const target of captionTargets) {
    for (const token of findDateFormatTokens(target.text)) {
      dateCandidates.push({
        token,
        text: target.text,
        source_type: "caption",
        source_id: target.sourceId,
        artboard_id: target.artboardId,
        box_id: null,
        bbox: null,
      });
    }
    captionIssueBuckets.set(target.sourceId, { ruleIssues: [], llmIssues: [] });
  }

  if (nonEmptyCaptionTargets.length > 0) {
    const ruleStep = addStep(trace, {
      id: "caption_rules",
      label: "Deterministic caption checks",
      tool: "ruleChecker.ts",
      detail: `Check exact-range Vietnamese formatting, typo dictionary, hashtag format and brand-term rules across ${nonEmptyCaptionTargets.length} caption artboard(s).`,
    });
    const ruleStarted = Date.now();
    let totalRuleIssues = 0;
    for (const target of nonEmptyCaptionTargets) {
      const ruleIssues = runRuleChecker(target.text, brandKit, {
        source_type: "caption",
        source_id: target.sourceId,
        artboard_id: target.artboardId,
      });
      captionIssueBuckets.get(target.sourceId)!.ruleIssues = ruleIssues;
      totalRuleIssues += ruleIssues.length;
    }
    ruleStep.status = "completed";
    ruleStep.duration_ms = Date.now() - ruleStarted;
    ruleStep.detail = `Found ${totalRuleIssues} deterministic caption issue(s) across ${nonEmptyCaptionTargets.length} caption artboard(s).`;
    ruleStep.count = totalRuleIssues;

    if (captionQaOk && caption_llm) {
      const llmStep = addStep(trace, {
        id: "qwen_caption_qa",
        label: "Qwen caption QA",
        model_role: "caption_qa",
        model: models.caption_qa,
        detail: `Ask Qwen to find contextual Vietnamese, brand and style issues across ${nonEmptyCaptionTargets.length} caption artboard(s).`,
      });
      const verifierStep = verifierOk
        ? addStep(trace, {
            id: "minimax_verifier",
            label: "MiniMax false-positive verifier",
            model_role: "verify",
            model: models.verify,
            detail: "Second-pass reviewer removes hallucinated spans, weak style suggestions and unsafe brand edits.",
          })
        : null;
      const llmStarted = Date.now();
      const verifierStarted = Date.now();
      let returnedCandidates = 0;
      let validatedCandidates = 0;
      let keptCandidates = 0;
      let qwenFailures = 0;
      let qwenRetries = 0;
      let verifierFailures = 0;
      let verifierRetries = 0;

      for (const target of nonEmptyCaptionTargets) {
        const { value: candidates, retries: captionRetries } = await withModelRetry(() => llmCaptionQA(target.text, brandKit));
        qwenRetries += captionRetries;
        if (!candidates) {
          qwenFailures += 1;
          continue;
        }
        returnedCandidates += candidates.length;
        const validated = validateLLMIssues(
          target.text,
          candidates.map((candidate) => ({
            ...candidate,
            source_type: "caption",
            source_id: target.sourceId,
            artboard_id: target.artboardId,
            created_by: "llm_caption_qa",
          } as Partial<Issue>)),
          protectedTerms
        );
        validatedCandidates += validated.length;

        let kept = validated;
        if (verifierOk && validated.length > 0) {
          const { value: verified, retries: verifyRetries } = await withModelRetry(() => llmVerify(target.text, brandKit, validated));
          verifierRetries += verifyRetries;
          if (verified) {
            kept = validated.filter((issue) => verified.kept.has(issue.issue_id));
          } else {
            verifierFailures += 1;
          }
        }
        keptCandidates += kept.length;
        captionIssueBuckets.get(target.sourceId)!.llmIssues.push(...kept);
      }

      llmStep.duration_ms = Date.now() - llmStarted;
      llmStep.status = qwenFailures === nonEmptyCaptionTargets.length ? "failed" : "completed";
      llmStep.detail = qwenFailures
        ? `Qwen returned ${returnedCandidates} candidate(s), ${validatedCandidates} validated; ${qwenFailures}/${nonEmptyCaptionTargets.length} caption artboard(s) returned no usable JSON.${qwenRetries ? ` Retried ${qwenRetries} time(s).` : ""}`
        : `Qwen returned ${returnedCandidates} candidate(s), ${validatedCandidates} validated across ${nonEmptyCaptionTargets.length} caption artboard(s).${qwenRetries ? ` Retried ${qwenRetries} time(s).` : ""}`;
      llmStep.count = validatedCandidates;

      if (verifierStep) {
        verifierStep.duration_ms = Date.now() - verifierStarted;
        verifierStep.status = verifierFailures > 0 ? "failed" : "completed";
        verifierStep.detail = verifierFailures
          ? `MiniMax kept ${keptCandidates}/${validatedCandidates} validated LLM issue(s); ${verifierFailures} verifier call(s) were unavailable and kept validated issues for review.${verifierRetries ? ` Retried ${verifierRetries} time(s).` : ""}`
          : `MiniMax kept ${keptCandidates}/${validatedCandidates} validated LLM issue(s).${verifierRetries ? ` Retried ${verifierRetries} time(s).` : ""}`;
        verifierStep.count = keptCandidates;
      }
    } else {
      skipStep(trace, {
        id: "qwen_caption_qa",
        label: "Qwen caption QA",
        model_role: "caption_qa",
        model: models.caption_qa,
        detail: captionQaOk
          ? "Skipped in fast workspace scan. Smart Run starts contextual caption QA in the background."
          : "Skipped because caption QA role is not configured.",
      });
      skipStep(trace, {
        id: "minimax_verifier",
        label: "MiniMax false-positive verifier",
        model_role: "verify",
        model: models.verify,
        detail: verifierOk
          ? "Skipped because Qwen caption QA was not requested in this fast scan."
          : "Skipped because verifier role is not configured.",
      });
    }

    for (const target of nonEmptyCaptionTargets) {
      const bucket = captionIssueBuckets.get(target.sourceId)!;
      allIssues.push(...mergeIssues(bucket.ruleIssues, bucket.llmIssues));
    }
  } else {
    skipStep(trace, {
      id: "caption_rules",
      label: "Deterministic caption checks",
      tool: "ruleChecker.ts",
      detail: "Skipped because all caption artboards are empty.",
    });
    skipStep(trace, {
      id: "qwen_caption_qa",
      label: "Qwen caption QA",
      model_role: "caption_qa",
      model: models.caption_qa,
      detail: "Skipped because all caption artboards are empty.",
    });
    skipStep(trace, {
      id: "minimax_verifier",
      label: "MiniMax false-positive verifier",
      model_role: "verify",
      model: models.verify,
      detail: "Skipped because all caption artboards are empty.",
    });
  }

  // ---- 2. QR codes + text links. Links printed inside images are intentionally skipped. ----
  const linkSafetyCaption = !targetArtboard ||
    (targetKind === "caption" && targetArtboard.id === PRIMARY_CAPTION_ARTBOARD_ID)
    ? ws.caption
    : { ...ws.caption, text: "" };
  const linkSafetyArtboards = !targetArtboard
    ? ws.artboards
    : targetKind === "caption" && targetArtboard.id !== PRIMARY_CAPTION_ARTBOARD_ID
      ? [targetArtboard]
      : targetKind === "visual"
        ? [targetArtboard]
        : [];
  const linkSafety = await runStep(trace, {
    id: "qr_link_safety",
    label: "QR & link safety",
    tool: "jsQR + URL probe",
    detail: "Decode QR codes on image assets and check links from caption/note artboards. Links printed inside image text are skipped.",
  }, () => runLinkSafetyChecks({
    caption: linkSafetyCaption,
    artboards: linkSafetyArtboards,
    assets: qaAssets,
    getAssetFilePath: (asset) => path.join(uploadsDir(undefined, scope), path.basename(asset.url)),
  }));
  for (const issue of linkSafety.issues) {
    pushUniqueIssue(allIssues, issue);
  }
  const linkSafetyStep = trace.steps.find((s) => s.id === "qr_link_safety");
  if (linkSafetyStep) {
    linkSafetyStep.detail = `Checked ${linkSafety.scannedLinks} link/QR payload(s), decoded ${linkSafety.scannedQrCodes} QR code(s), ${linkSafety.reachableLinks} reachable. Found ${linkSafety.issues.length} link safety issue(s).${linkSafety.threatApiUsed ? " Web Risk lookup was used." : " Threat API not configured; used local safety + reachability checks."}`;
    linkSafetyStep.count = linkSafety.issues.length;
  }

  // ---- 2. Read image text once, then run batched text-only image QA ----
  let ocrAssets = 0;
  let ocrBoxes = 0;
  let ocrFailures = 0;
  let imageRuleIssues = 0;
  let visionCorrectionAssets = 0;
  let visionCorrectionCandidates = 0;
  let qwenImageTextValidated = 0;
  let qwenImageTextIssues = 0;
  let minimaxImageTextValidated = 0;
  let minimaxImageTextIssues = 0;
  let visionCrossCheckValidated = 0;
  let visionCrossCheckIssues = 0;
  let visualFilteredBoxes = 0;
  let visualCheckableBoxes = 0;
  let visualSkippedBoxes = 0;
  let visualFilterModelAssets = 0;

  const ocrStep = qaAssets.length
    ? addStep(trace, {
        id: "tesseract_ocr",
        label: "Đọc chữ trên ảnh",
        tool: "tesseract.js + sharp preprocessing",
        detail: "Extract visible text boxes from poster/carousel images.",
      })
    : null;

  for (const asset of qaAssets) {
    const storedName = path.basename(asset.url);
    const filePath = path.join(uploadsDir(undefined, scope), storedName);

    if (
      asset.ocr_status === "pending" ||
      asset.ocr_status === "processing" ||
      asset.ocr_status === "failed" ||
      !hasCurrentOcrBoxes(asset.ocr_boxes)
    ) {
      try {
        asset.ocr_status = "processing";
        asset.ocr_boxes = await runOcr(filePath, asset.id, asset.hash);
        ocrAssets += 1;
      } catch {
        ocrFailures += 1;
        asset.ocr_status = "failed";
      }
    }

    if (asset.ocr_status !== "failed") {
      asset.ocr_status = ocrStatusForBoxes(asset.ocr_boxes);
      ocrBoxes += asset.ocr_boxes.length;
    }
  }

  if (ocrStep) {
    completeStep(
      ocrStep,
      `Read ${ocrAssets} new/stale image(s), reused ${Math.max(0, qaAssets.length - ocrAssets)} cached image(s), found ${ocrBoxes} text area(s).${ocrFailures ? ` ${ocrFailures} image(s) could not be read.` : ""}`,
      ocrBoxes
    );
  } else {
    skipStep(trace, {
      id: "tesseract_ocr",
      label: "Đọc chữ trên ảnh",
      tool: "tesseract.js + sharp preprocessing",
      detail: "Skipped because no image assets are in the workspace.",
    });
  }

  const assetsForCorrection = imageQaOk
    ? qaAssets.filter((asset) => (
        asset.ocr_status !== "failed" &&
        asset.ocr_boxes.length > 0 &&
        (visual_qa || asset.ocr_status === "low_confidence")
      ))
    : [];
  visionCorrectionCandidates = assetsForCorrection.length;
  const correctionStep = qaAssets.length && imageQaOk
    ? addStep(trace, {
        id: "gemma_ocr_correction",
        label: "Improve image text reading",
        model_role: "image_qa",
        model: models.image_qa,
        detail: visual_qa
          ? "Deep scan: use vision model to improve text read from images while keeping highlight boxes stable."
          : "Fast scan: only improve image text when Typolice is not confident.",
      })
    : null;

  if (correctionStep) {
    if (assetsForCorrection.length > 0) {
      const started = Date.now();
      const results = await mapWithConcurrency(assetsForCorrection, VISION_ASSET_CONCURRENCY, async (asset) => {
        try {
          const storedName = path.basename(asset.url);
          const filePath = path.join(uploadsDir(undefined, scope), storedName);
          const { value: correctedBoxes } = await withModelRetry(() => correctOcrWithVision(filePath, asset.ocr_boxes, brandKit));
          if (!correctedBoxes) throw new Error("Vision correction returned no result.");
          asset.ocr_boxes = correctedBoxes;
          asset.ocr_status = ocrStatusForBoxes(asset.ocr_boxes);
          return true;
        } catch (err) {
          console.error("[run-qa] vision image text correction failed:", err instanceof Error ? err.message : err);
          return false;
        }
      });
      visionCorrectionAssets = results.filter(Boolean).length;
      correctionStep.duration_ms = Date.now() - started;
      completeStep(
        correctionStep,
        `Vision model improved text reading for ${visionCorrectionAssets}/${visionCorrectionCandidates} image(s).`,
        visionCorrectionAssets
      );
    } else {
      correctionStep.status = "skipped";
      correctionStep.detail = visual_qa
        ? "Skipped because no image text was found."
        : "Skipped because Typolice already read the image text clearly enough for fast check.";
      correctionStep.count = 0;
    }
  } else {
    skipStep(trace, {
      id: "gemma_ocr_correction",
      label: "Improve image text reading",
      model_role: "image_qa",
      model: models.image_qa,
      detail: imageQaOk ? "Skipped because deep visual QA was not requested." : "Skipped because image QA role is not configured.",
    });
  }

  const visualFilterStep = qaAssets.length
    ? addStep(trace, {
        id: "visual_text_filter",
        label: "Lọc vùng chữ trên ảnh",
        tool: visual_qa && imageQaOk ? "deterministic + vision classifier" : "deterministic classifier",
        detail: "Identify which detected text areas are real graphic text; skip standalone type logos, decorative text and icon noise.",
      })
    : null;

  if (visualFilterStep) {
    const started = Date.now();
    const classifiableAssets = qaAssets.filter((asset) => asset.ocr_status !== "failed" && asset.ocr_boxes.length > 0);
    for (const asset of classifiableAssets) {
      asset.ocr_boxes = applyDeterministicOcrVisualRoles(asset.ocr_boxes, brandKit);
    }

    if (visual_qa && imageQaOk && classifiableAssets.length > 0) {
      const results = await mapWithConcurrency(classifiableAssets, VISION_ASSET_CONCURRENCY, async (asset) => {
        try {
          const storedName = path.basename(asset.url);
          const filePath = path.join(uploadsDir(undefined, scope), storedName);
          const buf = fs.readFileSync(filePath);
          const dataUrl = `data:${mimeFromStoredName(storedName)};base64,${buf.toString("base64")}`;
          const { value: result } = await withModelRetry(() => llmClassifyOcrBoxes(dataUrl, asset.ocr_boxes, brandKit));
          if (result?.classifications) {
            asset.ocr_boxes = applyVisionOcrVisualRoles(asset.ocr_boxes, result.classifications);
            return true;
          }
        } catch (err) {
          console.error("[run-qa] visual text classification failed:", err instanceof Error ? err.message : err);
        }
        return false;
      });
      visualFilterModelAssets = results.filter(Boolean).length;
    }

    const summary = summarizeOcrVisualRoles(classifiableAssets.flatMap((asset) => asset.ocr_boxes));
    visualFilteredBoxes = summary.total;
    visualCheckableBoxes = summary.checkable;
    visualSkippedBoxes = summary.skipped;
    visualFilterStep.duration_ms = Date.now() - started;
    completeStep(
      visualFilterStep,
      `Kept ${visualCheckableBoxes}/${visualFilteredBoxes} text area(s) for checking; skipped ${visualSkippedBoxes} logo/decorative/icon area(s).${visualFilterModelAssets ? ` Vision classifier refined ${visualFilterModelAssets} image(s).` : ""}`,
      visualCheckableBoxes
    );
  } else {
    skipStep(trace, {
      id: "visual_text_filter",
      label: "Lọc vùng chữ trên ảnh",
      tool: "deterministic classifier",
      detail: "Skipped because no image assets are in the workspace.",
    });
  }

  const allBoxMetaById = new Map<string, OcrBoxMeta>();
  const reviewableBoxes: OcrBox[] = [];
  const imageRuleStep = qaAssets.length
    ? addStep(trace, {
        id: "image_text_rules",
        label: "Kiểm tra chữ trên ảnh",
        tool: "ruleChecker.ts",
        detail: "Run caption-style language and brand rules on trusted image text areas.",
      })
    : null;

  for (const asset of qaAssets) {
    if (asset.ocr_status === "failed") continue;
    const artboardId = artboardIdForAsset(ws.artboards, asset.id);

    for (const box of asset.ocr_boxes) {
      allBoxMetaById.set(box.box_id, { box, assetId: asset.id, artboardId });
      if (!isVisualCheckableOcrBox(box)) continue;

      if (isReviewableOcrBox(box)) {
        reviewableBoxes.push(box);
        for (const token of findDateFormatTokens(box.text)) {
          dateCandidates.push({
            token,
            text: box.text,
            source_type: "image",
            source_id: asset.id,
            artboard_id: artboardId,
            box_id: box.box_id,
            bbox: box.bbox,
          });
        }
      }

      if (!box.text.trim()) continue;
      if (isTinyOcrNoise(box.text) && box.confidence < IMAGE_RULE_MIN_CONFIDENCE) continue;

      if (box.confidence < IMAGE_REVIEW_CONFIDENCE) {
        pushUniqueIssue(allIssues, {
          issue_id: `issue_ocrconf_${box.box_id}`,
          source_type: "image",
          source_id: asset.id,
          artboard_id: artboardId,
          box_id: box.box_id,
          type: "ocr_low_confidence",
          severity: "needs_review",
          original: box.text.slice(0, 80),
          suggestion: box.text.slice(0, 80),
          reason: `Typolice chưa đọc rõ chữ này (${Math.round(box.confidence * 100)}%). Bạn kiểm tra trực tiếp trên ảnh nhé.`,
          confidence: box.confidence,
          is_definite_error: false,
          range: null,
          bbox: box.bbox,
          status: "open",
          created_by: "ocr_service",
        });
        continue;
      }
      if (box.confidence < IMAGE_RULE_MIN_CONFIDENCE) continue;

      const boxIssues = runRuleChecker(box.text, brandKit, {
        source_type: "image",
        source_id: asset.id,
        box_id: box.box_id,
        artboard_id: artboardId,
      }).map((i) => ({ ...i, range: null, bbox: textRangeToBbox(box.text, box.bbox, i.range, i.original) }));
      for (const issue of boxIssues) {
        if (pushUniqueIssue(allIssues, issue)) imageRuleIssues += 1;
      }
    }
  }

  if (imageRuleStep) {
    completeStep(imageRuleStep, `Found ${imageRuleIssues} image-text rule issue(s).`, imageRuleIssues);
  } else {
    skipStep(trace, {
      id: "image_text_rules",
      label: "Kiểm tra chữ trên ảnh",
      tool: "ruleChecker.ts",
      detail: "Skipped because no image assets are in the workspace.",
    });
  }

  const qwenImageTextStep = qaAssets.length && captionQaOk && visual_qa
    ? addStep(trace, {
        id: "qwen_image_text_qa",
        label: "Rà kỹ chữ trên ảnh",
        model_role: "caption_qa",
        model: models.caption_qa,
        detail: "Deep scan: batched review of image text areas with Vietnamese caption QA logic, without design/layout checks.",
      })
    : null;
  const minimaxImageTextStep = qaAssets.length && verifierOk
    ? addStep(trace, {
        id: "minimax_image_text_qa",
        label: "Soát chéo chữ trên ảnh",
        model_role: "verify",
        model: models.verify,
        detail: "Independent batched image text reviewer to catch copy issues Qwen or rules may miss.",
      })
    : null;
  const imageAiCandidates: Issue[] = [];

  const runTextModelReview = async (
    step: AgentRunStep,
    role: "caption_qa" | "verify",
    reviewerName: string,
    createdBy: string,
    idPrefix: string,
    boxesForReview: OcrBox[],
    opts: { maxTokens?: number; timeoutMs?: number } = {}
  ): Promise<{ validated: number; issues: Issue[] }> => {
    if (boxesForReview.length === 0) {
      step.status = "skipped";
      step.detail = "Skipped because no reviewable image text area was found.";
      step.count = 0;
      return { validated: 0, issues: [] };
    }

    const started = Date.now();
    try {
      const candidates = await runOcrTextReviewerBatches(role, reviewerName, boxesForReview, brandKit, opts);
      const validated = validateWorkspaceOcrTextCandidates(
        candidates,
        allBoxMetaById,
        protectedTerms,
        createdBy,
        idPrefix
      );
      step.duration_ms = Date.now() - started;
      completeStep(
        step,
        `${reviewerName} proposed ${validated.length} image-text issue candidate(s) from ${boxesForReview.length}/${reviewableBoxes.length} text area(s); candidates are checked again before showing.`,
        validated.length
      );
      return { validated: validated.length, issues: validated };
    } catch (err) {
      step.status = "failed";
      step.duration_ms = Date.now() - started;
      step.detail = `${reviewerName} image text QA failed; deterministic image rules still completed.`;
      console.error(`[run-qa] ${reviewerName} image text QA failed:`, err instanceof Error ? err.message : err);
      return { validated: 0, issues: [] };
    }
  };

  const textReviewTasks: Promise<void>[] = [];
  const fastReviewBoxes = chooseFastReviewBoxes(reviewableBoxes);
  const minimaxReviewBoxes = visual_qa ? reviewableBoxes : fastReviewBoxes;
  if (qwenImageTextStep) {
    textReviewTasks.push(runTextModelReview(
      qwenImageTextStep,
      "caption_qa",
      "Qwen",
      "qwen_image_text_qa",
      "qwenimg",
      reviewableBoxes,
      { maxTokens: 2200, timeoutMs: 30_000 }
    )
      .then((result) => {
        qwenImageTextValidated = result.validated;
        imageAiCandidates.push(...result.issues);
      }));
  } else {
    skipStep(trace, {
      id: "qwen_image_text_qa",
      label: "Rà kỹ chữ trên ảnh",
      model_role: "caption_qa",
      model: models.caption_qa,
      detail: captionQaOk
        ? "Bỏ qua ở bước kiểm tra nhanh. Typolice sẽ dùng bước này khi rà kỹ."
        : "Bỏ qua vì chưa cấu hình vai trò kiểm tra caption.",
    });
  }
  if (minimaxImageTextStep) {
    textReviewTasks.push(runTextModelReview(
      minimaxImageTextStep,
      "verify",
      "MiniMax",
      "minimax_image_text_qa",
      "minimaximg",
      minimaxReviewBoxes,
      visual_qa ? { maxTokens: 2200, timeoutMs: 28_000 } : { maxTokens: 1400, timeoutMs: 16_000 }
    )
      .then((result) => {
        minimaxImageTextValidated = result.validated;
        imageAiCandidates.push(...result.issues);
      }));
  } else {
    skipStep(trace, {
      id: "minimax_image_text_qa",
      label: "Soát chéo chữ trên ảnh",
      model_role: "verify",
      model: models.verify,
      detail: verifierOk ? "Bỏ qua vì chưa có ảnh trong workspace." : "Bỏ qua vì chưa cấu hình bước soát chéo.",
    });
  }
  await Promise.all(textReviewTasks);

  const assetsForVisionCrossCheck = imageQaOk
    ? qaAssets.filter((asset) => (
        asset.ocr_status !== "failed" &&
        asset.ocr_boxes.some(isVisualCheckableOcrBox) &&
        (visual_qa || asset.ocr_status === "low_confidence")
      ))
    : [];
  const visionCrossStep = qaAssets.length && imageQaOk
    ? addStep(trace, {
        id: "gemma_image_crosscheck",
        label: "Rà lại chữ trên ảnh",
        model_role: "image_qa",
        model: models.image_qa,
        detail: visual_qa
          ? "Rà kỹ chữ nhìn thấy trên ảnh; bỏ qua lỗi thiết kế/bố cục."
          : "Kiểm tra nhanh những ảnh Typolice chưa đọc thật rõ.",
      })
    : null;

  if (visionCrossStep) {
    if (assetsForVisionCrossCheck.length > 0) {
      const started = Date.now();
      const results = await mapWithConcurrency(assetsForVisionCrossCheck, VISION_ASSET_CONCURRENCY, async (asset) => {
        try {
          const storedName = path.basename(asset.url);
          const filePath = path.join(uploadsDir(undefined, scope), storedName);
          const buf = fs.readFileSync(filePath);
          const dataUrl = `data:${mimeFromStoredName(storedName)};base64,${buf.toString("base64")}`;
          const checkableBoxes = asset.ocr_boxes.filter(isVisualCheckableOcrBox);
          const { value: result } = await withModelRetry(() => llmImageCrossCheck(dataUrl, checkableBoxes, brandKit));
          return validateWorkspaceOcrTextCandidates(
            result?.issues ?? [],
            allBoxMetaById,
            protectedTerms,
            "vision_image_qa",
            "vision"
          );
        } catch (err) {
          console.error("[run-qa] vision cross-check failed:", err instanceof Error ? err.message : err);
          return [];
        }
      });
      const validated = results.flat();
      visionCrossCheckValidated = validated.length;
      imageAiCandidates.push(...validated);
      visionCrossStep.duration_ms = Date.now() - started;
      completeStep(
        visionCrossStep,
        `Vision model proposed ${visionCrossCheckValidated} text-only image issue candidate(s) on ${assetsForVisionCrossCheck.length} asset(s); candidates are checked again before showing.`,
        visionCrossCheckValidated
      );
    } else {
      visionCrossStep.status = "skipped";
      visionCrossStep.detail = visual_qa
        ? "Skipped because no image text was found."
        : "Skipped because Typolice already read the image text clearly enough for fast check.";
      visionCrossStep.count = 0;
    }
  } else {
    skipStep(trace, {
      id: "gemma_image_crosscheck",
      label: "Rà lại chữ trên ảnh",
      model_role: "image_qa",
      model: models.image_qa,
      detail: imageQaOk ? "Bỏ qua vì chưa có ảnh trong workspace." : "Bỏ qua vì chưa cấu hình bước đọc chữ trên ảnh.",
    });
  }

  const imageAiConsensusStep = qaAssets.length
    ? addStep(trace, {
        id: "image_ai_self_check",
        label: "Tự kiểm tra kết quả ảnh",
        tool: "consensus filter",
        detail: "Chỉ hiển thị lỗi chữ trên ảnh khi kết quả đủ chắc hoặc được nhiều bước kiểm tra đồng ý.",
      })
    : null;
  if (imageAiConsensusStep) {
    const result = acceptStableImageAiIssues(imageAiCandidates, allIssues);
    qwenImageTextIssues = allIssues.filter((issue) => issue.created_by.includes("qwen_image_text_qa")).length;
    minimaxImageTextIssues = allIssues.filter((issue) => issue.created_by.includes("minimax_image_text_qa")).length;
    visionCrossCheckIssues = allIssues.filter((issue) => issue.created_by.includes("vision_image_qa")).length;
    completeStep(
      imageAiConsensusStep,
      `Đã tự kiểm tra ${result.stagedIssues} lỗi chữ trên ảnh; hiển thị ${result.acceptedClusters} nhóm lỗi đủ chắc, bỏ qua ${result.skippedIssues} lỗi chưa đủ tin cậy.`,
      result.addedIssues
    );
  }

  const dateConsistencyStep = addStep(trace, {
    id: "date_format_consistency",
    label: "Date format consistency",
    tool: "ruleChecker.ts",
    detail: "Check date format consistency across captions and image text in the same workspace content.",
  });
  const standard = chooseDateFormatStandard(dateCandidates.map((candidate, index) => ({
    ...candidate.token,
    start: index,
  })));
  let dateConsistencyIssues = 0;
  if (standard) {
    let n = 0;
    for (const candidate of dateCandidates) {
      n += 1;
      const issue = createDateConsistencyIssue(candidate, standard, n);
      if (issue && pushUniqueIssue(allIssues, issue)) dateConsistencyIssues += 1;
    }
    completeStep(
      dateConsistencyStep,
      `Found ${dateConsistencyIssues} date-format consistency issue(s) across ${dateCandidates.length} date token(s). Standard: ${dateFormatLabel(standard)}.`,
      dateConsistencyIssues
    );
  } else {
    completeStep(
      dateConsistencyStep,
      `No date-format mismatch found across ${dateCandidates.length} date token(s).`,
      0
    );
  }

  // ---- Preserve prior user decisions (accepted/ignored) by issue identity ----
  const mergeStep = addStep(trace, {
    id: "merge_user_decisions",
    label: "Merge with human decisions",
    tool: "issueMerger + workspace memory",
    detail: "Preserve accepted/ignored decisions and produce final actionable issue list.",
  });
  const prior = new Map(
    ws.issues
      .filter((i) => i.status === "accepted" || i.status === "ignored")
      .map((i) => [`${i.source_type}|${i.source_id}|${i.original}|${i.suggestion}`, i.status])
  );
  for (const issue of allIssues) {
    const prev = prior.get(`${issue.source_type}|${issue.source_id}|${issue.original}|${issue.suggestion}`);
    if (prev) issue.status = prev;
  }
  const workspaceToSave = targetArtboard ? getWorkspace(undefined, scope) : ws;
  const preservedOutsideTarget = targetArtboard
    ? workspaceToSave.issues.filter((issue) => !issueBelongsToTarget(issue, targetArtboard, targetAssetIds))
    : [];
  const finalIssues = targetArtboard
    ? [...preservedOutsideTarget, ...allIssues]
    : allIssues;
  completeStep(
    mergeStep,
    targetArtboard
      ? `Scoped run updated ${allIssues.length} issue(s) for ${targetArtboard.label}; preserved ${preservedOutsideTarget.length} issue(s) from other artboards.`
      : `Final list has ${allIssues.length} issue(s); ${prior.size} prior human decision(s) preserved.`,
    allIssues.length
  );

  skipStep(trace, {
    id: "minimax_report",
    label: "MiniMax report writer",
    model_role: "report",
    model: models.report,
    detail: "Runs when the user exports QA Report; report uses the issues and corrected caption from this agent run.",
  });

  workspaceToSave.issues = finalIssues;
  trace.completed_at = new Date().toISOString();
  workspaceToSave.last_agent_trace = trace;
  saveWorkspace(workspaceToSave, undefined, scope);

  return NextResponse.json({
    workspace: workspaceToSave,
    summary: summarize(finalIssues),
    llm_used: llmOk,
    agent_trace: trace,
  });
}
