import path from "path";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";

export interface ParsedGuidelineUpload {
  files: {
    targetName: "brand_kit.json" | "terminology.csv" | "style_guide.md" | "tone_of_voice.md";
    content: string;
  }[];
  savedAs: string;
}

const MAX_STYLE_GUIDE_CHARS = 80_000;

function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function markdownFromText(filename: string, text: string): string {
  const cleaned = cleanText(text).slice(0, MAX_STYLE_GUIDE_CHARS);
  return `# Uploaded Guideline: ${filename}\n\n${cleaned}\n`;
}

function csvEscape(value: string): string {
  const trimmed = value.trim();
  return /[",\n]/.test(trimmed) ? `"${trimmed.replace(/"/g, '""')}"` : trimmed;
}

function pairsToCsv(pairs: [string, string][]): string {
  const rows = [["wrong", "correct"], ...pairs].map((row) => row.map(csvEscape).join(","));
  return `${rows.join("\n")}\n`;
}

function dedupePairs(pairs: [string, string][]): [string, string][] {
  const seen = new Set<string>();
  const result: [string, string][] = [];
  for (const [wrong, correct] of pairs) {
    const left = wrong.trim();
    const right = correct.trim();
    if (!left || !right || left === right) continue;
    if (left.length > 120 || right.length > 120) continue;
    const key = `${left.toLocaleLowerCase("vi-VN")}=>${right.toLocaleLowerCase("vi-VN")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push([left, right]);
  }
  return result;
}

function extractPairsFromText(text: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*•]\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(.{1,120}?)\s*(?:→|->|=>|>>)\s*(.{1,120})$/u);
    if (!match) continue;
    pairs.push([match[1], match[2]]);
  }
  return dedupePairs(pairs);
}

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("vi-VN")
    .replace(/\s+/g, " ");
}

function isWrongHeader(value: string): boolean {
  return /\b(wrong|incorrect|current|before|source|sai|lỗi|bản hiện tại|từ sai)\b/iu.test(value);
}

function isCorrectHeader(value: string): boolean {
  return /\b(correct|preferred|after|target|suggestion|update|đúng|sửa|bản update|từ đúng)\b/iu.test(value);
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const richText = (value as { richText?: { text?: string }[] }).richText;
    if (Array.isArray(richText)) return richText.map((part) => part.text ?? "").join("");
    const formula = (value as { result?: unknown }).result;
    if (formula !== undefined) return stringifyCell(formula);
    const text = (value as { text?: unknown }).text;
    if (text !== undefined) return stringifyCell(text);
    const hyperlink = (value as { hyperlink?: unknown }).hyperlink;
    if (hyperlink !== undefined) return stringifyCell(hyperlink);
  }
  return String(value).trim();
}

async function parseExcel(buffer: Buffer): Promise<{ markdown: string; pairs: [string, string][] }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sections: string[] = [];
  const pairs: [string, string][] = [];

  workbook.eachSheet((sheet) => {
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = Array.isArray(row.values) ? row.values.slice(1).map(stringifyCell) : [];
      const nonEmpty = values.map((v) => v.trim()).filter(Boolean);
      if (nonEmpty.length > 0) rows.push(nonEmpty);
    });
    if (rows.length === 0) return;

    sections.push(`## ${sheet.name}`);
    sections.push(rows.map((row) => `- ${row.join(" | ")}`).join("\n"));

    const header = rows[0].map(normalizeHeader);
    const wrongIndex = header.findIndex(isWrongHeader);
    const correctIndex = header.findIndex(isCorrectHeader);
    const sheetLooksLikeDictionary = /(term|terminology|dictionary|từ điển|glossary|spelling|brand)/iu.test(sheet.name);
    const hasPairHeaders = wrongIndex >= 0 && correctIndex >= 0 && wrongIndex !== correctIndex;

    for (const row of rows.slice(hasPairHeaders ? 1 : 0)) {
      if (hasPairHeaders) {
        pairs.push([row[wrongIndex] ?? "", row[correctIndex] ?? ""]);
      } else if (sheetLooksLikeDictionary && row.length === 2) {
        pairs.push([row[0], row[1]]);
      }
    }
  });

  return {
    markdown: cleanText(sections.join("\n\n")),
    pairs: dedupePairs(pairs),
  };
}

