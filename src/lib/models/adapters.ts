import type { BrandKit, Issue, OcrBox, QASummary } from "@/types";
import type { OcrVisualClassification } from "@/lib/qa/visualTextFilter";
import { chat, extractJson, type ModelRole } from "./gateway";

function brandKitForPrompt(kit: BrandKit): string {
  return JSON.stringify(
    {
      brand_terms: kit.brand_terms,
      protected_terms: kit.protected_terms,
      preferred_spellings: kit.preferred_spellings,
      product_terms: kit.product_terms,
      preferred_wording: kit.preferred_wording,
      risky_words: kit.risky_words,
      missing_tone_map: kit.missing_tone_map,
      wrong_tone_map: kit.wrong_tone_map,
      do_not_change: kit.do_not_change,
    },
    null,
    2
  );
}

export interface LLMIssueCandidate {
  type: string;
  severity: string;
  original: string;
  suggestion: string;
  reason: string;
  confidence: number;
  is_definite_error?: boolean;
  context_before?: string;
  context_after?: string;
  box_id?: string;
  self_check?: {
    exact_substring?: boolean;
    visible_or_in_ocr?: boolean;
    not_ocr_uncertainty?: boolean;
    not_protected_term?: boolean;
  };
}

function parseVerifiedIssueIds(raw: string | null): Set<string> | null {
  const parsed = extractJson<unknown>(raw);
  if (!parsed) return null;
  if (Array.isArray(parsed)) {
    const ids = parsed.filter((id): id is string => typeof id === "string");
    return ids.length ? new Set(ids) : null;
  }
  if (typeof parsed !== "object") return null;
  const data = parsed as {
    verified_issue_ids?: unknown;
    kept_issue_ids?: unknown;
    kept?: unknown;
    issues?: unknown;
  };
  const candidates = [data.verified_issue_ids, data.kept_issue_ids, data.kept, data.issues];
  for (const value of candidates) {
    if (!Array.isArray(value)) continue;
    const ids = value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "issue_id" in item && typeof item.issue_id === "string") {
          return item.issue_id;
        }
        return null;
      })
      .filter((id): id is string => Boolean(id));
    if (ids.length) return new Set(ids);
  }
  return null;
}

/** 22.1 Caption QA — Qwen/MiniMax per MODEL_CAPTION_QA. */
export async function llmCaptionQA(caption: string, kit: BrandKit): Promise<LLMIssueCandidate[] | null> {
  const system = `You are a Vietnamese Content QA Agent for internal social media content.

Task:
- Find spelling, spacing, punctuation, hashtag, terminology, brand consistency, grammar, ambiguity, and style issues.
- Separate definite errors (is_definite_error=true) from suggestions (false).
- Do not rewrite the whole caption.
- Do not change brand terms unless Brand Kit says they are wrong.
- For hashtags, only flag invalid format (for example, a space after #). Do not require an allowed hashtag list.
- If the beginning of the caption is an all-caps title/heading, do not flag capitalization/case/style just because it is uppercase. Still flag concrete spelling, spacing, punctuation, hashtag, or brand errors inside it.
- Pay attention to practical typo risks that deterministic rules may mark as needs_review: unclear relative dates such as "hôm nay/ngày mai", unexplained internal acronyms such as BU/PM/POC, ambiguous Vietnamese pairs such as dành/giành or sát/xát, and URLs that may include trailing punctuation by mistake.
- Every issue must quote the exact original substring, character-for-character, copied from the caption.
- If a candidate issue cannot quote exact text from the input, do not include it.
- Use short Vietnamese explanations in "reason".
${kit.style_notes ? `\nStyle/tone notes:\n${kit.style_notes}\n` : ""}
Return JSON only:
{"issues":[{"type":"spelling|spacing|punctuation|hashtag|brand_term|terminology|grammar|style|ambiguity","severity":"critical|high|medium|low|suggestion|needs_review","original":"...","suggestion":"...","reason":"...","confidence":0.0,"is_definite_error":true,"context_before":"...","context_after":"..."}]}`;

  const messages: Parameters<typeof chat>[1] = [
    { role: "system", content: system },
    { role: "user", content: `Brand Kit:\n${brandKitForPrompt(kit)}\n\nCaption:\n${caption}` },
  ];

  const roles: ModelRole[] = ["caption_qa", "image_qa", "report"];
  let sawModelResponse = false;
  for (const role of roles) {
    const raw = await chat(role, messages, { maxTokens: 5000 });
    if (raw !== null) sawModelResponse = true;
    const parsed = extractJson<{ issues: LLMIssueCandidate[] }>(raw);
    if (Array.isArray(parsed?.issues)) return parsed.issues;
  }
  return sawModelResponse ? [] : null;
}

