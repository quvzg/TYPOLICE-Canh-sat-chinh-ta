import fs from "fs";
import path from "path";

export interface GuidelineUploadFile {
  name: string;
  original_name: string;
  size: number;
  uploaded_at: string;
  url: string;
}

interface StoredGuidelineUpload {
  name: string;
  original_name: string;
  size: number;
  uploaded_at: string;
}

const UPLOAD_FOLDER = "_uploads";
const META_FILE = "metadata.json";

function uploadsDir(guidelinesDir: string): string {
  return path.join(guidelinesDir, UPLOAD_FOLDER);
}

function metadataFile(guidelinesDir: string): string {
  return path.join(uploadsDir(guidelinesDir), META_FILE);
}

function cleanFilename(name: string): string {
  const base = path.basename(name || "guideline");
  const ext = path.extname(base).toLocaleLowerCase("vi-VN").replace(/[^a-z0-9.]/g, "");
  const stem = path.basename(base, path.extname(base))
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "guideline";
  return `${stem}${ext || ".txt"}`;
}

function withUrl(item: StoredGuidelineUpload): GuidelineUploadFile {
  return {
    ...item,
    url: `/api/brand-kit?file=${encodeURIComponent(item.name)}`,
  };
}

function readMetadata(guidelinesDir: string): StoredGuidelineUpload[] {
  try {
    const raw = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ metadataFile(guidelinesDir), "utf-8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is StoredGuidelineUpload =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as StoredGuidelineUpload).name === "string" &&
      typeof (item as StoredGuidelineUpload).original_name === "string" &&
      typeof (item as StoredGuidelineUpload).size === "number" &&
      typeof (item as StoredGuidelineUpload).uploaded_at === "string"
    );
  } catch {
    return [];
  }
}

function writeMetadata(guidelinesDir: string, items: StoredGuidelineUpload[]) {
  fs.mkdirSync(/* turbopackIgnore: true */ uploadsDir(guidelinesDir), { recursive: true });
  fs.writeFileSync(/* turbopackIgnore: true */ metadataFile(guidelinesDir), JSON.stringify(items, null, 2));
}

export function saveGuidelineUpload(guidelinesDir: string, file: File, buffer: Buffer): GuidelineUploadFile {
  const dir = uploadsDir(guidelinesDir);
  fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true });
  const safeName = cleanFilename(file.name);
  const storedName = `${Date.now().toString(36)}-${safeName}`;
  fs.writeFileSync(/* turbopackIgnore: true */ path.join(dir, storedName), buffer);

  const item: StoredGuidelineUpload = {
    name: storedName,
    original_name: file.name || safeName,
    size: buffer.byteLength,
    uploaded_at: new Date().toISOString(),
  };
  const next = [item, ...readMetadata(guidelinesDir)].slice(0, 12);
  writeMetadata(guidelinesDir, next);
  return withUrl(item);
}

export function listGuidelineUploads(guidelinesDir: string): GuidelineUploadFile[] {
  const dir = uploadsDir(guidelinesDir);
  return readMetadata(guidelinesDir)
    .filter((item) => fs.existsSync(/* turbopackIgnore: true */ path.join(dir, item.name)))
    .map(withUrl);
}

export function resolveGuidelineUpload(guidelinesDir: string, name: string): { path: string; file: GuidelineUploadFile } | null {
  const clean = path.basename(name);
  const file = listGuidelineUploads(guidelinesDir).find((item) => item.name === clean);
  if (!file) return null;
  const resolved = path.resolve(uploadsDir(guidelinesDir), clean);
  const root = path.resolve(uploadsDir(guidelinesDir));
  if (!resolved.startsWith(`${root}${path.sep}`)) return null;
  if (!fs.existsSync(/* turbopackIgnore: true */ resolved)) return null;
  return { path: resolved, file };
}

export function guidelineUploadContentType(filename: string): string {
  const ext = path.extname(filename).toLocaleLowerCase("vi-VN");
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".doc") return "application/msword";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === ".csv") return "text/csv; charset=utf-8";
  if (ext === ".md") return "text/markdown; charset=utf-8";
  if (ext === ".txt") return "text/plain; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}
