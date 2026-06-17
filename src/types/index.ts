// ===== Unified types shared by caption / image / layout QA =====

export type IssueType =
  | "spelling"
  | "spacing"
  | "punctuation"
  | "hashtag"
  | "brand_term"
  | "terminology"
  | "grammar"
  | "style"
  | "ambiguity"
  | "ocr_low_confidence"
  | "layout_risk"
  | "platform_format";

export type IssueSeverity =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "suggestion"
  | "needs_review";

export type IssueStatus =
  | "open"
  | "accepted"
  | "ignored"
  | "resolved"
  | "needs_human_review";

export type IssueSource = "caption" | "image" | "layout";

export interface IssueRange {
  start: number;
  end: number;
}

export interface Issue {
  issue_id: string;
  source_type: IssueSource;
  source_id: string; // caption_id | asset_id | artboard_id
  artboard_id: string | null;
  box_id: string | null;
  type: IssueType;
  severity: IssueSeverity;
  original: string;
  suggestion: string;
  reason: string;
  confidence: number;
  is_definite_error: boolean;
  range: IssueRange | null; // caption issues only
  bbox: [number, number, number, number] | null; // image issues, px in original image coords
  context_before?: string;
  context_after?: string;
  status: IssueStatus;
  created_by: string; // "rule_checker" | "qwen_qa" | "gemma_qa" | ...
}

// ===== OCR =====

export type OcrVisualRole =
  | "graphic_text"
  | "logo_wordmark"
  | "decorative_text"
  | "icon_noise"
  | "unknown";

export interface OcrBox {
  box_id: string;
  asset_id: string;
  text: string;
  confidence: number; // 0..1
  bbox: [number, number, number, number]; // x0, y0, x1, y1
  language?: string;
  visual_role?: OcrVisualRole;
  visual_should_check?: boolean;
  visual_confidence?: number;
  visual_reason?: string;
}

export type OcrStatus = "pending" | "processing" | "done" | "low_confidence" | "failed";

// ===== Workspace entities =====

export interface Asset {
  id: string;
  type: "image";
  filename: string;
  width: number;
  height: number;
  hash: string;
  url: string; // served via /api/files/...
  ocr_status: OcrStatus;
  ocr_boxes: OcrBox[];
}

export type Platform = "facebook" | "linkedin" | "workspace";
export type ArtboardKind = "visual" | "caption" | "note";

export interface ArtboardPreset {
  id: string;
  platform: Platform;
  label: string;
  format: string;
  kind?: ArtboardKind;
  layout_id?: string;
  width: number;
  height: number;
}

export interface Layer {
  id: string;
  type: "image";
  asset_id: string;
  slot_id?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fit_mode: "cover" | "contain";
}

export interface Artboard {
  id: string;
  platform: Platform;
  format: string;
  kind?: ArtboardKind;
  layout_id?: string;
  label: string;
  width: number;
  height: number;
  x: number; // position on canvas
  y: number;
  locked?: boolean;
  text?: string;
  layers: Layer[];
}

export interface Caption {
  id: string;
  platform: Platform | "all";
  text: string;
}

export interface BrandKit {
  brand_terms: string[];
  protected_terms: string[];
  allowed_hashtags: string[];
  preferred_spellings: Record<string, string>;
  product_terms: Record<string, string>;
  risky_words: Record<string, { priority: "high" | "medium" | "low"; suggestion: string }>;
  preferred_wording: Record<string, string>;
  cta_rules: {
    preferred: string[];
    avoid: Record<string, string>;
  };
  missing_tone_map: Record<string, string>;
  wrong_tone_map: Record<string, string>;
  ambiguous_words: Record<string, string[]>;
  do_not_change: string[];
  style_notes?: string; // condensed from style_guide.md / tone_of_voice.md
}

export interface Workspace {
  id: string;
  name: string;
  kind?: "check" | "project";
  image_check_label?: string;
  created_at: string;
  assets: Asset[];
  artboards: Artboard[];
  caption: Caption;
  issues: Issue[];
  last_agent_trace?: AgentRunTrace | null;
}

export interface QASummary {
  total_issues: number;
  definite_errors: number;
  suggestions: number;
  needs_review: number;
  by_severity: Record<string, number>;
  by_source: Record<string, number>;
}

// ===== Agent run trace =====

export type AgentRunStepStatus = "running" | "completed" | "skipped" | "failed";

export interface AgentModelConfig {
  caption_qa: string;
  verify: string;
  image_qa: string;
  report: string;
}

export interface AgentRunStep {
  id: string;
  label: string;
  status: AgentRunStepStatus;
  detail: string;
  model_role?: keyof AgentModelConfig;
  model?: string;
  tool?: string;
  count?: number;
  duration_ms?: number;
}

export interface AgentRunTrace {
  run_id: string;
  track: "Automation & Integration";
  objective: string;
  started_at: string;
  completed_at: string | null;
  models: AgentModelConfig;
  steps: AgentRunStep[];
}