/** 22.2 Verifier — second reviewer removing false positives. */
export async function llmVerify(
  caption: string,
  kit: BrandKit,
  candidates: Issue[]
): Promise<{ kept: Set<string> } | null> {
  const system = `You are the second reviewer of Vietnamese content QA issues.
Your job:
- Remove false positives.
- Remove issues whose original text does not exist in the caption.
- Downgrade pure style preferences marked as high severity (reject them here).
- Reject suggestions that change meaning.
- Reject suggestions that incorrectly modify brand terms.
- Reject hashtag issues that are only about not being on an allowed list.
- Keep clear spelling, spacing, punctuation, hashtag, and brand consistency errors.
Return JSON only: {"verified_issue_ids":["..."],"removed":[{"issue_id":"...","reason_removed":"..."}]}`;

  const payload = candidates.map((c) => ({
    issue_id: c.issue_id,
    type: c.type,
    severity: c.severity,
    original: c.original,
    suggestion: c.suggestion,
    reason: c.reason,
  }));
  const raw = await chat("verify", [
    { role: "system", content: system },
    {
      role: "user",
      content: `Caption:\n${caption}\n\nBrand Kit:\n${brandKitForPrompt(kit)}\n\nCandidate issues:\n${JSON.stringify(payload, null, 2)}`,
    },
  ], { maxTokens: 5000 });
  if (raw === null) return null;
  const kept = parseVerifiedIssueIds(raw);
  if (kept) return { kept };

  // MiniMax sometimes spends tokens on reasoning before the final JSON. A compact
  // retry keeps the answer tiny and makes the verifier reliable for live demos.
  const compactSystem = `You verify Vietnamese QA issue candidates.
Return minified JSON only, with this exact shape:
{"verified_issue_ids":["issue_id"]}
Keep only clear errors. Reject false positives, missing original text, unsafe brand edits, and meaning-changing suggestions.`;
  const compactPayload = payload.map((c) => `${c.issue_id}|${c.type}|${c.original}=>${c.suggestion}`).join("\n");
  const retry = await chat("verify", [
    { role: "system", content: compactSystem },
    {
      role: "user",
      content: `Caption:\n${caption}\n\nProtected terms:\n${JSON.stringify(kit.do_not_change)}\n\nCandidates:\n${compactPayload}`,
    },
  ], { maxTokens: 2500 });
  const retryKept = parseVerifiedIssueIds(retry);
  return retryKept ? { kept: retryKept } : null;
}

/** 22.3 Gemma image/OCR cross-check (vision). */
export async function llmClassifyOcrBoxes(
  imageDataUrl: string,
  boxes: OcrBox[],
  kit: BrandKit
): Promise<{ classifications: OcrVisualClassification[] } | null> {
  if (boxes.length === 0) return { classifications: [] };
  const system = `You classify OCR text boxes from a social media image before copy QA.

Goal:
- Decide which OCR boxes are real graphic text that should be checked for text errors.
- Skip standalone type logos, logo wordmarks, brand lockups, icon/noise, and decorative text.
- Do NOT skip footer text, tiny readable disclaimers, dates, links, captions, headings, CTAs, labels, or event details. They are graphic_text.
- If you are not sure, use role "unknown" and should_check=true so the QA system can review it.
- Use the image only to understand the visual role. Do not report copy issues here.

Roles:
- graphic_text: visible text intended as poster/banner/caption content. Check it.
- logo_wordmark: standalone brand/logo/type lockup. Do not check it.
- decorative_text: ornamental text/texture that is not intended copy. Do not check it.
- icon_noise: OCR read an icon, shape, or non-text symbol as text. Do not check it.
- unknown: uncertain text-like region. Check it.

Return JSON only:
{"classifications":[{"box_id":"...","role":"graphic_text|logo_wordmark|decorative_text|icon_noise|unknown","should_check":true,"confidence":0.0,"reason":"short Vietnamese reason"}]}`;

  const ocrPayload = boxes.map((b) => ({
    box_id: b.box_id,
    text: b.text,
    confidence: b.confidence,
    bbox: b.bbox,
    deterministic_role: b.visual_role,
    deterministic_should_check: b.visual_should_check,
  }));
  const raw = await chat("image_qa", [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        { type: "text", text: `Brand Kit:\n${brandKitForPrompt(kit)}\n\nOCR boxes:\n${JSON.stringify(ocrPayload, null, 2)}` },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    },
  ], { maxTokens: 2500 });
  return extractJson(raw);
}

