import { NextRequest, NextResponse } from "next/server";
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
import { llmCaptionQA, llmImageDeepReview, llmOcrTextQA, llmVerify, type LLMIssueCandidate } from "@/lib/models/adapters";
import { getModelConfig, isModelConfigured, isRoleConfigured } from "@/lib/models/gateway";
import { cachedModelResult, stableHash } from "@/lib/models/modelResultCache";
import { updateDeepScanCheckpoint, type DeepScanPhase } from "@/lib/qa/deepScanJobs";
import { protectedTermsFromBrandKit } from "@/lib/qa/protectedText";
import {
  applyDeterministicOcrVisualRoles,
  applyVisionOcrVisualRoles,
  isVisualCheckableOcrBox,
  summarizeOcrVisualRoles,
} from "@/lib/qa/visualTextFilter";
import { PRIMARY_CAPTION_ARTBOARD_ID, workspaceTargetFingerprint } from "@/lib/qa/workspaceFingerprint";
import { imageModelPayload, payloadBboxToOriginal } from "@/lib/ocr/imageModelPayload";
import type { AgentModelConfig, AgentRunStep, AgentRunTrace, Asset, BrandKit, Issue, OcrBox, Workspace } from "@/types";

type Bbox = NonNullable<Issue["bbox"]>;
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
type ImageDeepReviewResult = NonNullable<Awaited<ReturnType<typeof llmImageDeepReview>>>;

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
  brandKitHash: string,
  opts: { maxTokens?: number; timeoutMs?: number } = {}
): Promise<LLMIssueCandidate[]> {
  const chunks = chunkOcrBoxes(boxes);
  const results = await mapWithConcurrency(chunks, MODEL_BATCH_CONCURRENCY, async (chunk) => {
    const { value: issues } = await cachedModelResult({
      modelRole: role,
      promptVersion: `ocr-text-review-${reviewerName.toLocaleLowerCase("vi-VN")}-v2`,
      contentHash: stableHash({
        role,
        reviewerName,
        boxes: chunk.map((box) => ({
          box_id: box.box_id,
          text: box.text,
          confidence: box.confidence,
          visual_role: box.visual_role,
          visual_should_check: box.visual_should_check,
        })),
      }),
      brandKitHash,
    }, async () => {
      const result = await withModelRetry(() => llmOcrTextQA(role, reviewerName, chunk, brandKit, opts));
      return result.value;
    });
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

function issueModelSignature(issue: Issue): string {
  return stableHash({
    type: issue.type,
    severity: issue.severity,
    original: normalizedText(issue.original),
    suggestion: normalizedText(issue.suggestion),
    source_type: issue.source_type,
    source_id: issue.source_id,
    artboard_id: issue.artboard_id,
    box_id: issue.box_id,
  });
}

function comparableIssueText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("vi-VN");
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, index) => index);
  const curr = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }
  return prev[b.length];
}

function textSimilarity(a: string, b: string): number {
  const left = comparableIssueText(a);
  const right = comparableIssueText(b);
  if (!left && !right) return 1;
  return 1 - levenshteinDistance(left, right) / Math.max(left.length, right.length, 1);
}

function digitSignature(value: string): string {
  return (value.match(/\d+/g) ?? []).join("|");
}

function protectedTermSurvives(original: string, corrected: string, brandKit: BrandKit): boolean {
  const originalLower = comparableIssueText(original);
  const correctedLower = comparableIssueText(corrected);
  return brandKit.do_not_change.every((term) => {
    const normalized = comparableIssueText(term);
    return !normalized || !originalLower.includes(normalized) || correctedLower.includes(normalized);
  });
}

