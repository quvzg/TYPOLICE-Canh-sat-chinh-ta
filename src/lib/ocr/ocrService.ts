import fs from "fs";
import path from "path";
import sharp from "sharp";
import { createWorker, PSM, type Worker } from "tesseract.js";
import type { OcrBox } from "@/types";

const storageDir = () => path.join(/* turbopackIgnore: true */ process.cwd(), "storage");
const cacheDir = () => path.join(storageDir(), "ocr-cache");
const workerPath = () =>
  path.join(/* turbopackIgnore: true */ process.cwd(), "node_modules", "tesseract.js", "src", "worker-script", "node", "index.js");
const corePath = () =>
  path.join(/* turbopackIgnore: true */ process.cwd(), "node_modules", "tesseract.js-core");
const langPath = () =>
  path.join(/* turbopackIgnore: true */ process.cwd(), "tessdata");
const OCR_CACHE_VERSION = "v5";
const OCR_TARGET_LONG_EDGE = 1800;
const OCR_MAX_LONG_EDGE = 2600;
const OCR_FALLBACK_MIN_CONFIDENCE = 0.45;

let workerPromise: Promise<Worker> | null = null;
const ocrInFlight = new Map<string, Promise<OcrBox[]>>();

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    // 'vie' traineddata is downloaded on first run and cached under storage/
    workerPromise = createWorker("vie+eng", 1, {
      workerPath: workerPath(),
      corePath: corePath(),
      langPath: langPath(),
      gzip: false,
      cachePath: path.join(storageDir(), "tessdata"),
      errorHandler: (err) => {
        console.error("[ocr worker]", err);
      },
    }).catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

interface TessBlock {
  paragraphs?: { lines?: TessLine[] }[];
}
interface TessLine {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}
interface TessData {
  blocks?: TessBlock[];
  lines?: TessLine[];
}

interface OcrCachePayload {
  version: string;
  engine: "tesseract.js";
  created_at: string;
  attempt_count: number;
  box_count: number;
  avg_confidence: number;
  no_text_confirmed: boolean;
  boxes: OcrBox[];
}

export function hasCurrentOcrBoxes(boxes: OcrBox[]): boolean {
  return boxes.length > 0 && boxes.every((box) => box.box_id.startsWith(`ocr_${OCR_CACHE_VERSION}_`));
}

