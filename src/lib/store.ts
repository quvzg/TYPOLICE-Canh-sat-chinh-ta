"use client";

import { create } from "zustand";
import type { AgentModelConfig, AgentRunTrace, Artboard, ArtboardPreset, Asset, BrandKit, Issue, Workspace } from "@/types";
import type { GuidelineUploadFile } from "@/lib/brand/guidelineUploads";
import { apiFetch } from "@/lib/device";
import { applyPatches, shiftRangesAfterPatch } from "@/lib/qa/patchService";
import { firstOpenSlotId, fitLayersToLayout, getLayoutSlotsFor, getPostLayout } from "@/lib/postLayouts";
import { validateImageUploadFiles } from "@/lib/uploadLimits";

export type QATab = "agent" | "issues" | "corrected" | "brandkit" | "export";
export type AppMode = "check" | "project";
export type ScanPhase = "fast_running" | "deep_running" | "complete" | "needs_rerun" | "failed";
export type CoverageStatus = "checked" | "still_checking" | "needs_review" | "could_not_fully_read";
export interface CardScanStatus {
  phase: ScanPhase;
  message: string;
  detail?: string;
  updatedAt: string;
  fastIssueCount?: number;
  finalIssueCount?: number;
  coverage?: CoverageStatus;
}
export interface ProjectSummary {
  id: string;
  name: string;
  kind: "check" | "project";
  created_at: string;
  updated_at: string;
}
export type GuidelineInput =
  | { list: "do_not_change" | "brand_terms" | "allowed_hashtags"; add_term: string }
  | {
      list:
        | "preferred_spellings"
        | "product_terms"
        | "preferred_wording"
        | "cta_avoid"
        | "missing_tone_map"
        | "wrong_tone_map"
        | "risky_words";
      wrong: string;
      correct: string;
    }
  | { list: "style_guideline"; note: string };

const CAPTION_ARTBOARD_ID = "artboard_caption";
const DEFAULT_IMAGE_CHECK_LABEL = "Visual Text Scanner";

function normalizeImageCheckLabel(label: string | undefined | null) {
  const clean = label?.trim();
  return !clean || clean === "Image text check" ? DEFAULT_IMAGE_CHECK_LABEL : clean;
}

function artboardKind(ab: Artboard) {
  return ab.kind ?? (ab.format === "caption" ? "caption" : ab.format === "note" ? "note" : "visual");
}

function isLocked(ab: Artboard | undefined) {
  return ab?.locked === true;
}

function isPrimaryCaptionArtboard(ab: Artboard | undefined) {
  return ab?.id === CAPTION_ARTBOARD_ID;
}

function isCaptionLocked(artboards: Artboard[]) {
  return artboards.some((ab) => isPrimaryCaptionArtboard(ab) && isLocked(ab));
}

function sameIssueTarget(a: Issue, b: Issue) {
  return a.source_type === b.source_type &&
    a.source_id === b.source_id &&
    (a.artboard_id ?? null) === (b.artboard_id ?? null) &&
    (a.box_id ?? null) === (b.box_id ?? null);
}

function shiftRangesForTarget(issues: Issue[], accepted: Issue) {
  const shiftedTarget = shiftRangesAfterPatch(
    issues.filter((i) => sameIssueTarget(i, accepted)),
    accepted
  );
  const byId = new Map(shiftedTarget.map((i) => [i.issue_id, i]));
  return issues.map((i) => byId.get(i.issue_id) ?? i);
}

function isIssueTargetLocked(issue: Issue, artboards: Artboard[]) {
  if (issue.source_type !== "caption") return false;
  if (!issue.artboard_id) return isCaptionLocked(artboards);
  return isLocked(artboards.find((ab) => ab.id === issue.artboard_id));
}

function captionArtboard(): Artboard {
  return {
    id: CAPTION_ARTBOARD_ID,
    platform: "workspace",
    format: "caption",
    kind: "caption",
    label: "Caption Input 1",
    width: 1080,
    height: 720,
    x: 80,
    y: 100,
    layers: [],
  };
}

function captionVariantArtboard(
  artboards: Artboard[],
  x: number,
  y: number
): Artboard {
  const count = artboards.filter((a) => artboardKind(a) === "caption").length;
  return {
    ...captionArtboard(),
    id: `artboard_caption_${Date.now().toString(36)}`,
    label: `Caption Input ${count + 1}`,
    x,
    y,
    text: "",
  };
}

function normalizeArtboards(artboards: Artboard[]): { artboards: Artboard[]; changed: boolean } {
  let changed = false;
  const normalized = artboards.map((ab) => {
    const kind = artboardKind(ab);
    let next: Artboard = ab.kind === kind ? ab : { ...ab, kind };
    if (next !== ab) changed = true;
    if (kind === "visual") {
      const layoutId = getPostLayout(next.layout_id, next.platform).id;
      const layers = fitLayersToLayout({ ...next, layout_id: layoutId });
      const layoutChanged = next.layout_id !== layoutId;
      const layersChanged = JSON.stringify(next.layers) !== JSON.stringify(layers);
      if (layoutChanged || layersChanged) {
        next = { ...next, layout_id: layoutId, layers };
        changed = true;
      }
    }
    return next;
  });
  let captionIndex = 0;
  const relabeled = normalized.map((ab) => {
    if (artboardKind(ab) !== "caption") return ab;
    captionIndex += 1;
    const fallback = `Caption Input ${captionIndex}`;
    if (!ab.label || ab.label === "Caption" || /^Caption \d+$/i.test(ab.label)) {
      changed = true;
      return { ...ab, label: fallback };
    }
    return ab;
  });
  const hasCaption = relabeled.some((ab) => artboardKind(ab) === "caption");
  if (!hasCaption) {
    changed = true;
    return { artboards: [captionArtboard(), ...relabeled], changed };
  }
  return { artboards: relabeled, changed };
}

interface QAState {
  loaded: boolean;
  appMode: AppMode;
  projects: ProjectSummary[];
  activeProjectId: string | null;
  workspaceName: string;
  imageCheckLabel: string;
  captionText: string;
  assets: Asset[];
  artboards: Artboard[];
  issues: Issue[];
  brandKit: BrandKit | null;
  guidelineFiles: GuidelineUploadFile[];
  llmConfigured: boolean;
  modelConfig: AgentModelConfig | null;
  agentTrace: AgentRunTrace | null;

  // ui state
  activeTab: QATab;
  selectedIssueId: string | null;
  editorMode: "edit" | "review";
  qaRunning: boolean;
  qaRunningTargets: Record<string, boolean>;
  analyzing: boolean;
  deepQaRunning: boolean;
  deepQaRunningTargets: Record<string, boolean>;
  cardScanStatus: Record<string, CardScanStatus>;