export async function llmImageCrossCheck(
  imageDataUrl: string,
  boxes: OcrBox[],
  kit: BrandKit
): Promise<{
  ocr_review: { box_id: string; status: string; reason: string }[];
  issues: LLMIssueCandidate[];
} | null> {
const system = `You are a visual text QA agent.
Task:
1. Check whether the provided OCR text matches the visible image text.
2. Flag OCR boxes that may be wrong or low confidence.
3. Find concrete text issues based on OCR text: spelling, spacing, punctuation, hashtag, brand_term, terminology, grammar, style, ambiguity.
4. Do not invent text that is not visible.
5. For hashtags, only flag invalid format (for example, a space after #). Do not require an allowed hashtag list.
6. Pay attention to OCR-specific copy risks: split or joined Vietnamese words, icon/noise read as letters, field-label colons read as "|" or "I", and two field-label lines merged into one line.
7. If uncertain, use status "needs_human_review".
8. Do not claim exact location unless it is tied to an OCR box (use box_id).
9. The input boxes were pre-filtered to exclude standalone logos/decorative text when possible. Do not add issues for omitted logo/decoration areas.
10. Do not flag logo casing, all-caps design treatment, initial title/heading capitalization, decorative brand lockups, crop/safe-zone, contrast, alignment, or other visual design issues.
11. Before returning each issue, privately run this checklist:
   - original is an exact substring of the OCR box text
   - the issue is visible in the image or clearly present in OCR text
   - the suggestion does not change meaning
   - the issue is not merely OCR uncertainty
   - the suggestion does not alter protected brand terms
   If any answer is no, omit the issue or mark it needs_human_review only.
Return JSON only:
{"ocr_review":[{"box_id":"...","status":"ok|possibly_wrong|needs_human_review","reason":"..."}],"issues":[{"box_id":"...","type":"...","severity":"...","original":"...","suggestion":"...","reason":"...","confidence":0.0,"is_definite_error":true,"self_check":{"exact_substring":true,"visible_or_in_ocr":true,"not_ocr_uncertainty":true,"not_protected_term":true}}]}`;

  const ocrPayload = boxes.map((b) => ({ box_id: b.box_id, text: b.text, confidence: b.confidence, bbox: b.bbox }));
  const raw = await chat("image_qa", [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        { type: "text", text: `Brand Kit:\n${brandKitForPrompt(kit)}\n\nOCR boxes:\n${JSON.stringify(ocrPayload, null, 2)}` },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    },
  ], { maxTokens: 2048 });
  return extractJson(raw);
}

