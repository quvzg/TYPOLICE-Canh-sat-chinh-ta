import type { BrandKit, OcrBox, OcrVisualRole } from "@/types";

export interface OcrVisualClassification {
  box_id: string;
  role?: string;
  should_check?: boolean;
  confidence?: number;
  reason?: string;
}

const CHECKABLE_ROLES = new Set<OcrVisualRole>(["graphic_text", "unknown"]);
const SKIPPED_ROLES = new Set<OcrVisualRole>(["logo_wordmark", "decorative_text", "icon_noise"]);

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function compactKey(value: string): string {
  return normalizeText(value)
    .toLocaleLowerCase("vi-VN")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function wordParts(value: string): string[] {
  return normalizeText(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function addTerm(terms: Set<string>, value: unknown) {
  if (typeof value !== "string") return;
  const compact = compactKey(value);
  if (compact.length >= 3) terms.add(compact);
}

function canonicalBrandTerms(kit: BrandKit): Set<string> {
  const terms = new Set<string>();
  for (const term of kit.brand_terms) addTerm(terms, term);
  for (const term of kit.protected_terms) addTerm(terms, term);
  for (const term of kit.do_not_change) addTerm(terms, term);
  for (const [wrong, preferred] of Object.entries(kit.preferred_spellings)) {
    addTerm(terms, wrong);
    addTerm(terms, preferred);
  }
  for (const [wrong, preferred] of Object.entries(kit.product_terms)) {
    addTerm(terms, wrong);
    addTerm(terms, preferred);
  }
  for (const [wrong, preferred] of Object.entries(kit.preferred_wording)) {
    addTerm(terms, wrong);
    addTerm(terms, preferred);
  }
  return terms;
}

function hasSentenceOrInstructionSignal(text: string): boolean {
  const normalized = normalizeText(text);
  const words = wordParts(normalized);
  if (words.length > 4) return true;
  if (/[.!?;:|]/u.test(normalized)) return true;
  if (/#|@|https?:\/\//iu.test(normalized)) return true;
  if (/\b(ngày|tháng|năm|giờ|phút|tham gia|đăng ký|đối tượng|hình thức|thời gian|địa điểm|lưu ý|ưu đãi|khuyến mãi)\b/iu.test(normalized)) {
    return true;
  }
  return false;
}

function isLikelyStandaloneLogoWordmark(text: string, kit: BrandKit): boolean {
  const normalized = normalizeText(text);
  if (!normalized || hasSentenceOrInstructionSignal(normalized)) return false;
  const parts = wordParts(normalized);
  if (parts.length === 0 || parts.length > 4) return false;
  if (normalized.length > 48) return false;
  return canonicalBrandTerms(kit).has(compactKey(normalized));
}

function isLikelyIconOrDecorationNoise(box: OcrBox): boolean {
  const text = normalizeText(box.text);
  if (!text) return true;
  const alnum = text.match(/[\p{L}\p{N}]/gu) ?? [];
  if (alnum.length === 0) return true;
  if (/\d/u.test(text)) return false;
  if (alnum.length === 1 && text.length <= 2 && box.confidence < 0.72) return true;
  if (alnum.length <= 2 && text.length <= 3 && box.confidence < 0.45) return true;
  return false;
}

function normalizeVisualRole(role: string | undefined): OcrVisualRole {
  if (
    role === "graphic_text" ||
    role === "logo_wordmark" ||
    role === "decorative_text" ||
    role === "icon_noise" ||
    role === "unknown"
  ) {
    return role;
  }
  return "unknown";
}

function roleShouldCheck(role: OcrVisualRole, requested?: boolean): boolean {
  if (CHECKABLE_ROLES.has(role)) return true;
  if (SKIPPED_ROLES.has(role)) return false;
  return requested !== false;
}

function deterministicClassification(box: OcrBox, kit: BrandKit): Required<Pick<
  OcrBox,
  "visual_role" | "visual_should_check" | "visual_confidence" | "visual_reason"
>> {
  const text = normalizeText(box.text);
  if (!text) {
    return {
      visual_role: "decorative_text",
      visual_should_check: false,
      visual_confidence: 0.92,
      visual_reason: "Vùng này không có chữ đọc được.",
    };
  }

  if (isLikelyIconOrDecorationNoise(box)) {
    return {
      visual_role: "icon_noise",
      visual_should_check: false,
      visual_confidence: 0.78,
      visual_reason: "Vùng này giống ký hiệu/icon hoặc nhiễu nhận diện, không phải chữ cần kiểm tra.",
    };
  }

  if (isLikelyStandaloneLogoWordmark(text, kit)) {
    return {
      visual_role: "logo_wordmark",
      visual_should_check: false,
      visual_confidence: 0.88,
      visual_reason: "Box là logo/type logo hoặc brand lockup đứng riêng, không check lỗi chữ.",
    };
  }

  if (box.confidence < 0.58) {
    return {
      visual_role: "unknown",
      visual_should_check: true,
      visual_confidence: Math.max(0.4, box.confidence),
      visual_reason: "Chưa chắc vùng này là graphic text, nhưng vẫn đưa vào review để tránh bỏ sót lỗi.",
    };
  }

  return {
    visual_role: "graphic_text",
    visual_should_check: true,
    visual_confidence: 0.74,
    visual_reason: "Box có nội dung chữ trên ảnh nên sẽ được check như caption.",
  };
}

export function applyDeterministicOcrVisualRoles(boxes: OcrBox[], kit: BrandKit): OcrBox[] {
  return boxes.map((box) => ({
    ...box,
    ...deterministicClassification(box, kit),
  }));
}

export function applyVisionOcrVisualRoles(
  boxes: OcrBox[],
  classifications: OcrVisualClassification[]
): OcrBox[] {
  const byId = new Map(classifications.map((item) => [item.box_id, item]));
  return boxes.map((box) => {
    const classification = byId.get(box.box_id);
    if (!classification) return box;

    // Deterministic standalone brand/logo detection wins over the model so
    // canonical wordmarks are not accidentally checked as normal poster copy.
    if (box.visual_role === "logo_wordmark" && box.visual_should_check === false) return box;

    const role = normalizeVisualRole(classification.role);
    const shouldCheck = roleShouldCheck(role, classification.should_check);
    const confidence = typeof classification.confidence === "number"
      ? Math.max(0, Math.min(1, classification.confidence))
      : box.visual_confidence;
    const deterministicCheckable = box.visual_should_check !== false && CHECKABLE_ROLES.has(normalizeVisualRole(box.visual_role));
    const skipWouldLoseLikelyCopy = deterministicCheckable && !shouldCheck && (
      role === "unknown" ||
      (
        (confidence ?? 0) < 0.75 &&
        (hasSentenceOrInstructionSignal(box.text) || wordParts(box.text).length >= 3)
      )
    );
    if (skipWouldLoseLikelyCopy) {
      return {
        ...box,
        visual_role: normalizeVisualRole(box.visual_role),
        visual_should_check: true,
        visual_confidence: Math.max(box.visual_confidence ?? 0.6, Math.min(confidence ?? 0.6, 0.82)),
        visual_reason: classification.reason
          ? `Giữ lại để tránh bỏ sót text: ${classification.reason}`
          : box.visual_reason,
      };
    }

    return {
      ...box,
      visual_role: role,
      visual_should_check: shouldCheck,
      visual_confidence: confidence,
      visual_reason: classification.reason || box.visual_reason,
    };
  });
}

export function isVisualCheckableOcrBox(box: OcrBox): boolean {
  const role = normalizeVisualRole(box.visual_role);
  return Boolean(box.text.trim()) && box.visual_should_check !== false && CHECKABLE_ROLES.has(role);
}

export function summarizeOcrVisualRoles(boxes: OcrBox[]) {
  let checkable = 0;
  let skipped = 0;
  const byRole: Record<OcrVisualRole, number> = {
    graphic_text: 0,
    logo_wordmark: 0,
    decorative_text: 0,
    icon_noise: 0,
    unknown: 0,
  };

  for (const box of boxes) {
    const role = normalizeVisualRole(box.visual_role);
    byRole[role] += 1;
    if (isVisualCheckableOcrBox(box)) checkable += 1;
    else skipped += 1;
  }

  return { total: boxes.length, checkable, skipped, byRole };
}