function applySafeOcrCorrections(
  boxes: OcrBox[],
  corrections: { box_id: string; corrected_text: string; confidence?: number }[] | undefined,
  brandKit: BrandKit
): OcrBox[] {
  const byId = new Map((corrections ?? []).map((item) => [item.box_id, item]));
  return boxes.map((box) => {
    const item = byId.get(box.box_id);
    const text = typeof item?.corrected_text === "string" ? item.corrected_text.replace(/\s+/g, " ").trim() : "";
    const confidence = typeof item?.confidence === "number" ? Math.max(0, Math.min(1, item.confidence)) : 0;
    if (!item || !text || confidence < 0.86) return box;
    if (text.length > 240) return box;
    if (comparableIssueText(text) === comparableIssueText(box.text)) {
      return { ...box, confidence: Math.max(box.confidence, Math.min(0.98, confidence)) };
    }
    if (digitSignature(box.text) !== digitSignature(text)) return box;
    if (!protectedTermSurvives(box.text, text, brandKit)) return box;
    if (textSimilarity(box.text, text) < 0.72) return box;
    if (box.confidence >= 0.84 && confidence < 0.93 && textSimilarity(box.text, text) < 0.88) return box;
    return { ...box, text, confidence: Math.max(box.confidence, Math.min(0.98, confidence)) };
  });
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
      const suggested = [...cluster].sort((a, b) =>
        b.confidence - a.confidence ||
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        b.original.length - a.original.length
      )[0];
      if (suggested && suggested.original.trim()) {
        const reviewIssue: Issue = {
          ...suggested,
          severity: "needs_review",
          confidence: Math.min(0.74, Math.max(0.5, suggested.confidence)),
          is_definite_error: false,
          status: "open",
          reason: suggested.reason.includes("Typolice cần bạn xác nhận")
            ? suggested.reason
            : `${suggested.reason} Typolice cần bạn xác nhận vì lỗi này mới được một bước rà ảnh phát hiện.`,
          created_by: `${suggested.created_by}+needs_review_staging`,
        };
        acceptedCandidates += 1;
        if (pushUniqueIssue(currentIssues, reviewIssue)) addedIssues += 1;
      } else {
        skippedIssues += cluster.length;
      }
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

function storedAssetName(url: string): string {
  return path.basename(new URL(url, "http://typolice.local").pathname);
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
    project_id = undefined,
    visual_qa = false,
    caption_llm = false,
    deep_job_id = null,
    content_fingerprint = null,
    defer_save = false,
    target_artboard_id = null,
  } = await req.json().catch(() => ({}));
  const projectId = typeof project_id === "string" && project_id.trim() ? project_id.trim() : undefined;
  const deepJobId = typeof deep_job_id === "string" && deep_job_id.trim() ? deep_job_id.trim() : null;
  const expectedFingerprint = typeof content_fingerprint === "string" && content_fingerprint.trim()
    ? content_fingerprint.trim()
    : null;
  const shouldDeferSave = defer_save === true;
  const sourceWorkspace = getWorkspace(projectId, scope);
  const ws = shouldDeferSave
    ? JSON.parse(JSON.stringify(sourceWorkspace)) as Workspace
    : sourceWorkspace;
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
  }, () => loadBrandKit(projectId, scope));
  const brandKitHash = stableHash(brandKit);
  const protectedTerms = protectedTermsFromBrandKit(brandKit);
  const allIssues: Issue[] = [];
  const dateCandidates: DateConsistencyCandidate[] = [];
  const checkpoint = (
    phase: DeepScanPhase,
    status: "running" | "completed" | "failed",
    detail?: string,
    count?: number
  ) => updateDeepScanCheckpoint(deepJobId, phase, { status, detail, count });

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
      checkpoint("caption_ai", "running", `Đang rà kỹ ${nonEmptyCaptionTargets.length} caption.`);
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
      let qwenCacheHits = 0;
      let verifierFailures = 0;
      let verifierRetries = 0;
      let verifierCacheHits = 0;

      for (const target of nonEmptyCaptionTargets) {
        const cachedCaption = await cachedModelResult({
          modelRole: "caption_qa",
          promptVersion: "caption-qa-v3",
          contentHash: stableHash({ sourceId: target.sourceId, text: target.text }),
          brandKitHash,
        }, async () => {
          const { value, retries } = await withModelRetry(() => llmCaptionQA(target.text, brandKit));
          qwenRetries += retries;
          return value;
        });
        const candidates = cachedCaption.value;
        if (cachedCaption.cacheHit) qwenCacheHits += 1;
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
          const cachedVerify = await cachedModelResult<string[]>({
            modelRole: "verify",
            promptVersion: "caption-verifier-v2",
            contentHash: stableHash({
              sourceId: target.sourceId,
              text: target.text,
              candidates: validated.map((issue) => ({
                type: issue.type,
                severity: issue.severity,
                original: issue.original,
                suggestion: issue.suggestion,
                reason: issue.reason,
              })),
            }),
            brandKitHash,
          }, async () => {
            const { value, retries } = await withModelRetry(() => llmVerify(target.text, brandKit, validated));
            verifierRetries += retries;
            if (!value) return null;
            return validated
              .filter((issue) => value.kept.has(issue.issue_id))
              .map(issueModelSignature);
          });
          const verifiedSignatures = cachedVerify.value;
          if (cachedVerify.cacheHit) verifierCacheHits += 1;
          if (verifiedSignatures) {
            const keptSignatures = new Set(verifiedSignatures);
            kept = validated.filter((issue) => keptSignatures.has(issueModelSignature(issue)));
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
        ? `Qwen returned ${returnedCandidates} candidate(s), ${validatedCandidates} validated; ${qwenFailures}/${nonEmptyCaptionTargets.length} caption artboard(s) returned no usable JSON.${qwenRetries ? ` Retried ${qwenRetries} time(s).` : ""}${qwenCacheHits ? ` Cache hit ${qwenCacheHits} caption(s).` : ""}`
        : `Qwen returned ${returnedCandidates} candidate(s), ${validatedCandidates} validated across ${nonEmptyCaptionTargets.length} caption artboard(s).${qwenRetries ? ` Retried ${qwenRetries} time(s).` : ""}${qwenCacheHits ? ` Cache hit ${qwenCacheHits} caption(s).` : ""}`;
      llmStep.count = validatedCandidates;

      if (verifierStep) {
        verifierStep.duration_ms = Date.now() - verifierStarted;
        verifierStep.status = verifierFailures > 0 ? "failed" : "completed";
        verifierStep.detail = verifierFailures
          ? `MiniMax kept ${keptCandidates}/${validatedCandidates} validated LLM issue(s); ${verifierFailures} verifier call(s) were unavailable and kept validated issues for review.${verifierRetries ? ` Retried ${verifierRetries} time(s).` : ""}${verifierCacheHits ? ` Cache hit ${verifierCacheHits} caption(s).` : ""}`
          : `MiniMax kept ${keptCandidates}/${validatedCandidates} validated LLM issue(s).${verifierRetries ? ` Retried ${verifierRetries} time(s).` : ""}${verifierCacheHits ? ` Cache hit ${verifierCacheHits} caption(s).` : ""}`;
        verifierStep.count = keptCandidates;
      }
      checkpoint("caption_ai", "completed", `Đã rà kỹ caption, giữ ${keptCandidates} lỗi contextual.`, keptCandidates);
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
      checkpoint("caption_ai", "completed", captionQaOk ? "Bỏ qua ở fast run." : "Chưa cấu hình model caption.", 0);
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
    checkpoint("caption_ai", "completed", "Không có caption để rà kỹ.", 0);
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
  checkpoint("ocr", "running", qaAssets.length ? `Đang đọc chữ trên ${qaAssets.length} ảnh.` : "Không có ảnh để đọc.", qaAssets.length);
  const ocrRuntime = qaAssets.length ? await import("@/lib/ocr/ocrService") : null;

  for (const asset of qaAssets) {
    const storedName = storedAssetName(asset.url);
    const filePath = path.join(uploadsDir(projectId, scope), storedName);

    if (
      asset.ocr_status === "pending" ||
      asset.ocr_status === "processing" ||
      asset.ocr_status === "failed" ||
      !ocrRuntime?.hasCurrentOcrBoxes(asset.ocr_boxes)
    ) {
      try {
        if (!ocrRuntime) throw new Error("Image text reader is not available.");
        asset.ocr_status = "processing";
        asset.ocr_boxes = await ocrRuntime.runOcr(filePath, asset.id, asset.hash);
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
    checkpoint("ocr", "completed", `Đã đọc ${ocrBoxes} vùng chữ trên ảnh.`, ocrBoxes);
  } else {
    skipStep(trace, {
      id: "tesseract_ocr",
      label: "Đọc chữ trên ảnh",
      tool: "tesseract.js + sharp preprocessing",
      detail: "Skipped because no image assets are in the workspace.",
    });
    checkpoint("ocr", "completed", "Không có ảnh để đọc.", 0);
  }

  const imageDeepReviewByAsset = new Map<string, ImageDeepReviewResult>();
  const assetsForCombinedVision = imageQaOk
    ? qaAssets.filter((asset) => (
        asset.ocr_status !== "failed" &&
        (visual_qa || asset.ocr_status === "low_confidence" || asset.ocr_boxes.length === 0)
      ))
    : [];
  const combinedVisionStep = qaAssets.length && imageQaOk
    ? addStep(trace, {
        id: "gemma_combined_image_review",
        label: "Rà ảnh một lượt",
        model_role: "image_qa",
        model: models.image_qa,
        detail: "Dùng một ảnh đã resize/compress để sửa OCR, lọc vùng graphic text và tìm lỗi chữ trên ảnh.",
      })
    : null;
  if (combinedVisionStep) {
    if (assetsForCombinedVision.length > 0) {
      const started = Date.now();
      let payloadCacheHits = 0;
      let modelCacheHits = 0;
      let detectedBoxes = 0;
      const results = await mapWithConcurrency(assetsForCombinedVision, VISION_ASSET_CONCURRENCY, async (asset) => {
        try {
          const storedName = storedAssetName(asset.url);
          const filePath = path.join(uploadsDir(projectId, scope), storedName);
          const payload = await imageModelPayload(filePath, asset.hash);
          if (payload.cacheHit) payloadCacheHits += 1;
          const cached = await cachedModelResult<ImageDeepReviewResult>({
            modelRole: "image_qa",
            promptVersion: "image-deep-review-v1",
            contentHash: stableHash({
              assetHash: asset.hash,
              payload: { width: payload.width, height: payload.height },
              boxes: asset.ocr_boxes.map((box) => ({
                box_id: box.box_id,
                text: box.text,
                confidence: box.confidence,
                bbox: box.bbox,
                visual_role: box.visual_role,
                visual_should_check: box.visual_should_check,
              })),
            }),
            brandKitHash,
          }, async () => {
            const modelResult = await withModelRetry(() => llmImageDeepReview(
              payload.dataUrl,
              asset.ocr_boxes,
              brandKit,
              { width: payload.width, height: payload.height }
            ));
            return modelResult.value;
          });
          if (cached.cacheHit) modelCacheHits += 1;
          if (!cached.value) return false;
          const extraBoxes = (cached.value.detected_boxes ?? [])
            .filter((box) => typeof box.text === "string" && box.text.trim() && Array.isArray(box.bbox))
            .slice(0, 16)
            .map((box, index): OcrBox => ({
              box_id: `ocr_v5_${asset.hash.slice(0, 8)}_vision_${index}`,
              asset_id: asset.id,
              text: box.text.replace(/\s+/g, " ").trim(),
              confidence: Math.max(0.35, Math.min(0.82, typeof box.confidence === "number" ? box.confidence : 0.62)),
              bbox: payloadBboxToOriginal(box.bbox, payload),
              language: "vi",
              visual_role: "unknown",
              visual_should_check: true,
              visual_confidence: Math.max(0.35, Math.min(0.82, typeof box.confidence === "number" ? box.confidence : 0.62)),
              visual_reason: box.reason || "Vision phát hiện vùng chữ có thể OCR bỏ sót.",
            }));
          if (extraBoxes.length) {
            const existing = new Set(asset.ocr_boxes.map((box) => comparableIssueText(box.text)));
            const unique = extraBoxes.filter((box) => !existing.has(comparableIssueText(box.text)));
            asset.ocr_boxes.push(...unique);
            detectedBoxes += unique.length;
            asset.ocr_status = ocrStatusForBoxes(asset.ocr_boxes);
          }
          imageDeepReviewByAsset.set(asset.id, cached.value);
          return true;
        } catch (err) {
          console.error("[run-qa] combined image review failed:", err instanceof Error ? err.message : err);
          return false;
        }
      });
      combinedVisionStep.duration_ms = Date.now() - started;
      completeStep(
        combinedVisionStep,
        `Rà một lượt ${results.filter(Boolean).length}/${assetsForCombinedVision.length} ảnh.${payloadCacheHits ? ` Payload cache ${payloadCacheHits}.` : ""}${modelCacheHits ? ` Model cache ${modelCacheHits}.` : ""}${detectedBoxes ? ` Phát hiện thêm ${detectedBoxes} vùng chữ cần xem.` : ""}`,
        results.filter(Boolean).length
      );
    } else {
      combinedVisionStep.status = "skipped";
      combinedVisionStep.detail = visual_qa
        ? "Skipped because no readable image text was found."
        : "Skipped because image text was already clear enough for fast check.";
      combinedVisionStep.count = 0;
    }
  } else {
    skipStep(trace, {
      id: "gemma_combined_image_review",
      label: "Rà ảnh một lượt",
      model_role: "image_qa",
      model: models.image_qa,
      detail: imageQaOk ? "Bỏ qua vì chưa có ảnh trong workspace." : "Bỏ qua vì chưa cấu hình bước đọc chữ trên ảnh.",
    });
  }

  const assetsForCorrection = imageQaOk
    ? qaAssets.filter((asset) => (
        asset.ocr_status !== "failed" &&
        asset.ocr_boxes.length > 0 &&
        (visual_qa || asset.ocr_status === "low_confidence")
      ))
    : [];
  checkpoint("image_ai", "running", qaAssets.length ? `Đang rà kỹ chữ trên ${qaAssets.length} ảnh.` : "Không có ảnh để rà kỹ.", qaAssets.length);
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
          const review = imageDeepReviewByAsset.get(asset.id);
          if (!review) return false;
          asset.ocr_boxes = applySafeOcrCorrections(asset.ocr_boxes, review.corrections, brandKit);
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
          const review = imageDeepReviewByAsset.get(asset.id);
          if (review?.classifications?.length) {
            asset.ocr_boxes = applyVisionOcrVisualRoles(asset.ocr_boxes, review.classifications);
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
  const minimaxImageTextStep = qaAssets.length && verifierOk && visual_qa
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
      const candidates = await runOcrTextReviewerBatches(role, reviewerName, boxesForReview, brandKit, brandKitHash, opts);
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
          const result = imageDeepReviewByAsset.get(asset.id);
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
  checkpoint(
    "image_ai",
    "completed",
    qaAssets.length
      ? `Đã rà kỹ chữ trên ảnh: ${qwenImageTextValidated + minimaxImageTextValidated + visionCrossCheckValidated} candidate.`
      : "Không có ảnh để rà kỹ.",
    qwenImageTextValidated + minimaxImageTextValidated + visionCrossCheckValidated
  );

  const imageAiConsensusStep = qaAssets.length
    ? addStep(trace, {
        id: "image_ai_self_check",
        label: "Tự kiểm tra kết quả ảnh",
        tool: "consensus filter",
        detail: "Chỉ hiển thị lỗi chữ trên ảnh khi kết quả đủ chắc hoặc được nhiều bước kiểm tra đồng ý.",
      })
    : null;
  if (imageAiConsensusStep) {
    checkpoint("self_check", "running", "Đang tự lọc các lỗi ảnh đủ chắc trước khi hiển thị.");
    const result = acceptStableImageAiIssues(imageAiCandidates, allIssues);
    qwenImageTextIssues = allIssues.filter((issue) => issue.created_by.includes("qwen_image_text_qa")).length;
    minimaxImageTextIssues = allIssues.filter((issue) => issue.created_by.includes("minimax_image_text_qa")).length;
    visionCrossCheckIssues = allIssues.filter((issue) => issue.created_by.includes("vision_image_qa")).length;
    completeStep(
      imageAiConsensusStep,
      `Đã tự kiểm tra ${result.stagedIssues} lỗi chữ trên ảnh; hiển thị ${result.acceptedClusters} nhóm lỗi đủ chắc, bỏ qua ${result.skippedIssues} lỗi chưa đủ tin cậy.`,
      result.addedIssues
    );
    checkpoint("self_check", "completed", `Hiển thị ${result.addedIssues} lỗi ảnh đủ chắc.`, result.addedIssues);
  } else {
    checkpoint("self_check", "completed", "Không có lỗi ảnh cần tự lọc.", 0);
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
  checkpoint("merge", "running", "Đang merge kết quả rà kỹ vào workspace.");
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
  const workspaceToSave = targetArtboard
    ? shouldDeferSave
      ? JSON.parse(JSON.stringify(getWorkspace(projectId, scope))) as Workspace
      : getWorkspace(projectId, scope)
    : ws;
  workspaceToSave.assets = ws.assets;
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
  const currentWorkspace = getWorkspace(projectId, scope);
  const staleResult = Boolean(
    expectedFingerprint &&
    expectedFingerprint !== workspaceTargetFingerprint(currentWorkspace, targetArtboardId)
  );
  if (staleResult) {
    checkpoint("merge", "failed", "Nội dung đã đổi trong lúc rà kỹ; không lưu kết quả cũ.", finalIssues.length);
    return NextResponse.json({
      error: "stale_content",
      stale: true,
      summary: summarize(finalIssues),
      llm_used: llmOk,
      agent_trace: trace,
    }, { status: 409 });
  }

  if (!shouldDeferSave) {
    saveWorkspace(workspaceToSave, projectId, scope);
    checkpoint("merge", "completed", `Đã merge ${finalIssues.length} issue vào workspace.`, finalIssues.length);
  } else {
    checkpoint("merge", "completed", `Đã chuẩn bị ${finalIssues.length} issue để commit an toàn.`, finalIssues.length);
  }

  return NextResponse.json({
    workspace: workspaceToSave,
    summary: summarize(finalIssues),
    llm_used: llmOk,
    agent_trace: trace,
    stale: staleResult,
  });
}