/** OCR text QA reviewer. Uses text extracted from image boxes, not layout/design signals. */
export async function llmOcrTextQA(
  role: Extract<ModelRole, "caption_qa" | "verify">,
  reviewerName: string,
  boxes: OcrBox[],
  kit: BrandKit,
  opts: { maxTokens?: number; timeoutMs?: number } = {}
): Promise<LLMIssueCandidate[] | null> {
  if (boxes.length === 0) return [];
  const system = `You are ${reviewerName}, a Vietnamese copy QA reviewer for OCR-extracted social media image text.

Task:
- Review only the OCR text provided in each box. Do not judge design, crop, safe zone, contrast, alignment, image quality, or layout.
- The input boxes were filtered to contain graphic text or uncertain text-like regions. Standalone type logos and decorative regions are excluded upstream when possible.
- Find spelling, spacing, punctuation, hashtag, terminology, brand consistency, grammar, ambiguity, and style issues.
- For hashtags, only flag invalid format (for example, a space after #). Do not require an allowed hashtag list.
- Pay extra attention to field-label punctuation, event details, inconsistent date/number formats, wrong Vietnamese diacritics, and obvious typos in short poster copy.
- For field labels such as "Đối tượng tham gia", "Hình thức tham gia", "Thời gian", "Địa điểm", use a colon after the label, not a semicolon.
- Also check OCR-specific copy risks: split or joined Vietnamese words, icon/noise read as letters, field-label colons read as "|" or "I", and two field-label lines merged into one line.
- If the issue is only likely because OCR may be wrong, mark it as needs_review instead of a definite error.
- If a box is an all-caps title/heading, do not flag capitalization/case/style just because it is uppercase. Still flag concrete spelling, spacing, punctuation, hashtag, or brand errors inside it.
- Every issue must include the exact box_id and an exact original substring copied character-for-character from that box's OCR text.
- Do not invent text that is not present in the OCR box.
- If the text may simply be OCR uncertainty, do not report it as a definite copy error.
- Before returning each issue, privately run this checklist:
  exact original substring exists in the OCR box; suggestion is safer than original; issue is not only OCR uncertainty; protected/brand terms are not harmed.
  Return the issue only if the checklist passes. If uncertain but important, use severity "needs_review", confidence <= 0.74, and is_definite_error=false.
- Use short Vietnamese explanations in "reason".
Return JSON only:
{"issues":[{"box_id":"...","type":"spelling|spacing|punctuation|hashtag|brand_term|terminology|grammar|style|ambiguity","severity":"critical|high|medium|low|suggestion|needs_review","original":"...","suggestion":"...","reason":"...","confidence":0.0,"is_definite_error":true,"context_before":"...","context_after":"...","self_check":{"exact_substring":true,"visible_or_in_ocr":true,"not_ocr_uncertainty":true,"not_protected_term":true}}]}`;

  const payload = boxes.map((b) => ({
    box_id: b.box_id,
    text: b.text,
    confidence: b.confidence,
  }));
  const raw = await chat(role, [
    { role: "system", content: system },
    {
      role: "user",
      content: `Brand Kit:\n${brandKitForPrompt(kit)}\n\nOCR boxes:\n${JSON.stringify(payload, null, 2)}`,
    },
  ], {
    maxTokens: opts.maxTokens ?? 2200,
    timeoutMs: opts.timeoutMs ?? (role === "verify" ? 28_000 : 30_000),
  });
  const parsed = extractJson<{ issues: LLMIssueCandidate[] }>(raw);
  return parsed?.issues ?? (raw === null ? null : []);
}

/** Vision-assisted OCR correction. Tesseract keeps the bbox; the model only fixes visible text. */
export async function llmCorrectOcrBoxes(
  imageDataUrl: string,
  boxes: OcrBox[],
  kit?: BrandKit
): Promise<{
  corrections: {
    box_id: string;
    corrected_text: string;
    confidence?: number;
    reason?: string;
  }[];
} | null> {
  if (boxes.length === 0) return null;
  const system = `You are an OCR correction agent for Vietnamese social media images.
Use the image as ground truth and the OCR boxes as approximate regions.
For each box:
- Return the exact visible text inside that same region.
- Preserve Vietnamese diacritics, capitalization, punctuation, numbers, and brand spelling.
- If the OCR box is only icon/noise/decoration, return an empty corrected_text.
- Do not add text from outside the OCR box.
- Do not create new boxes.
- If the current OCR text already looks correct, return the same text with high confidence.
- Before changing text, privately verify that the corrected text is visible in the same box, keeps all numbers/dates and protected brand terms, and is not a guess. If uncertain, return the original OCR text.
Return JSON only:
{"corrections":[{"box_id":"...","corrected_text":"...","confidence":0.0,"reason":"..."}]}`;

  const ocrPayload = boxes.map((b) => ({
    box_id: b.box_id,
    text: b.text,
    confidence: b.confidence,
    bbox: b.bbox,
  }));
  const raw = await chat("image_qa", [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `${kit ? `Brand Kit:\n${brandKitForPrompt(kit)}\n\n` : ""}OCR boxes:\n${JSON.stringify(ocrPayload, null, 2)}`,
        },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    },
  ], { maxTokens: 3500 });
  return extractJson(raw);
}

/** 22.4 Final report — MiniMax. Falls back to a deterministic template when not configured. */
export async function llmReport(
  workspaceName: string,
  summary: QASummary,
  issues: Issue[],
  correctedCaption: string
): Promise<string | null> {
  const system = `You are a concise Vietnamese QA report writer.
Write a clear QA report in Vietnamese. Group issues by severity and source. Keep it concise.
Do not add issues not present in the input. Do not rewrite the caption. Return Markdown.`;
  const raw = await chat("report", [
    { role: "system", content: system },
    {
      role: "user",
      content: JSON.stringify({ workspace: workspaceName, summary, issues: issues.map((i) => ({
        source: i.source_type, type: i.type, severity: i.severity, original: i.original,
        suggestion: i.suggestion, reason: i.reason, status: i.status,
      })), corrected_caption: correctedCaption }, null, 2),
    },
  ], { maxTokens: 3000 });
  return raw;
}