  load: (options?: { preferDefaultChecker?: boolean }) => Promise<void>;
  resetSpace: () => Promise<void>;
  setCaption: (text: string) => void;
  analyzeCaption: (useLLM: boolean) => Promise<void>;
  uploadFiles: (files: FileList | File[]) => Promise<void>;
  uploadFilesToArtboardSlot: (files: FileList | File[], artboardId: string, slotId?: string) => Promise<void>;
  removeAsset: (assetId: string) => void;
  runOcr: (assetId: string) => Promise<void>;
  runQA: (mode?: boolean | "smart", targetArtboardId?: string) => Promise<void>;
  acceptIssue: (issueId: string) => void;
  checkIssue: (issueId: string) => void;
  ignoreIssue: (issueId: string) => void;
  addToDictionary: (issueId: string) => Promise<void>;
  addGuideline: (input: GuidelineInput) => Promise<boolean>;
  uploadGuidelineFile: (file: File) => Promise<{ ok: boolean; message: string }>;
  applyAllDefinite: () => void;
  addArtboard: (preset: ArtboardPreset, position?: { x: number; y: number }) => void;
  ensureCaptionArtboardAt: (x: number, y: number) => void;
  toggleArtboardLock: (artboardId: string) => void;
  removeArtboard: (artboardId: string) => void;
  moveArtboard: (artboardId: string, x: number, y: number) => void;
  resizeArtboard: (artboardId: string, width: number, height: number) => void;
  updateArtboardLabel: (artboardId: string, label: string) => void;
  updateArtboardText: (artboardId: string, text: string) => void;
  updateImageCheckLabel: (label: string) => void;
  setArtboardLayout: (artboardId: string, layoutId: string) => void;
  dropAssetOnArtboard: (artboardId: string, assetId: string, slotId?: string) => void;
  setLayerFit: (artboardId: string, layerId: string, fit: "cover" | "contain") => void;
  selectIssue: (issueId: string | null) => void;
  setTab: (tab: QATab) => void;
  setEditorMode: (mode: "edit" | "review") => void;
  setAppMode: (mode: AppMode) => void;
  createCheck: () => Promise<void>;
  createProject: (name?: string) => Promise<void>;
  switchProject: (projectId: string, mode?: AppMode) => Promise<void>;
  renameProject: (projectId: string, name: string) => Promise<void>;
  deleteProject: (projectId: string) => Promise<void>;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let analyzeTimer: ReturnType<typeof setTimeout> | null = null;
let createCheckInFlight: Promise<void> | null = null;
const deepQaInFlightByTarget = new Map<string, Promise<void>>();
const cardRunCache = new Map<string, {
  issues: Issue[];
  assets: Asset[];
  agentTrace: AgentRunTrace | null;
  finalIssueCount: number;
  cachedAt: string;
}>();

function stableClientHash(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function brandKitSignature(brandKit: BrandKit | null) {
  if (!brandKit) return "no-brand-kit";
  return stableClientHash({
    brand_terms: brandKit.brand_terms,
    protected_terms: brandKit.protected_terms,
    preferred_spellings: brandKit.preferred_spellings,
    product_terms: brandKit.product_terms,
    preferred_wording: brandKit.preferred_wording,
    do_not_change: brandKit.do_not_change,
    style_notes: brandKit.style_notes,
  });
}

function runCacheKey(s: QAState, targetKey: string, contentSnapshot: string, mode: boolean | "smart") {
  return [
    "run-cache-v2",
    s.activeProjectId ?? "draft",
    targetKey,
    mode === "smart" ? "smart" : mode === true ? "visual" : "fast",
    s.llmConfigured ? "ai" : "rules",
    brandKitSignature(s.brandKit),
    stableClientHash(contentSnapshot),
  ].join("|");
}

function issueDecisionKey(issue: Issue) {
  return `${issue.source_type}|${issue.source_id}|${issue.artboard_id ?? ""}|${issue.box_id ?? ""}|${issue.original}|${issue.suggestion}`;
}

function preserveCurrentDecisions(cachedIssues: Issue[], currentIssues: Issue[]): Issue[] {
  const decisions = new Map(
    currentIssues
      .filter((issue) => issue.status === "accepted" || issue.status === "ignored" || issue.status === "resolved")
      .map((issue) => [issueDecisionKey(issue), issue.status])
  );
  if (decisions.size === 0) return cachedIssues;
  return cachedIssues.map((issue) => {
    const status = decisions.get(issueDecisionKey(issue));
    return status ? { ...issue, status } : issue;
  });
}

function runTargetKey(targetArtboardId?: string) {
  return targetArtboardId?.trim() || "__workspace__";
}

function isPrimaryCaptionIssue(issue: Issue) {
  return issue.source_type === "caption" &&
    (
      issue.artboard_id === null ||
      issue.artboard_id === CAPTION_ARTBOARD_ID ||
      issue.source_id.startsWith("caption_")
    );
}

function issueBelongsToRunTarget(issue: Issue, targetKey: string) {
  if (targetKey === "__workspace__") return issue.source_type === "image";
  if (targetKey === CAPTION_ARTBOARD_ID) return isPrimaryCaptionIssue(issue);
  return issue.artboard_id === targetKey || issue.source_id === targetKey;
}

function openIssueCountForTarget(issues: Issue[], targetKey: string) {
  return issues.filter((issue) => issue.status === "open" && issueBelongsToRunTarget(issue, targetKey)).length;
}

function manualReviewIssueCountForTarget(issues: Issue[], targetKey: string) {
  return issues.filter((issue) =>
    (issue.status === "open" || issue.status === "needs_human_review") &&
    issueBelongsToRunTarget(issue, targetKey) &&
    (
      issue.severity === "needs_review" ||
      issue.type === "ocr_low_confidence" ||
      issue.status === "needs_human_review"
    )
  ).length;
}

function assetIdsForRunTarget(targetKey: string, artboards: Artboard[]) {
  if (targetKey === "__workspace__") return null;
  const artboard = artboards.find((item) => item.id === targetKey);
  if (!artboard || artboardKind(artboard) !== "visual") return null;
  return new Set(artboard.layers.map((layer) => layer.asset_id));
}

function coverageForRun(targetKey: string, issues: Issue[], assets: Asset[], artboards: Artboard[], deepRunning = false): CoverageStatus {
  if (deepRunning) return "still_checking";
  const scopedAssetIds = assetIdsForRunTarget(targetKey, artboards);
  const scopedAssets = scopedAssetIds
    ? assets.filter((asset) => scopedAssetIds.has(asset.id))
    : targetKey === "__workspace__"
      ? assets
      : [];
  if (scopedAssets.some((asset) => asset.ocr_status === "failed")) {
    return "could_not_fully_read";
  }
  if (scopedAssets.some((asset) => asset.ocr_status === "low_confidence" || asset.ocr_boxes.length === 0)) {
    return "needs_review";
  }
  return manualReviewIssueCountForTarget(issues, targetKey) > 0 ? "needs_review" : "checked";
}

function targetFingerprint(s: QAState, targetArtboardId?: string) {
  const targetKey = runTargetKey(targetArtboardId);
  if (targetKey === "__workspace__") {
    return JSON.stringify(
      s.assets
        .map((asset) => [asset.id, asset.hash, asset.url])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    );
  }
  if (targetKey === CAPTION_ARTBOARD_ID) return `caption:${s.captionText}`;
  const artboard = s.artboards.find((item) => item.id === targetKey);
  if (!artboard) return `missing:${targetKey}`;
  if (artboardKind(artboard) === "caption") return `caption:${targetKey}:${artboard.text ?? ""}`;
  return JSON.stringify({
    id: artboard.id,
    kind: artboardKind(artboard),
    layout_id: artboard.layout_id,
    width: artboard.width,
    height: artboard.height,
    layers: artboard.layers.map((layer) => ({
      asset_id: layer.asset_id,
      slot_id: layer.slot_id,
      fit_mode: layer.fit_mode,
    })),
  });
}

function setScanStatus(
  update: (partial: Partial<QAState> | ((state: QAState) => Partial<QAState>)) => void,
  key: string,
  status: Omit<CardScanStatus, "updatedAt">
) {
  update((state) => ({
    cardScanStatus: {
      ...state.cardScanStatus,
      [key]: { ...status, updatedAt: new Date().toISOString() },
    },
  }));
}

function markTargetNeedsRerun(
  update: (partial: Partial<QAState> | ((state: QAState) => Partial<QAState>)) => void,
  key: string
) {
  update((state) => {
    const current = state.cardScanStatus[key];
    if (!current || current.phase === "fast_running" || current.phase === "deep_running") return {};
    return {
      cardScanStatus: {
        ...state.cardScanStatus,
        [key]: {
          phase: "needs_rerun",
          message: "Nội dung đã thay đổi. Bấm Run để kiểm tra lại.",
          detail: "Kết quả cũ có thể không còn khớp với nội dung hiện tại.",
          updatedAt: new Date().toISOString(),
        },
      },
    };
  });
}

async function postRunQaWithRetry(body: unknown, attempts = 2) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await apiFetch("/api/workspace/run-qa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Run QA failed");
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 650));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Run QA failed");
}