function cacheFileFor(fileHash: string): string {
  return path.join(cacheDir(), `${fileHash}.${OCR_CACHE_VERSION}.json`);
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function hasEnoughTextSignal(text: string): boolean {
  const alnum = text.match(/[\p{L}\p{N}]/gu) ?? [];
  if (alnum.length < 2) return false;
  return /[\p{L}]/u.test(text) || /\d{2,}/.test(text);
}

function comparableText(text: string): string {
  return cleanText(text).toLocaleLowerCase("vi-VN");
}

function extractLines(data: TessData): TessLine[] {
  const lines: TessLine[] = [];
  const seen = new Set<string>();
  const push = (line: TessLine) => {
    const text = cleanText(line.text);
    if (!text) return;
    const key = `${comparableText(text)}|${Math.round(line.bbox.x0 / 4)}|${Math.round(line.bbox.y0 / 4)}|${Math.round(line.bbox.x1 / 4)}|${Math.round(line.bbox.y1 / 4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(line);
  };

  for (const line of data.lines ?? []) push(line);
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) push(line);
    }
  }
  return lines;
}

async function recognizeLines(worker: Worker, buffer: Buffer, mode: PSM): Promise<TessLine[]> {
  await worker.setParameters({
    tessedit_pageseg_mode: mode,
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });
  const result = await worker.recognize(buffer, {}, { blocks: true, text: true });
  return extractLines(result.data as unknown as TessData);
}

function mapBboxToOriginal(
  bbox: TessLine["bbox"],
  scale: number,
  originalWidth: number,
  originalHeight: number
): [number, number, number, number] {
  const inv = scale > 0 ? 1 / scale : 1;
  return [
    Math.max(0, Math.min(originalWidth, Math.round(bbox.x0 * inv))),
    Math.max(0, Math.min(originalHeight, Math.round(bbox.y0 * inv))),
    Math.max(0, Math.min(originalWidth, Math.round(bbox.x1 * inv))),
    Math.max(0, Math.min(originalHeight, Math.round(bbox.y1 * inv))),
  ];
}

async function prepareImage(filePath: string): Promise<{
  buffer: Buffer;
  scale: number;
  originalWidth: number;
  originalHeight: number;
}> {
  const input = sharp(filePath, { limitInputPixels: false }).rotate();
  const metadata = await input.metadata();
  const originalWidth = metadata.width ?? 1;
  const originalHeight = metadata.height ?? 1;
  const longEdge = Math.max(originalWidth, originalHeight);
  const scale = longEdge < OCR_TARGET_LONG_EDGE
    ? OCR_TARGET_LONG_EDGE / longEdge
    : longEdge > OCR_MAX_LONG_EDGE
      ? OCR_MAX_LONG_EDGE / longEdge
      : 1;

  const buffer = await input
    .clone()
    .resize({
      width: Math.round(originalWidth * scale),
      height: Math.round(originalHeight * scale),
      fit: "fill",
      withoutEnlargement: false,
    })
    .flatten({ background: "#ffffff" })
    .grayscale()
    .normalise()
    .sharpen()
    .png()
    .toBuffer();

  return { buffer, scale, originalWidth, originalHeight };
}

async function prepareImageVariants(filePath: string): Promise<Array<Awaited<ReturnType<typeof prepareImage>> & { label: string }>> {
  const base = await prepareImage(filePath);
  const highContrast = await sharp(base.buffer)
    .linear(1.18, -8)
    .sharpen({ sigma: 1.15 })
    .png()
    .toBuffer();
  const binary = await sharp(base.buffer)
    .threshold(168)
    .median(1)
    .png()
    .toBuffer();
  return [
    { ...base, label: "standard" },
    { ...base, buffer: highContrast, label: "contrast" },
    { ...base, buffer: binary, label: "binary" },
  ];
}

function lineToBox(
  line: TessLine,
  index: number,
  assetId: string,
  fileHash: string,
  scale: number,
  originalWidth: number,
  originalHeight: number
): OcrBox | null {
  const text = cleanText(line.text);
  if (!hasEnoughTextSignal(text)) return null;
  return {
    box_id: `ocr_${OCR_CACHE_VERSION}_${fileHash.slice(0, 8)}_${index}`,
    asset_id: assetId,
    text,
    confidence: Math.min(1, Math.max(0, Math.round(line.confidence) / 100)),
    bbox: mapBboxToOriginal(line.bbox, scale, originalWidth, originalHeight),
    language: "vi",
  };
}

function overlapRatio(a: OcrBox, b: OcrBox): number {
  const x0 = Math.max(a.bbox[0], b.bbox[0]);
  const y0 = Math.max(a.bbox[1], b.bbox[1]);
  const x1 = Math.min(a.bbox[2], b.bbox[2]);
  const y1 = Math.min(a.bbox[3], b.bbox[3]);
  const intersection = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const areaA = Math.max(1, a.bbox[2] - a.bbox[0]) * Math.max(1, a.bbox[3] - a.bbox[1]);
  const areaB = Math.max(1, b.bbox[2] - b.bbox[0]) * Math.max(1, b.bbox[3] - b.bbox[1]);
  return intersection / Math.min(areaA, areaB);
}

function dedupeBoxes(boxes: OcrBox[], assetId: string, fileHash: string): OcrBox[] {
  const merged: OcrBox[] = [];
  for (const box of boxes) {
    const duplicate = merged.find((candidate) =>
      comparableText(candidate.text) === comparableText(box.text) &&
      overlapRatio(candidate, box) > 0.45
    );
    if (!duplicate) {
      merged.push(box);
      continue;
    }
    if (box.confidence > duplicate.confidence) {
      duplicate.text = box.text;
      duplicate.confidence = box.confidence;
      duplicate.bbox = box.bbox;
    }
  }
  return merged.map((box, index) => ({
    ...box,
    asset_id: assetId,
    box_id: `ocr_${OCR_CACHE_VERSION}_${fileHash.slice(0, 8)}_${index}`,
  }));
}

function buildBoxes(lines: TessLine[], assetId: string, fileHash: string, prepared: Awaited<ReturnType<typeof prepareImage>>): OcrBox[] {
  return lines
    .map((line, index) => lineToBox(line, index, assetId, fileHash, prepared.scale, prepared.originalWidth, prepared.originalHeight))
    .filter((box): box is OcrBox => Boolean(box));
}

function avgConfidence(boxes: OcrBox[]): number {
  return boxes.length ? boxes.reduce((sum, box) => sum + box.confidence, 0) / boxes.length : 0;
}

function parseCache(raw: unknown): OcrCachePayload | null {
  if (Array.isArray(raw)) {
    const boxes = raw.filter((box): box is OcrBox => Boolean(box?.box_id));
    if (boxes.length === 0 || !hasCurrentOcrBoxes(boxes)) return null;
    return {
      version: OCR_CACHE_VERSION,
      engine: "tesseract.js",
      created_at: new Date().toISOString(),
      attempt_count: 1,
      box_count: boxes.length,
      avg_confidence: avgConfidence(boxes),
      no_text_confirmed: false,
      boxes,
    };
  }
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as Partial<OcrCachePayload>;
  if (payload.version !== OCR_CACHE_VERSION || !Array.isArray(payload.boxes)) return null;
  if (payload.boxes.length > 0 && hasCurrentOcrBoxes(payload.boxes)) return payload as OcrCachePayload;
  if (payload.boxes.length === 0 && payload.no_text_confirmed && (payload.attempt_count ?? 0) >= 2) {
    return { ...(payload as OcrCachePayload), boxes: [] };
  }
  return null;
}

function readCache(cacheFile: string): OcrCachePayload | null {
  try {
    return parseCache(JSON.parse(fs.readFileSync(cacheFile, "utf-8")));
  } catch {
    return null;
  }
}

function readCacheLoose(cacheFile: string): OcrCachePayload | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as Partial<OcrCachePayload>;
    if (!raw || typeof raw !== "object" || raw.version !== OCR_CACHE_VERSION || !Array.isArray(raw.boxes)) return null;
    return {
      version: OCR_CACHE_VERSION,
      engine: "tesseract.js",
      created_at: typeof raw.created_at === "string" ? raw.created_at : new Date().toISOString(),
      attempt_count: typeof raw.attempt_count === "number" ? raw.attempt_count : 0,
      box_count: typeof raw.box_count === "number" ? raw.box_count : raw.boxes.length,
      avg_confidence: typeof raw.avg_confidence === "number" ? raw.avg_confidence : avgConfidence(raw.boxes),
      no_text_confirmed: raw.no_text_confirmed === true,
      boxes: raw.boxes,
    };
  } catch {
    return null;
  }
}

function writeCache(cacheFile: string, boxes: OcrBox[], previous: OcrCachePayload | null): void {
  const attemptCount = (previous?.attempt_count ?? 0) + 1;
  const payload: OcrCachePayload = {
    version: OCR_CACHE_VERSION,
    engine: "tesseract.js",
    created_at: new Date().toISOString(),
    attempt_count: attemptCount,
    box_count: boxes.length,
    avg_confidence: avgConfidence(boxes),
    no_text_confirmed: boxes.length === 0 && attemptCount >= 2,
    boxes,
  };
  fs.writeFileSync(cacheFile, JSON.stringify(payload, null, 2));
}

/**
 * OCR an image file → line-level boxes (text, confidence 0..1, bbox).
 * Result is cached by content hash: dragging/resizing an image never re-OCRs.
 */
async function runOcrUncached(filePath: string, assetId: string, fileHash: string, cacheFile: string): Promise<OcrBox[]> {
  const previousCache = readCacheLoose(cacheFile);
  const variants = await prepareImageVariants(filePath);
  const worker = await getWorker();
  const [standard, contrast, binary] = variants;
  const primaryBoxes = buildBoxes(await recognizeLines(worker, standard.buffer, PSM.SPARSE_TEXT), assetId, fileHash, standard);
  const primaryAvg = primaryBoxes.length
    ? primaryBoxes.reduce((sum, box) => sum + box.confidence, 0) / primaryBoxes.length
    : 0;
  const fallbackBoxes = primaryBoxes.length === 0 || primaryAvg < OCR_FALLBACK_MIN_CONFIDENCE
    ? buildBoxes(await recognizeLines(worker, standard.buffer, PSM.AUTO), assetId, fileHash, standard)
    : [];
  const firstPassBoxes = dedupeBoxes([...primaryBoxes, ...fallbackBoxes], assetId, fileHash);
  const firstPassAvg = avgConfidence(firstPassBoxes);
  const shouldRunHardPasses = firstPassBoxes.length === 0 || firstPassBoxes.length < 8 || firstPassAvg < 0.72;
  const contrastBoxes = shouldRunHardPasses
    ? buildBoxes(await recognizeLines(worker, contrast.buffer, PSM.SPARSE_TEXT), assetId, fileHash, contrast)
    : [];
  const binaryBoxes = shouldRunHardPasses
    ? buildBoxes(await recognizeLines(worker, binary.buffer, PSM.AUTO), assetId, fileHash, binary)
    : [];
  const boxes = dedupeBoxes([...firstPassBoxes, ...contrastBoxes, ...binaryBoxes], assetId, fileHash);

  writeCache(cacheFile, boxes, previousCache);
  return boxes;
}

export async function runOcr(filePath: string, assetId: string, fileHash: string): Promise<OcrBox[]> {
  fs.mkdirSync(cacheDir(), { recursive: true });
  const cacheFile = cacheFileFor(fileHash);
  if (fs.existsSync(cacheFile)) {
    const cached = readCache(cacheFile);
    if (cached) return cached.boxes.map((b) => ({ ...b, asset_id: assetId }));
  }

  const running = ocrInFlight.get(fileHash);
  if (running) {
    const boxes = await running;
    return boxes.map((box) => ({ ...box, asset_id: assetId }));
  }

  const task = runOcrUncached(filePath, assetId, fileHash, cacheFile);
  ocrInFlight.set(fileHash, task);
  try {
    const boxes = await task;
    return boxes.map((box) => ({ ...box, asset_id: assetId }));
  } finally {
    ocrInFlight.delete(fileHash);
  }
}
