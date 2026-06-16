import fs from "fs";
import path from "path";
import { llmCorrectOcrBoxes } from "@/lib/models/adapters";
import { isRoleConfigured } from "@/lib/models/gateway";
import type { BrandKit, OcrBox } from "@/types";

const MIN_CORRECTION_CONFIDENCE = 0.86;
const MAX_CORRECTION_LENGTH = 240;
const HIGH_CONFIDENCE_OCR = 0.84;
const MIN_TEXT_SIMILARITY = 0.72;

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function normalizeCorrectedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/\s+/g, " ").trim();
}

function comparableText(value: string): string {
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
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }
  return prev[b.length];
}

function textSimilarity(a: string, b: string): number {
  const left = comparableText(a);
  const right = comparableText(b);
  if (!left && !right) return 1;
  const maxLength = Math.max(left.length, right.length, 1);
  return 1 - levenshteinDistance(left, right) / maxLength;
}

function digitSignature(value: string): string {
  return (value.match(/\d+/g) ?? []).join("|");
}

function protectedTermSurvives(original: string, corrected: string, brandKit?: BrandKit): boolean {
  const protectedTerms = brandKit?.do_not_change ?? [];
  const originalLower = comparableText(original);
  const correctedLower = comparableText(corrected);
  return protectedTerms.every((term) => {
    const normalizedTerm = comparableText(term);
    return !normalizedTerm || !originalLower.includes(normalizedTerm) || correctedLower.includes(normalizedTerm);
  });
}

function boundedConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : MIN_CORRECTION_CONFIDENCE;
}

export async function correctOcrWithVision(filePath: string, boxes: OcrBox[], brandKit?: BrandKit): Promise<OcrBox[]> {
  if (!isRoleConfigured("image_qa") || boxes.length === 0) return boxes;

  const imageDataUrl = `data:${mimeFromPath(filePath)};base64,${fs.readFileSync(filePath).toString("base64")}`;
  const result = await llmCorrectOcrBoxes(imageDataUrl, boxes, brandKit);
  const corrections = new Map((result?.corrections ?? []).map((item) => [item.box_id, item]));
  if (corrections.size === 0) return boxes;

  const corrected: OcrBox[] = [];
  for (const box of boxes) {
    const item = corrections.get(box.box_id);
    const text = normalizeCorrectedText(item?.corrected_text);
    const confidence = boundedConfidence(item?.confidence);

    if (!item || text === null || confidence < MIN_CORRECTION_CONFIDENCE) {
      corrected.push(box);
      continue;
    }

    // Never delete an OCR box here. Visual filtering decides later whether a box
    // is logo/noise/decorative; OCR correction only edits text when very sure.
    if (text.length === 0) {
      corrected.push(box);
      continue;
    }
    if (text.length > MAX_CORRECTION_LENGTH) {
      corrected.push(box);
      continue;
    }
    if (comparableText(text) === comparableText(box.text)) {
      corrected.push({
        ...box,
        confidence: Math.max(box.confidence, Math.min(0.98, confidence)),
      });
      continue;
    }
    if (digitSignature(box.text) !== digitSignature(text)) {
      corrected.push(box);
      continue;
    }
    if (!protectedTermSurvives(box.text, text, brandKit)) {
      corrected.push(box);
      continue;
    }
    const similarity = textSimilarity(box.text, text);
    if (similarity < MIN_TEXT_SIMILARITY) {
      corrected.push(box);
      continue;
    }
    if (box.confidence >= HIGH_CONFIDENCE_OCR && confidence < 0.93 && similarity < 0.88) {
      corrected.push(box);
      continue;
    }

    corrected.push({
      ...box,
      text,
      confidence: Math.max(box.confidence, Math.min(0.98, confidence)),
    });
  }

  return corrected;
}