async function startDeepScanJob(body: unknown) {
  const res = await apiFetch("/api/workspace/deep-scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Deep scan failed");
  return data.job as {
    job_id: string;
    status: "queued" | "running" | "completed" | "failed";
    phase: string;
    error?: string;
    checkpoints?: { phase: string; status: string; detail?: string; count?: number }[];
    issues?: Issue[];
    assets?: Asset[];
    agent_trace?: AgentRunTrace | null;
  };
}

async function pollDeepScanJob(
  jobId: string,
  onUpdate: (job: Awaited<ReturnType<typeof startDeepScanJob>>) => void
) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const res = await apiFetch(`/api/workspace/deep-scan?job_id=${encodeURIComponent(jobId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Deep scan failed");
    const job = data.job as Awaited<ReturnType<typeof startDeepScanJob>>;
    onUpdate(job);
    if (job.status === "completed") return job;
    if (job.status === "failed") throw new Error(job.error || "Deep scan failed");
  }
  throw new Error("Deep scan timeout");
}

async function commitDeepScanJob(jobId: string) {
  const res = await apiFetch("/api/workspace/deep-scan/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId }),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(typeof data.message === "string" ? data.message : typeof data.error === "string" ? data.error : "Deep scan commit failed");
    (err as Error & { stale?: boolean }).stale = data.stale === true || data.error === "stale_content";
    throw err;
  }
  return data as {
    workspace: Workspace;
    issues: Issue[];
    assets: Asset[];
    agent_trace?: AgentRunTrace | null;
    stale?: boolean;
  };
}

function deepScanFriendlyMessage(job: Awaited<ReturnType<typeof startDeepScanJob>>) {
  const active = [...(job.checkpoints ?? [])].reverse().find((item) =>
    item.status === "running" || item.status === "completed" || item.status === "failed"
  );
  if (!active) return "Deep scan đang chuẩn bị...";
  if (active.phase === "ocr") return "Đang đọc chữ trên ảnh...";
  if (active.phase === "caption_ai") return "Đang rà kỹ caption...";
  if (active.phase === "image_ai") return "Đang rà kỹ chữ trên ảnh...";
  if (active.phase === "self_check") return "Đang tự kiểm tra lại kết quả...";
  if (active.phase === "merge") return "Đang cập nhật kết quả...";
  return active.detail || "Deep scan đang chạy...";
}

function hasAnyRunning(values: Record<string, boolean>) {
  return Object.values(values).some(Boolean);
}

function setTargetRunning(
  update: (partial: Partial<QAState> | ((state: QAState) => Partial<QAState>)) => void,
  field: "qaRunningTargets" | "deepQaRunningTargets",
  key: string,
  running: boolean
) {
  update((state) => {
    const next = { ...state[field] };
    if (running) next[key] = true;
    else delete next[key];
    return field === "qaRunningTargets"
      ? { qaRunningTargets: next, qaRunning: hasAnyRunning(next) }
      : { deepQaRunningTargets: next, deepQaRunning: hasAnyRunning(next) };
  });
}

function hasPersistableDraftCheck(s: QAState) {
  if (s.appMode !== "check" || s.activeProjectId) return false;
  if (s.captionText.trim()) return true;
  if (s.assets.length > 0) return true;
  return s.artboards.some((ab) =>
    (artboardKind(ab) === "caption" || artboardKind(ab) === "note") &&
    !isPrimaryCaptionArtboard(ab) &&
    Boolean((ab.text ?? "").trim())
  );
}

function workspacePersistBody(s: QAState) {
  return {
    project_id: s.activeProjectId,
    caption: { text: s.captionText },
    image_check_label: s.imageCheckLabel,
    assets: s.assets,
    artboards: s.artboards,
    issues: s.issues,
    last_agent_trace: s.agentTrace,
  };
}

function schedulePersist(
  setState: (partial: Partial<QAState> | ((state: QAState) => Partial<QAState>)) => void,
  get: () => QAState
) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    (async () => {
      let s = get();
      if (!s.loaded) return;
      if (!s.activeProjectId) {
        if (!hasPersistableDraftCheck(s)) return;
        await ensureActiveCheckProject(setState, get);
      }
      return apiFetch("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(workspacePersistBody(get())),
      });
    })().catch(() => {});
  }, 600);
}

async function flushPersist(
  setState: (partial: Partial<QAState> | ((state: QAState) => Partial<QAState>)) => void,
  get: () => QAState
) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  let s = get();
  if (!s.loaded) return;
  if (!s.activeProjectId) {
    if (!hasPersistableDraftCheck(s)) return;
    await ensureActiveCheckProject(setState, get);
  }
  await apiFetch("/api/workspace", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(workspacePersistBody(get())),
  }).catch(() => {});
}

async function ensureActiveCheckProject(
  setState: (partial: Partial<QAState> | ((state: QAState) => Partial<QAState>)) => void,
  get: () => QAState
): Promise<QAState> {
  let s = get();
  if (s.activeProjectId) return s;

  createCheckInFlight ??= (async () => {
    const createRes = await apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", kind: "check", name: checkName() }),
    });
    if (!createRes.ok) throw new Error("Create check failed");
    const created = await createRes.json();
    setState({
      activeProjectId: typeof created.active_project_id === "string" ? created.active_project_id : null,
      projects: Array.isArray(created.projects) ? created.projects : get().projects,
      workspaceName: typeof created.workspace?.name === "string" ? created.workspace.name : "Check",
      appMode: "check",
    });
  })().finally(() => {
    createCheckInFlight = null;
  });

  await createCheckInFlight;
  return get();
}

async function uploadImageFiles(
  files: FileList | File[],
  setState: (partial: Partial<QAState> | ((state: QAState) => Partial<QAState>)) => void,
  get: () => QAState
): Promise<Asset[]> {
  const imageFiles = Array.from(files).filter((file) =>
    file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(file.name)
  );
  if (imageFiles.length === 0) throw new Error("No supported image files.");
  const validationError = validateImageUploadFiles(imageFiles);
  if (validationError) throw new Error(validationError);

  const s = await ensureActiveCheckProject(setState, get);
  await apiFetch("/api/workspace", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(workspacePersistBody(s)),
  });

  const form = new FormData();
  if (s.activeProjectId) form.append("project_id", s.activeProjectId);
  for (const file of imageFiles) form.append("files", file);
  const res = await apiFetch("/api/assets/upload", { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Upload failed");

  const uploadedAssets = (data.assets ?? []) as Asset[];
  setState({ assets: data.workspace.assets });
  markTargetNeedsRerun(setState, "__workspace__");
  for (const asset of uploadedAssets) {
    if (asset.ocr_status === "pending" || asset.ocr_status === "failed" || asset.ocr_boxes.length === 0) {
      void get().runOcr(asset.id);
    }
  }
  return uploadedAssets;
}

function checkName() {
  const stamp = new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
  return `Check ${stamp}`;
}

export const useQAStore = create<QAState>((set, get) => ({
  loaded: false,
  appMode: "check",
  projects: [],
  activeProjectId: null,
  workspaceName: "Workspace",
  imageCheckLabel: DEFAULT_IMAGE_CHECK_LABEL,
  captionText: "",
  assets: [],
  artboards: [],
  issues: [],
  brandKit: null,
  guidelineFiles: [],
  llmConfigured: false,
  modelConfig: null,
  agentTrace: null,
  activeTab: "issues",
  selectedIssueId: null,
  editorMode: "edit",
  qaRunning: false,
  qaRunningTargets: {},
  analyzing: false,
  deepQaRunning: false,
  deepQaRunningTargets: {},
  cardScanStatus: {},

  load: async (options) => {
    const projectsRes = await apiFetch("/api/projects");
    const projectsData = await projectsRes.json().catch(() => ({ projects: [], active_project_id: null }));
    let projects: ProjectSummary[] = Array.isArray(projectsData.projects) ? projectsData.projects : [];
    let activeProjectId = typeof projectsData.active_project_id === "string" ? projectsData.active_project_id : null;

    if (options?.preferDefaultChecker) {
      const activeProject = projects.find((project) => project.id === activeProjectId);
      if (activeProject?.kind !== "check") {
        const latestCheck = projects
          .filter((project) => project.kind === "check")
          .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
        const defaultCheckRes = latestCheck
          ? await apiFetch("/api/projects", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "switch", project_id: latestCheck.id }),
            })
          : await apiFetch("/api/projects", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "create", kind: "check", name: checkName() }),
            });
        if (defaultCheckRes.ok) {
          const defaultCheckData = await defaultCheckRes.json().catch(() => null);
          projects = Array.isArray(defaultCheckData?.projects) ? defaultCheckData.projects : projects;
          activeProjectId = typeof defaultCheckData?.active_project_id === "string" ? defaultCheckData.active_project_id : activeProjectId;
        }
      }
    }

    const workspaceUrl = activeProjectId ? `/api/workspace?project_id=${encodeURIComponent(activeProjectId)}` : "/api/workspace";
    const res = await apiFetch(workspaceUrl);
    const data = await res.json();
    const ws: Workspace = data.workspace;
    const normalized = normalizeArtboards(ws.artboards);
    set({
      loaded: true,
      appMode: ws.kind === "check" ? "check" : "project",
      projects,
      activeProjectId,
      workspaceName: ws.name,
      imageCheckLabel: normalizeImageCheckLabel(ws.image_check_label),
      captionText: ws.caption.text,
      assets: ws.assets,
      artboards: normalized.artboards,
      issues: ws.issues,
      brandKit: data.brand_kit,
      guidelineFiles: Array.isArray(data.guideline_files) ? data.guideline_files : [],
      llmConfigured: data.llm_configured,
      modelConfig: data.model_config ?? null,
      agentTrace: data.agent_trace ?? ws.last_agent_trace ?? null,
      editorMode: ws.issues.some((i) => i.source_type === "caption" && i.status === "open") ? "review" : "edit",
      qaRunning: false,
      qaRunningTargets: {},
      deepQaRunning: false,
      deepQaRunningTargets: {},
      cardScanStatus: {},
    });
    if (normalized.changed) schedulePersist(set, get);
  },

  resetSpace: async () => {
    if (persistTimer) clearTimeout(persistTimer);
    if (analyzeTimer) clearTimeout(analyzeTimer);
    persistTimer = null;
    analyzeTimer = null;
    createCheckInFlight = null;
    deepQaInFlightByTarget.clear();
    cardRunCache.clear();

    const artboards = [captionArtboard()];
    if (!get().activeProjectId) {
      set({
        captionText: "",
        imageCheckLabel: DEFAULT_IMAGE_CHECK_LABEL,
        assets: [],
        artboards,
        issues: [],
        agentTrace: null,
        selectedIssueId: null,
        editorMode: "edit",
        activeTab: "issues",
        qaRunning: false,
        qaRunningTargets: {},
        analyzing: false,
        deepQaRunning: false,
        deepQaRunningTargets: {},
        cardScanStatus: {},
      });
      return;
    }
    const res = await apiFetch("/api/workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: get().activeProjectId,
        caption: { text: "" },
        image_check_label: DEFAULT_IMAGE_CHECK_LABEL,
        assets: [],
        artboards,
        issues: [],
        last_agent_trace: null,
      }),
    });
    if (!res.ok) throw new Error("Reset workspace failed");

    set({
      captionText: "",
      imageCheckLabel: DEFAULT_IMAGE_CHECK_LABEL,
      assets: [],
      artboards,
      issues: [],
      agentTrace: null,
      selectedIssueId: null,
      editorMode: "edit",
      activeTab: "issues",
      qaRunning: false,
      qaRunningTargets: {},
      analyzing: false,
      deepQaRunning: false,
      deepQaRunningTargets: {},
      cardScanStatus: {},
    });
  },

  createCheck: async () => {
    await flushPersist(set, get);
    if (analyzeTimer) clearTimeout(analyzeTimer);
    analyzeTimer = null;
    createCheckInFlight = null;
    deepQaInFlightByTarget.clear();
    cardRunCache.clear();
    const res = await apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", kind: "check", name: checkName() }),
    });
    if (!res.ok) throw new Error("Create check failed");
    set({ loaded: false, appMode: "check", activeTab: "issues", qaRunning: false, qaRunningTargets: {}, deepQaRunning: false, deepQaRunningTargets: {}, cardScanStatus: {} });
    await get().load();
  },

  createProject: async (name) => {
    await flushPersist(set, get);
    if (analyzeTimer) clearTimeout(analyzeTimer);
    analyzeTimer = null;
    createCheckInFlight = null;
    deepQaInFlightByTarget.clear();
    cardRunCache.clear();
    const res = await apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", kind: "project", name: name?.trim() || "Untitled Project" }),
    });
    if (!res.ok) throw new Error("Create project failed");
    set({ loaded: false, appMode: "project", qaRunning: false, qaRunningTargets: {}, deepQaRunning: false, deepQaRunningTargets: {}, cardScanStatus: {} });
    await get().load();
  },

  switchProject: async (projectId, mode = "project") => {
    if (!projectId || projectId === get().activeProjectId) {
      const currentKind = get().projects.find((project) => project.id === projectId)?.kind;
      set({ appMode: currentKind === "check" ? "check" : mode });
      return;
    }
    await flushPersist(set, get);
    if (analyzeTimer) clearTimeout(analyzeTimer);
    analyzeTimer = null;
    createCheckInFlight = null;
    deepQaInFlightByTarget.clear();
    cardRunCache.clear();
    const res = await apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "switch", project_id: projectId }),
    });
    if (!res.ok) throw new Error("Switch project failed");
    set({ loaded: false, appMode: mode, activeTab: "issues", qaRunning: false, qaRunningTargets: {}, deepQaRunning: false, deepQaRunningTargets: {}, cardScanStatus: {} });
    await get().load();
  },

  renameProject: async (projectId, name) => {
    const clean = name.trim();
    if (!projectId || !clean) return;
    await flushPersist(set, get);
    const res = await apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "rename", project_id: projectId, name: clean }),
    });
    if (!res.ok) throw new Error("Rename project failed");
    const data = await res.json().catch(() => ({}));
    set((s) => ({
      projects: Array.isArray(data.projects)
        ? data.projects
        : s.projects.map((project) => (project.id === projectId ? { ...project, name: clean } : project)),
      workspaceName: projectId === s.activeProjectId ? clean : s.workspaceName,
    }));
  },

  deleteProject: async (projectId) => {
    if (!projectId) return;
    const wasActive = projectId === get().activeProjectId;
    if (wasActive) {
      if (persistTimer) clearTimeout(persistTimer);
      if (analyzeTimer) clearTimeout(analyzeTimer);
      persistTimer = null;
      analyzeTimer = null;
      createCheckInFlight = null;
      deepQaInFlightByTarget.clear();
      cardRunCache.clear();
    } else {
      await flushPersist(set, get);
    }
    const res = await apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", project_id: projectId }),
    });
    if (!res.ok) throw new Error("Delete project failed");
    const data = await res.json().catch(() => ({}));
    set({
      projects: Array.isArray(data.projects) ? data.projects : get().projects.filter((project) => project.id !== projectId),
      activeProjectId: typeof data.active_project_id === "string" ? data.active_project_id : get().activeProjectId,
      qaRunning: false,
      qaRunningTargets: {},
      deepQaRunning: false,
      deepQaRunningTargets: {},
      cardScanStatus: {},
    });
    if (wasActive) {
      set({ loaded: false, activeTab: "issues" });
      await get().load();
    }
  },

  setCaption: (text) => {
    if (isCaptionLocked(get().artboards)) return;
    // editing invalidates caption issue ranges → drop open caption issues, keep decisions
    set((s) => ({
      captionText: text,
      issues: s.issues.filter((i) => i.source_type !== "caption" || i.artboard_id !== null || i.status === "ignored"),
    }));
    markTargetNeedsRerun(set, CAPTION_ARTBOARD_ID);
    schedulePersist(set, get);
    if (analyzeTimer) clearTimeout(analyzeTimer);
    analyzeTimer = setTimeout(() => get().analyzeCaption(false), 800);
  },

  analyzeCaption: async (useLLM) => {
    const { captionText, issues } = get();
    if (!captionText.trim()) return;
    set({ analyzing: true });
    try {
      const res = await apiFetch("/api/caption/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: captionText, use_llm: useLLM, verify: useLLM }),
      });
      const data = await res.json();
      if (get().captionText !== captionText) return; // stale response
      const ignoredKeys = new Set(
        issues
          .filter((i) => i.source_type === "caption" && i.artboard_id === null && i.status === "ignored")
          .map((i) => `${i.original}|${i.suggestion}`)
      );
      const fresh: Issue[] = (data.issues as Issue[]).map((i) =>
        ignoredKeys.has(`${i.original}|${i.suggestion}`) ? { ...i, status: "ignored" as const } : i
      );
      set((s) => ({
        issues: [...s.issues.filter((i) => i.source_type !== "caption" || i.artboard_id !== null), ...fresh],
      }));
      schedulePersist(set, get);
    } finally {
      set({ analyzing: false });
    }
  },

  uploadFiles: async (files) => {
    await uploadImageFiles(files, set, get);
  },

  uploadFilesToArtboardSlot: async (files, artboardId, slotId) => {
    const uploadedAssets = await uploadImageFiles(files, set, get);
    if (uploadedAssets.length === 0) return;

    const artboard = get().artboards.find((ab) => ab.id === artboardId);
    if (!artboard || isLocked(artboard) || artboardKind(artboard) !== "visual") return;

    const layoutId = getPostLayout(artboard.layout_id, artboard.platform).id;
    const slots = getLayoutSlotsFor(layoutId, artboard.platform, artboard.width, artboard.height);
    const firstOpenSlot = firstOpenSlotId({ ...artboard, layout_id: layoutId });
    const requestedIndex = slotId ? slots.findIndex((slot) => slot.id === slotId) : -1;
    const fallbackIndex = firstOpenSlot ? slots.findIndex((slot) => slot.id === firstOpenSlot) : 0;
    const startIndex = requestedIndex >= 0 ? requestedIndex : Math.max(0, fallbackIndex);

    uploadedAssets.forEach((asset, index) => {
      const targetSlot = slots[(startIndex + index) % Math.max(1, slots.length)];
      get().dropAssetOnArtboard(artboardId, asset.id, targetSlot?.id ?? slotId);
    });
  },

  runOcr: async (assetId) => {
    const projectId = get().activeProjectId;
    set((s) => ({
      assets: s.assets.map((a) => (a.id === assetId ? { ...a, ocr_status: "processing" } : a)),
    }));
    try {
      const res = await apiFetch(`/api/assets/${assetId}/ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId }),
      });
      const data = await res.json();
      if (get().activeProjectId !== projectId) return;
      if (data.asset) {
        set((s) => ({ assets: s.assets.map((a) => (a.id === assetId ? data.asset : a)) }));
      }
    } catch {
      set((s) => ({
        assets: s.assets.map((a) => (a.id === assetId ? { ...a, ocr_status: "failed" } : a)),
      }));
    }
  },

  removeAsset: (assetId) => {
    set((s) => {
      if (!s.assets.some((asset) => asset.id === assetId)) return {};
      const removedIssueIds = new Set(
        s.issues
          .filter((issue) => issue.source_type === "image" && issue.source_id === assetId)
          .map((issue) => issue.issue_id)
      );
      const remainingAssets = s.assets.filter((asset) => asset.id !== assetId);
      const nextCardScanStatus = { ...s.cardScanStatus };
      const currentWorkspaceStatus = nextCardScanStatus.__workspace__;

      if (remainingAssets.length === 0) {
        nextCardScanStatus.__workspace__ = {
          phase: "complete",
          message: "Chưa có ảnh để kiểm tra.",
          detail: "Upload Images để Typolice đọc chữ trên ảnh.",
          updatedAt: new Date().toISOString(),
          fastIssueCount: 0,
          finalIssueCount: 0,
        };
      } else if (!currentWorkspaceStatus || (currentWorkspaceStatus.phase !== "fast_running" && currentWorkspaceStatus.phase !== "deep_running")) {
        nextCardScanStatus.__workspace__ = {
          phase: "needs_rerun",
          message: "Danh sách ảnh đã thay đổi. Bấm Run để kiểm tra lại.",
          detail: "Typolice đã xoá lỗi của ảnh vừa gỡ khỏi lần check hiện tại.",
          updatedAt: new Date().toISOString(),
        };
      }

      return {
        assets: remainingAssets,
        artboards: s.artboards.map((artboard) => ({
          ...artboard,
          layers: artboard.layers.filter((layer) => layer.asset_id !== assetId),
        })),
        issues: s.issues.filter((issue) => !(issue.source_type === "image" && issue.source_id === assetId)),
        selectedIssueId: s.selectedIssueId && removedIssueIds.has(s.selectedIssueId) ? null : s.selectedIssueId,
        agentTrace: null,
        cardScanStatus: nextCardScanStatus,
      };
    });
    schedulePersist(set, get);
  },

  runQA: async (mode = false, targetArtboardId) => {
    const smartRun = mode === "smart";
    const visualQa = mode === true;
    const targetKey = runTargetKey(targetArtboardId);
    if (get().qaRunningTargets[targetKey]) return;
    setTargetRunning(set, "qaRunningTargets", targetKey, true);
    setScanStatus(set, targetKey, {
      phase: "fast_running",
      message: "Fast check in progress...",
      detail: "Typolice will show the first results quickly, then continue scanning in the background.",
      coverage: "still_checking",
    });
    set({ activeTab: "issues" });
    try {
      // persist current state first so the server QA sees latest caption/artboards
      const s = await ensureActiveCheckProject(set, get);
      const runProjectId = s.activeProjectId;
      const contentSnapshot = targetFingerprint(s, targetArtboardId);
      const cacheKey = runCacheKey(s, targetKey, contentSnapshot, mode);
      const cached = cardRunCache.get(cacheKey);
      if (cached) {
        const current = get();
        const issues = preserveCurrentDecisions(cached.issues, current.issues);
        const finalIssueCount = openIssueCountForTarget(issues, targetKey);
        set({
          issues,
          assets: cached.assets,
          agentTrace: cached.agentTrace,
          editorMode: "review",
          activeTab: "issues",
        });
        setScanStatus(set, targetKey, {
          phase: "complete",
          message: "Checked",
          detail: `Reused the latest result for this unchanged card. Cached at ${new Date(cached.cachedAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}.`,
          fastIssueCount: finalIssueCount,
          finalIssueCount,
          coverage: coverageForRun(targetKey, issues, cached.assets, current.artboards),
        });
        return;
      }
      await apiFetch("/api/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(workspacePersistBody(s)),
      });
      const data = await postRunQaWithRetry({ project_id: runProjectId, visual_qa: visualQa, target_artboard_id: targetArtboardId });
      const fastIssueCount = openIssueCountForTarget(data.workspace.issues, targetKey);
      if (get().activeProjectId !== runProjectId) return;
      set({
        issues: data.workspace.issues,
        assets: data.workspace.assets,
        agentTrace: data.agent_trace ?? null,
        editorMode: "review",
        activeTab: "issues",
      });
      setScanStatus(set, targetKey, smartRun && get().llmConfigured
        ? {
            phase: "deep_running",
            message: "Fast check preview loaded. Deep scan in progress...",
            detail: "Additional issues may be found. Typolice will add them to this card automatically.",
            fastIssueCount,
            coverage: "still_checking",
          }
        : {
            phase: "complete",
            message: "Checked",
            detail: fastIssueCount > 0 ? `Tìm thấy ${fastIssueCount} lỗi đang mở.` : "Chưa thấy lỗi đang mở.",
            fastIssueCount,
            finalIssueCount: fastIssueCount,
            coverage: coverageForRun(targetKey, data.workspace.issues, data.workspace.assets, data.workspace.artboards ?? get().artboards),
          }
      );
      if (!(smartRun && get().llmConfigured)) {
        cardRunCache.set(cacheKey, {
          issues: data.workspace.issues,
          assets: data.workspace.assets,
          agentTrace: data.agent_trace ?? null,
          finalIssueCount: fastIssueCount,
          cachedAt: new Date().toISOString(),
        });
      }

      if (smartRun && get().llmConfigured && !deepQaInFlightByTarget.has(targetKey)) {
        setTargetRunning(set, "deepQaRunningTargets", targetKey, true);
        const deepRun = (async () => {
          try {
            const latest = get();
            if (latest.activeProjectId === runProjectId) {
              await apiFetch("/api/workspace", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(workspacePersistBody(latest)),
              });
            }
            const job = await startDeepScanJob({
              project_id: runProjectId,
              content_fingerprint: contentSnapshot,
              target_artboard_id: targetArtboardId,
            });
            await pollDeepScanJob(job.job_id, (nextJob) => {
              const current = get();
              if (current.activeProjectId !== runProjectId) return;
              if (targetFingerprint(current, targetArtboardId) !== contentSnapshot) return;
              setScanStatus(set, targetKey, {
                phase: "deep_running",
                message: deepScanFriendlyMessage(nextJob),
                detail: nextJob.checkpoints?.map((item) => `${item.phase}: ${item.status}`).join(" · "),
                fastIssueCount,
                coverage: "still_checking",
              });
            });
            const current = get();
            if (current.activeProjectId !== runProjectId) return;
            if (targetFingerprint(current, targetArtboardId) !== contentSnapshot) {
              setScanStatus(set, targetKey, {
                phase: "needs_rerun",
                message: "Nội dung đã thay đổi. Bấm Run để kiểm tra lại.",
                detail: "Typolice đã giữ kết quả nhanh trước đó, nhưng bản rà kỹ thuộc nội dung cũ nên không tự áp dụng.",
                fastIssueCount,
                coverage: coverageForRun(targetKey, current.issues, current.assets, current.artboards),
              });
              return;
            }
            const committed = await commitDeepScanJob(job.job_id);
            const finalIssues = committed.issues ?? current.issues;
            const finalAssets = committed.assets ?? current.assets;
            const finalIssueCount = openIssueCountForTarget(finalIssues, targetKey);
            set({
              issues: finalIssues,
              assets: finalAssets,
              agentTrace: committed.agent_trace ?? null,
              editorMode: "review",
            });
            cardRunCache.set(cacheKey, {
              issues: finalIssues,
              assets: finalAssets,
              agentTrace: committed.agent_trace ?? null,
              finalIssueCount,
              cachedAt: new Date().toISOString(),
            });
            setScanStatus(set, targetKey, {
              phase: "complete",
              message: "Checked",
              detail: finalIssueCount > fastIssueCount
                ? `Typolice vừa tìm thêm ${finalIssueCount - fastIssueCount} lỗi cần xem.`
                : "Không thấy thêm lỗi mới sau khi rà kỹ.",
              fastIssueCount,
              finalIssueCount,
              coverage: coverageForRun(targetKey, finalIssues, finalAssets, current.artboards),
            });
          } catch (err) {
            console.error("[runQA] background deep QA failed:", err);
            if ((err as Error & { stale?: boolean }).stale) {
              setScanStatus(set, targetKey, {
                phase: "needs_rerun",
                message: "Nội dung đã thay đổi. Bấm Run để kiểm tra lại.",
                detail: "Typolice không ghi kết quả rà kỹ cũ vào workspace.",
                fastIssueCount,
                coverage: coverageForRun(targetKey, get().issues, get().assets, get().artboards),
              });
              return;
            }
            setScanStatus(set, targetKey, {
              phase: "failed",
              message: "Chưa rà kỹ xong. Kết quả nhanh vẫn đang hiển thị.",
              detail: "Typolice đã tự thử lại một lần. Bạn có thể bấm Run lại sau nếu muốn rà kỹ thêm.",
              fastIssueCount,
              coverage: coverageForRun(targetKey, get().issues, get().assets, get().artboards),
            });
          } finally {
            deepQaInFlightByTarget.delete(targetKey);
            setTargetRunning(set, "deepQaRunningTargets", targetKey, false);
          }
        })();
        deepQaInFlightByTarget.set(targetKey, deepRun);
      }
    } catch (err) {
      setScanStatus(set, targetKey, {
        phase: "failed",
        message: "Chưa kiểm tra được. Hãy thử Run lại.",
        detail: "Typolice chưa nhận được kết quả cho lần chạy này.",
        coverage: coverageForRun(targetKey, get().issues, get().assets, get().artboards),
      });
      throw err;
    } finally {
      setTargetRunning(set, "qaRunningTargets", targetKey, false);
    }
  },

  acceptIssue: (issueId) => {
    const { issues, captionText, artboards } = get();
    const issue = issues.find((i) => i.issue_id === issueId);
    if (!issue) return;

    if (issue.source_type === "caption" && issue.range) {
      if (isIssueTargetLocked(issue, artboards)) return;
      const accepted = { ...issue, status: "accepted" as const };
      const targetText = issue.artboard_id
        ? artboards.find((ab) => ab.id === issue.artboard_id)?.text ?? ""
        : captionText;
      const { text } = applyPatches(targetText, [accepted], "accepted_only");
      const shifted = shiftRangesForTarget(
        issues.map((i) => (i.issue_id === issueId ? accepted : i)),
        accepted
      ).map((i) => (i.issue_id === issueId ? { ...i, status: "accepted" as const, range: null } : i));
      if (issue.artboard_id) {
        set({
          artboards: artboards.map((ab) => (ab.id === issue.artboard_id ? { ...ab, text } : ab)),
          issues: shifted,
        });
      } else {
        set({ captionText: text, issues: shifted });
      }
    } else {
      set({ issues: issues.map((i) => (i.issue_id === issueId ? { ...i, status: "accepted" } : i)) });
    }
    schedulePersist(set, get);
  },

  checkIssue: (issueId) => {
    set((s) => ({
      issues: s.issues.map((i) => (i.issue_id === issueId ? { ...i, status: "resolved" as const } : i)),
    }));
    schedulePersist(set, get);
  },

  ignoreIssue: (issueId) => {
    set((s) => ({
      issues: s.issues.map((i) => (i.issue_id === issueId ? { ...i, status: "ignored" } : i)),
    }));
    schedulePersist(set, get);
  },

  addToDictionary: async (issueId) => {
    const issue = get().issues.find((i) => i.issue_id === issueId);
    if (!issue) return;
    const res = await apiFetch("/api/brand-kit", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ add_term: issue.original, list: "do_not_change", project_id: get().activeProjectId }),
    });
    const data = await res.json();
    set((s) => ({
      brandKit: data.brand_kit,
      // remove this and identical false positives
      issues: s.issues.map((i) =>
        i.original === issue.original && i.suggestion === issue.suggestion
          ? { ...i, status: "ignored" as const }
          : i
      ),
    }));
    schedulePersist(set, get);
  },

  addGuideline: async (input) => {
    const res = await apiFetch("/api/brand-kit", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, project_id: get().activeProjectId }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    set({ brandKit: data.brand_kit });
    return true;
  },

  uploadGuidelineFile: async (file) => {
    const form = new FormData();
    if (get().activeProjectId) form.append("project_id", get().activeProjectId as string);
    form.append("file", file);
    const res = await apiFetch("/api/brand-kit", {
      method: "POST",
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, message: typeof data.error === "string" ? data.error : "Upload guideline failed." };
    }
    set({
      brandKit: data.brand_kit,
      guidelineFiles: Array.isArray(data.guideline_files) ? data.guideline_files : get().guidelineFiles,
    });
    return { ok: true, message: data.saved_as ? `Đã lưu ${data.saved_as}` : "Đã upload guideline." };
  },

  applyAllDefinite: () => {
    const { issues, captionText, artboards } = get();
    let nextCaptionText = captionText;
    let nextArtboards = artboards;
    let nextIssues = issues;
    const appliedIds = new Set<string>();

    if (!isCaptionLocked(artboards)) {
      const primaryIssues = nextIssues.filter((i) => i.source_type === "caption" && i.artboard_id === null);
      const { text, applied } = applyPatches(nextCaptionText, primaryIssues, "definite");
      nextCaptionText = text;
      for (const accepted of applied) {
        appliedIds.add(accepted.issue_id);
        nextIssues = shiftRangesForTarget(nextIssues, accepted);
      }
    }

    for (const artboard of artboards) {
      if (artboardKind(artboard) !== "caption" || isPrimaryCaptionArtboard(artboard) || isLocked(artboard)) continue;
      const targetIssues = nextIssues.filter((i) => i.source_type === "caption" && i.artboard_id === artboard.id);
      const { text, applied } = applyPatches(artboard.text ?? "", targetIssues, "definite");
      if (applied.length === 0) continue;
      nextArtboards = nextArtboards.map((ab) => (ab.id === artboard.id ? { ...ab, text } : ab));
      for (const accepted of applied) {
        appliedIds.add(accepted.issue_id);
        nextIssues = shiftRangesForTarget(nextIssues, accepted);
      }
    }

    nextIssues = nextIssues.map((i) =>
      appliedIds.has(i.issue_id) ? { ...i, status: "accepted" as const, range: null } : i
    );
    set({ captionText: nextCaptionText, artboards: nextArtboards, issues: nextIssues });
    schedulePersist(set, get);
  },

  addArtboard: (preset, position) => {
    const { artboards } = get();
    const maxX = artboards.reduce((m, a) => Math.max(m, a.x + a.width), 0);
    const count = artboards.filter((a) => a.format === preset.format && a.platform === preset.platform).length;
    const kind = preset.kind ?? "visual";
    const ab: Artboard = {
      id: `artboard_${Date.now().toString(36)}`,
      platform: preset.platform,
      format: preset.format,
      kind,
      label: count > 0 ? `${preset.label} ${count + 1}` : preset.label,
      layout_id: kind === "visual" ? getPostLayout(preset.layout_id, preset.platform).id : undefined,
      width: preset.width,
      height: preset.height,
      x: position?.x ?? maxX + 120,
      y: position?.y ?? 80,
      text: kind === "note" ? "" : undefined,
      layers: [],
    };
    set({ artboards: [...artboards, ab] });
    schedulePersist(set, get);
  },

  ensureCaptionArtboardAt: (x, y) => {
    set((s) => {
      const primary = s.artboards.find(isPrimaryCaptionArtboard);
      if (!primary) {
        return { artboards: [{ ...captionArtboard(), x, y }, ...s.artboards] };
      }
      return { artboards: [...s.artboards, captionVariantArtboard(s.artboards, x, y)] };
    });
    schedulePersist(set, get);
  },

  toggleArtboardLock: (artboardId) => {
    set((s) => ({
      artboards: s.artboards.map((a) => (a.id === artboardId ? { ...a, locked: !a.locked } : a)),
    }));
    schedulePersist(set, get);
  },

  removeArtboard: (artboardId) => {
    set((s) => ({
      artboards: s.artboards.filter(
        (a) => a.id !== artboardId || isPrimaryCaptionArtboard(a) || isLocked(a)
      ),
      issues: s.artboards.some((a) => a.id === artboardId && isLocked(a))
        ? s.issues
        : s.issues.filter((i) => i.artboard_id !== artboardId || i.status !== "open"),
    }));
    schedulePersist(set, get);
  },

  moveArtboard: (artboardId, x, y) => {
    set((s) => ({
      artboards: s.artboards.map((a) => (a.id === artboardId && !isLocked(a) ? { ...a, x, y } : a)),
    }));
    schedulePersist(set, get);
  },

  resizeArtboard: (artboardId, width, height) => {
    set((s) => ({
      artboards: s.artboards.map((a) => {
        if (a.id !== artboardId) return a;
        if (isLocked(a)) return a;
        const resized = { ...a, width, height };
        return artboardKind(a) === "visual"
          ? { ...resized, layers: fitLayersToLayout(resized) }
          : resized;
      }),
    }));
    markTargetNeedsRerun(set, artboardId);
    markTargetNeedsRerun(set, "__workspace__");
    schedulePersist(set, get);
  },

  updateArtboardLabel: (artboardId, label) => {
    const clean = label.trim();
    set((s) => ({
      artboards: s.artboards.map((a) => (
        a.id === artboardId && !isLocked(a)
          ? { ...a, label: clean || (isPrimaryCaptionArtboard(a) ? "Caption Input 1" : "Untitled caption") }
          : a
      )),
    }));
    schedulePersist(set, get);
  },

  updateArtboardText: (artboardId, text) => {
    set((s) => ({
      artboards: s.artboards.map((a) => (a.id === artboardId && !isLocked(a) ? { ...a, text } : a)),
      issues: s.issues.filter((i) => i.artboard_id !== artboardId || i.status === "ignored"),
    }));
    markTargetNeedsRerun(set, artboardId);
    schedulePersist(set, get);
  },

  updateImageCheckLabel: (label) => {
    const clean = label.trim();
      set({ imageCheckLabel: clean || DEFAULT_IMAGE_CHECK_LABEL });
    schedulePersist(set, get);
  },

  setArtboardLayout: (artboardId, layoutId) => {
    set((s) => ({
      artboards: s.artboards.map((ab) => {
        if (ab.id !== artboardId) return ab;
        if (isLocked(ab)) return ab;
        if (artboardKind(ab) !== "visual") return ab;
        const nextLayoutId = getPostLayout(layoutId, ab.platform).id;
        const next = { ...ab, layout_id: nextLayoutId };
        return { ...next, layers: fitLayersToLayout(next) };
      }),
    }));
    markTargetNeedsRerun(set, artboardId);
    markTargetNeedsRerun(set, "__workspace__");
    schedulePersist(set, get);
  },

  dropAssetOnArtboard: (artboardId, assetId, slotId) => {
    set((s) => ({
      artboards: s.artboards.map((ab) => {
        if (ab.id !== artboardId) return ab;
        if (isLocked(ab)) return ab;
        if (artboardKind(ab) !== "visual") return ab;
        const layoutId = getPostLayout(ab.layout_id, ab.platform).id;
        const normalized = { ...ab, layout_id: layoutId, layers: fitLayersToLayout({ ...ab, layout_id: layoutId }) };
        const slots = getLayoutSlotsFor(layoutId, normalized.platform, normalized.width, normalized.height);
        const targetSlotId = slotId && slots.some((slot) => slot.id === slotId)
          ? slotId
          : firstOpenSlotId(normalized);
        const slot = slots.find((slt) => slt.id === targetSlotId) ?? slots[0];
        if (!slot) return normalized;
        const layer = {
          id: `layer_${Date.now().toString(36)}`,
          type: "image" as const,
          asset_id: assetId,
          slot_id: slot.id,
          x: slot.x,
          y: slot.y,
          width: slot.width,
          height: slot.height,
          fit_mode: "cover" as const,
        };
        const slotOrder = new Map(slots.map((slt, index) => [slt.id, index]));
        return {
          ...normalized,
          layers: [
            ...normalized.layers.filter((l) => l.slot_id !== slot.id),
            layer,
          ].sort((a, b) => (slotOrder.get(a.slot_id ?? "") ?? 999) - (slotOrder.get(b.slot_id ?? "") ?? 999)),
        };
      }),
    }));
    const dropped = get().assets.find((asset) => asset.id === assetId);
    if (dropped && (
      dropped.ocr_status === "pending" ||
      dropped.ocr_status === "failed" ||
      dropped.ocr_boxes.length === 0
    )) {
      void get().runOcr(assetId);
    }
    markTargetNeedsRerun(set, artboardId);
    markTargetNeedsRerun(set, "__workspace__");
    schedulePersist(set, get);
  },

  setLayerFit: (artboardId, layerId, fit) => {
    set((s) => ({
      artboards: s.artboards.map((ab) =>
        ab.id === artboardId && !isLocked(ab)
          ? { ...ab, layers: ab.layers.map((l) => (l.id === layerId ? { ...l, fit_mode: fit } : l)) }
          : ab
      ),
    }));
    schedulePersist(set, get);
  },

  selectIssue: (issueId) => set({ selectedIssueId: issueId }),
  setTab: (tab) => set({ activeTab: tab }),
  setEditorMode: (mode) => set({ editorMode: mode }),
  setAppMode: (mode) => set({ appMode: mode, activeTab: mode === "check" && get().activeTab === "brandkit" ? "issues" : get().activeTab }),
}));