async function parsePdf(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return cleanText(result.text ?? "");
  } finally {
    await parser.destroy();
  }
}

async function parseWord(buffer: Buffer, ext: string): Promise<string> {
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ buffer });
    return cleanText(result.value ?? "");
  }

  const extractor = new WordExtractor();
  const doc = await extractor.extract(buffer);
  return cleanText(doc.getBody());
}

function parseJsonGuideline(content: string): ParsedGuidelineUpload {
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("brand kit JSON must be an object");
  }
  return {
    files: [{ targetName: "brand_kit.json", content: `${JSON.stringify(parsed, null, 2)}\n` }],
    savedAs: "brand_kit.json",
  };
}

function parseTextGuideline(filename: string, content: string, ext: string): ParsedGuidelineUpload {
  if (ext === ".csv") {
    return {
      files: [{ targetName: "terminology.csv", content: `${content.trimEnd()}\n` }],
      savedAs: "terminology.csv",
    };
  }

  const targetName = filename.toLocaleLowerCase("vi-VN").includes("tone") ? "tone_of_voice.md" : "style_guide.md";
  return {
    files: [{ targetName, content: `${content.trimEnd()}\n` }],
    savedAs: targetName,
  };
}

function parsedFromMarkdown(filename: string, text: string, preferredTarget?: "style_guide.md" | "tone_of_voice.md"): ParsedGuidelineUpload {
  const targetName = preferredTarget ?? (filename.toLocaleLowerCase("vi-VN").includes("tone") ? "tone_of_voice.md" : "style_guide.md");
  const pairs = extractPairsFromText(text);
  const files: ParsedGuidelineUpload["files"] = [{ targetName, content: markdownFromText(filename, text) }];
  if (pairs.length > 0) {
    files.push({ targetName: "terminology.csv", content: pairsToCsv(pairs) });
  }
  return {
    files,
    savedAs: files.map((file) => file.targetName).join(" + "),
  };
}

export async function parseGuidelineUpload(file: File): Promise<ParsedGuidelineUpload> {
  const filename = file.name || "guideline";
  const ext = path.extname(filename).toLocaleLowerCase("vi-VN");
  const buffer = Buffer.from(await file.arrayBuffer());

  if (ext === ".json") return parseJsonGuideline(buffer.toString("utf-8"));
  if (ext === ".csv" || ext === ".md" || ext === ".txt") {
    return parseTextGuideline(filename, buffer.toString("utf-8"), ext === ".txt" ? ".md" : ext);
  }
  if (ext === ".pdf") {
    const text = await parsePdf(buffer);
    if (!text) throw new Error("Không đọc được text trong PDF. Nếu PDF là ảnh scan, hãy export guideline sang DOCX/XLSX hoặc text PDF.");
    return parsedFromMarkdown(filename, text);
  }
  if (ext === ".docx" || ext === ".doc") {
    const text = await parseWord(buffer, ext);
    if (!text) throw new Error("Không đọc được text trong Word file.");
    return parsedFromMarkdown(filename, text);
  }
  if (ext === ".xlsx") {
    const parsed = await parseExcel(buffer);
    if (!parsed.markdown) throw new Error("Không đọc được nội dung trong Excel file.");
    const files: ParsedGuidelineUpload["files"] = [{
      targetName: "style_guide.md",
      content: markdownFromText(filename, parsed.markdown),
    }];
    if (parsed.pairs.length > 0) {
      files.push({ targetName: "terminology.csv", content: pairsToCsv(parsed.pairs) });
    }
    return {
      files,
      savedAs: files.map((file) => file.targetName).join(" + "),
    };
  }
  if (ext === ".xls") {
    throw new Error("File .xls quá cũ. Hãy lưu lại thành .xlsx rồi upload để Typolice đọc ổn định hơn.");
  }

  throw new Error("unsupported file type");
}
