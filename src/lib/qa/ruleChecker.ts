import type { BrandKit, Issue, IssueSeverity, IssueType } from "@/types";
import { findProtectedTermRanges, findUrlRanges, protectedTermsFromBrandKit, rangesOverlap, type TextRange } from "@/lib/qa/protectedText";

let counter = 0;
function nextId(prefix: string) {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

interface RuleHit {
  start: number;
  end: number;
  original: string;
  suggestion: string;
  type: IssueType;
  severity: IssueSeverity;
  reason: string;
  confidence: number;
  is_definite_error: boolean;
}

export interface DateFormatPattern {
  dayWidth: 1 | 2;
  monthWidth: 1 | 2;
  separator: "/" | "." | "-";
  yearWidth: 0 | 2 | 4;
}

export interface DateFormatToken {
  start: number;
  end: number;
  original: string;
  day: number;
  month: number;
  year: string | null;
  format: DateFormatPattern;
  formatKey: string;
}

const BUILTIN_TYPOS: Record<string, string> = {
  "mạnh mẻ": "mạnh mẽ",
  "mỡ ra": "mở ra",
  "khỏi động": "khởi động",
  "sẻ phát triển": "sẽ phát triển",
  "chỉnh chu": "chỉn chu",
  "xuất xắc": "xuất sắc",
  "khuyến mải": "khuyến mãi",
  "ưu đải": "ưu đãi",
  "trãi nghiệm": "trải nghiệm",
  "trãi qua": "trải qua",
  "registeration": "registration",
  "sucess": "success",
  "offical": "official",
  "Zal0pay": "Zalopay",
  "ZaIopay": "Zalopay",
  "Za1opay": "Zalopay",
  "GreenN0de": "GreenNode",
  "đốitượng": "đối tượng",
  "hìnhthức": "hình thức",
  "thờigian": "thời gian",
  "địađiểm": "địa điểm",
  "thamgia": "tham gia",
  "đăngký": "đăng ký",
  "sáng tạo ra": "sáng tạo ra", // identity entries are skipped below
};

const FIELD_LABEL_HINTS = [
  "đối tượng",
  "hình thức",
  "thời gian",
  "địa điểm",
  "nội dung",
  "chủ đề",
  "mục tiêu",
  "quyền lợi",
  "giải thưởng",
  "cách thức",
  "thể lệ",
  "điều kiện",
  "lưu ý",
  "tham gia",
  "deadline",
  "hạn chót",
  "timeline",
  "agenda",
  "link",
  "form",
  "đăng ký",
  "yêu cầu",
  "kết quả",
  "số lượng",
];

const FIELD_LABEL_PREFIXES = [
  "đối tượng tham gia",
  "hình thức tham gia",
  "thời gian đăng ký",
  "thời gian tham gia",
  "thời gian",
  "địa điểm",
  "nội dung",
  "chủ đề",
  "mục tiêu",
  "quyền lợi",
  "giải thưởng",
  "cách thức",
  "thể lệ",
  "điều kiện",
  "lưu ý",
  "deadline",
  "hạn chót",
  "timeline",
  "agenda",
  "link đăng ký",
  "link",
  "form đăng ký",
  "form",
  "yêu cầu",
  "kết quả",
  "số lượng",
].sort((a, b) => b.length - a.length);

const RELATIVE_DATE_WORDS = [
  "hôm nay",
  "ngày mai",
  "ngày mốt",
  "tối nay",
  "sáng mai",
  "chiều mai",
  "tuần này",
  "tuần sau",
];

const INTERNAL_ACRONYMS_TO_EXPLAIN = ["BU", "PM", "POC"];

const INTENTIONAL_CAMEL_CASE = new Set([
  "iphone",
  "ipad",
  "macos",
  "tiktok",
  "youtube",
  "linkedin",
  "vngcampus",
  "wordpress",
  "javascript",
  "typescript",
  "powerpoint",
  "openai",
  "greennode",
]);

const KNOWN_ACRONYMS = [
  "HTTPS",
  "HTTP",
  "JSON",
  "VNG",
  "API",
  "CSV",
  "URL",
  "OCR",
  "LLM",
  "QR",
  "UI",
  "UX",
  "AI",
].sort((a, b) => b.length - a.length);

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function phraseRegExp(phrase: string, flags = "giu"): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}_])`, flags);
}

function sentenceInitialRegExp(phrase: string): RegExp {
  return new RegExp(`(^|[.!?]\\s+)${escapeRegExp(phrase)}(?![\\p{L}\\p{N}_])`, "giu");
}

function preserveSimpleCase(original: string, suggestion: string): string {
  const firstLetter = original.match(/\p{L}/u)?.[0];
  if (!firstLetter) return suggestion;
  if (original === original.toLocaleUpperCase("vi-VN")) {
    return suggestion.toLocaleUpperCase("vi-VN");
  }
  if (firstLetter === firstLetter.toLocaleUpperCase("vi-VN")) {
    const index = suggestion.search(/\p{L}/u);
    if (index >= 0) {
      return `${suggestion.slice(0, index)}${suggestion[index].toLocaleUpperCase("vi-VN")}${suggestion.slice(index + 1)}`;
    }
  }
  return suggestion;
}

function normalizeTime(hourRaw: string, minuteRaw = "00"): string | null {
  const hour = Number.parseInt(hourRaw, 10);
  const minute = Number.parseInt(minuteRaw, 10);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function isCaptionLikeSource(sourceType: Issue["source_type"]) {
  return sourceType === "caption";
}

function isProbablyUrlPeriod(text: string, periodIndex: number): boolean {
  const around = text.slice(Math.max(0, periodIndex - 24), Math.min(text.length, periodIndex + 24));
  return /https?:\/\/|www\.|[\p{L}\p{N}_-]+\.[a-z]{2,}/iu.test(around);
}

function canonicalProtectedTerms(brandKit: BrandKit): string[] {
  return protectedTermsFromBrandKit(brandKit);
}

function isProtected(text: string, brandKit: BrandKit): boolean {
  const normalized = text.trim().toLocaleLowerCase("vi-VN");
  return canonicalProtectedTerms(brandKit).some(
    (term) => term.toLocaleLowerCase("vi-VN") === normalized
  );
}

function isCaseOnlyCorrection(original: string, suggestion: string): boolean {
  return original.toLocaleLowerCase("vi-VN") === suggestion.toLocaleLowerCase("vi-VN");
}

function hitRange(hit: RuleHit): TextRange {
  return { start: hit.start, end: hit.end };
}

function rangeContains(container: TextRange, inner: TextRange) {
  return inner.start >= container.start && inner.end <= container.end;
}

function isUrlFormatCleanup(hit: RuleHit) {
  return hit.reason.includes("Markdown") || /^Link\b/u.test(hit.reason);
}

function insertionAtTextEndHit(
  text: string,
  inserted: string,
  type: IssueType,
  severity: IssueSeverity,
  reason: string,
  confidence: number,
  isDefiniteError: boolean
): RuleHit | null {
  const end = text.trimEnd().length;
  if (end <= 0) return null;
  const start = end - 1;
  const original = text[start];
  const suggestion = /[.!?,;:]/.test(original)
    ? `${inserted}${original}`
    : `${original}${inserted}`;
  return {
    start,
    end,
    original,
    suggestion,
    type,
    severity,
    reason,
    confidence,
    is_definite_error: isDefiniteError,
  };
}

function bracketAndQuoteHits(text: string): RuleHit[] {
  const hits: RuleHit[] = [];
  const stack: { char: "(" | "["; index: number }[] = [];
  const matching: Record<string, "(" | "["> = { ")": "(", "]": "[" };
  const isNumberedListParen = (index: number) => {
    const lineStart = text.lastIndexOf("\n", index - 1) + 1;
    const before = text.slice(lineStart, index);
    const after = text[index + 1] ?? "";
    return /^\s*\d{1,3}$/.test(before) && /\s/.test(after);
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(" || ch === "[") {
      stack.push({ char: ch, index: i });
      continue;
    }
    if (ch !== ")" && ch !== "]") continue;
    if (ch === ")" && isNumberedListParen(i)) continue;
    const expected = matching[ch];
    const top = stack[stack.length - 1];
    if (top?.char === expected) {
      stack.pop();
      continue;
    }
    hits.push({
      start: i,
      end: i + 1,
      original: ch,
      suggestion: "",
      type: "punctuation",
      severity: "high",
      reason: `Dấu ${ch} bị đóng nhưng không có dấu mở tương ứng.`,
      confidence: 0.92,
      is_definite_error: true,
    });
  }

  if (stack.length > 0) {
    const missing = stack
      .slice()
      .reverse()
      .map((item) => (item.char === "(" ? ")" : "]"))
      .join("");
    const hit = insertionAtTextEndHit(
      text,
      missing,
      "punctuation",
      "high",
      `Thiếu dấu đóng ${missing} cho ngoặc đã mở.`,
      0.9,
      true
    );
    if (hit) hits.push(hit);
  }

  const quotePositions = (quote: "\"" | "'") => {
    const positions: number[] = [];
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] !== quote) continue;
      const prev = text[i - 1] ?? "";
      const next = text[i + 1] ?? "";
      if (quote === "'" && /\p{L}/u.test(prev) && /\p{L}/u.test(next)) continue;
      positions.push(i);
    }
    return positions;
  };

  for (const quote of ["\"", "'"] as const) {
    const positions = quotePositions(quote);
    if (positions.length % 2 === 0) continue;
    const hit = insertionAtTextEndHit(
      text,
      quote,
      "punctuation",
      quote === "\"" ? "high" : "medium",
      `Thiếu dấu đóng ${quote}.`,
      quote === "\"" ? 0.88 : 0.78,
      quote === "\""
    );
    if (hit) hits.push(hit);
  }

  return hits;
}

function isProbablyUrlToken(text: string, start: number, end: number): boolean {
  const around = text.slice(Math.max(0, start - 12), Math.min(text.length, end + 12));
  return /https?:\/\/|www\.|[\p{L}\p{N}_-]+\.[a-z]{2,}/iu.test(around);
}

function compactTerm(term: string): string {
  return term.replace(/\s+/g, "");
}

function camelCaseCollisionHits(text: string, brandKit: BrandKit): RuleHit[] {
  const hits: RuleHit[] = [];
  const terms = canonicalProtectedTerms(brandKit);

  const compactToCanonical = new Map<string, string>();
  for (const term of terms) {
    if (!/\s/.test(term)) continue;
    compactToCanonical.set(compactTerm(term).toLocaleLowerCase("vi-VN"), term);
  }

  for (const m of text.matchAll(/(?<![#\p{L}\p{N}_])[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*(?![\p{L}\p{N}_])/gu)) {
    const token = m[0];
    const start = m.index!;
    if (token.length < 5 || isProbablyUrlToken(text, start, start + token.length)) continue;
    if (isProtected(token, brandKit)) continue;
    if (INTENTIONAL_CAMEL_CASE.has(token.toLocaleLowerCase("vi-VN"))) continue;

    const canonical = compactToCanonical.get(token.toLocaleLowerCase("vi-VN"));
    if (canonical && canonical !== token) {
      hits.push({
        start,
        end: start + token.length,
        original: token,
        suggestion: canonical,
        type: "spacing",
        severity: "medium",
        reason: "Thiếu khoảng trắng giữa các phần của tên/cụm từ chuẩn.",
        confidence: 0.94,
        is_definite_error: true,
      });
      continue;
    }

    for (const acronym of KNOWN_ACRONYMS) {
      if (!token.startsWith(acronym) || token.length <= acronym.length + 2) continue;
      const rest = token.slice(acronym.length);
      if (!/^\p{Lu}[\p{L}\p{N}-]+$/u.test(rest)) continue;
      hits.push({
        start,
        end: start + token.length,
        original: token,
        suggestion: `${acronym} ${rest}`,
        type: "spacing",
        severity: "medium",
        reason: `Thiếu khoảng trắng sau acronym ${acronym}.`,
        confidence: 0.9,
        is_definite_error: true,
      });
      break;
    }
  }

  return hits;
}

function dateFormatKey(format: DateFormatPattern): string {
  return `${format.dayWidth}${format.separator}${format.monthWidth}${format.yearWidth}`;
}

export function dateFormatLabel(format: DateFormatPattern): string {
  const day = format.dayWidth === 2 ? "DD" : "D";
  const month = format.monthWidth === 2 ? "MM" : "M";
  const year = format.yearWidth === 4 ? `${format.separator}YYYY` : format.yearWidth === 2 ? `${format.separator}YY` : "";
  return `${day}${format.separator}${month}${year}`;
}

export function formatDateToken(token: DateFormatToken, standard: DateFormatPattern): string {
  const day = standard.dayWidth === 2 ? String(token.day).padStart(2, "0") : String(token.day);
  const month = standard.monthWidth === 2 ? String(token.month).padStart(2, "0") : String(token.month);
  if (!token.year) return `${day}${standard.separator}${month}`;
  const year = standard.yearWidth === 2 && token.year.length === 4
    ? token.year.slice(-2)
    : standard.yearWidth === 4 && token.year.length === 2
      ? `20${token.year}`
      : token.year;
  return `${day}${standard.separator}${month}${standard.separator}${year}`;
}

export function findDateFormatTokens(text: string): DateFormatToken[] {
  const tokens: DateFormatToken[] = [];
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})([./-])(\d{1,2})(?:\2(\d{4}|\d{2}))?(?!\d)/g)) {
    const separator = m[2] === "/" || m[2] === "." || m[2] === "-" ? m[2] : null;
    if (!separator) continue;
    const day = Number.parseInt(m[1], 10);
    const month = Number.parseInt(m[3], 10);
    if (!Number.isInteger(day) || !Number.isInteger(month)) continue;
    if (day < 1 || day > 31 || month < 1 || month > 12) continue;
    const year = m[4] ?? null;
    const format: DateFormatPattern = {
      dayWidth: m[1].length >= 2 ? 2 : 1,
      monthWidth: m[3].length >= 2 ? 2 : 1,
      separator,
      yearWidth: year ? (year.length === 4 ? 4 : 2) : 0,
    };
    tokens.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      day,
      month,
      year,
      format,
      formatKey: dateFormatKey(format),
    });
  }
  return tokens;
}

export function chooseDateFormatStandard(tokens: DateFormatToken[]): DateFormatPattern | null {
  if (tokens.length < 2) return null;
  const groups = new Map<string, { count: number; firstIndex: number; format: DateFormatPattern }>();
  for (const token of tokens) {
    const current = groups.get(token.formatKey);
    if (current) {
      current.count += 1;
      current.firstIndex = Math.min(current.firstIndex, token.start);
    } else {
      groups.set(token.formatKey, { count: 1, firstIndex: token.start, format: token.format });
    }
  }
  if (groups.size < 2) return null;
  return [...groups.values()].sort((a, b) => b.count - a.count || a.firstIndex - b.firstIndex)[0].format;
}

function dateConsistencyHits(text: string): RuleHit[] {
  const tokens = findDateFormatTokens(text);
  const standard = chooseDateFormatStandard(tokens);
  if (!standard) return [];
  const standardKey = dateFormatKey(standard);
  return tokens
    .filter((token) => token.formatKey !== standardKey)
    .map((token) => ({
      start: token.start,
      end: token.end,
      original: token.original,
      suggestion: formatDateToken(token, standard),
      type: "style" as const,
      severity: "medium" as const,
      reason: `Format ngày tháng không đồng bộ. Nên dùng thống nhất dạng ${dateFormatLabel(standard)} trong cùng nội dung.`,
      confidence: 0.9,
      is_definite_error: false,
    }));
}

interface TextVariant {
  key: string;
  pattern: RegExp;
}

interface TextVariantGroup {
  label: string;
  canonical: string;
  canonicalKey: string;
  variants: TextVariant[];
}

const TEXT_VARIANT_GROUPS: TextVariantGroup[] = [
  {
    label: "công ty",
    canonical: "công ty",
    canonicalKey: "full",
    variants: [
      { key: "short", pattern: /(?<![\p{L}\p{N}_])(?:cty|c\.ty)(?![\p{L}\p{N}_])/giu },
      { key: "full", pattern: /(?<![\p{L}\p{N}_])công\s+ty(?![\p{L}\p{N}_])/giu },
    ],
  },
  {
    label: "thành phố",
    canonical: "thành phố",
    canonicalKey: "full",
    variants: [
      { key: "short", pattern: /(?<![\p{L}\p{N}_])tp\.?(?![\p{L}\p{N}_])/giu },
      { key: "full", pattern: /(?<![\p{L}\p{N}_])thành\s+phố(?![\p{L}\p{N}_])/giu },
    ],
  },
  {
    label: "TP.HCM",
    canonical: "TP.HCM",
    canonicalKey: "canonical",
    variants: [
      { key: "compact", pattern: /(?<![\p{L}\p{N}_])tphcm(?![\p{L}\p{N}_])/giu },
      { key: "spaced", pattern: /(?<![\p{L}\p{N}_])tp\.?\s+hcm(?![\p{L}\p{N}_])/giu },
      { key: "long", pattern: /(?<![\p{L}\p{N}_])(?:thành\s+phố|tp\.?)\s+hồ\s+chí\s+minh(?![\p{L}\p{N}_])/giu },
      { key: "canonical", pattern: /(?<![\p{L}\p{N}_])tp\.hcm(?![\p{L}\p{N}_])/giu },
    ],
  },
  {
    label: "Hà Nội",
    canonical: "Hà Nội",
    canonicalKey: "full",
    variants: [
      { key: "short", pattern: /(?<![\p{L}\p{N}_])hn(?![\p{L}\p{N}_])/giu },
      { key: "full", pattern: /(?<![\p{L}\p{N}_])hà\s+nội(?![\p{L}\p{N}_])/giu },
    ],
  },
  {
    label: "nhân viên",
    canonical: "nhân viên",
    canonicalKey: "full",
    variants: [
      { key: "short", pattern: /(?<![\p{L}\p{N}_])nv(?![\p{L}\p{N}_])/giu },
      { key: "full", pattern: /(?<![\p{L}\p{N}_])nhân\s+viên(?![\p{L}\p{N}_])/giu },
    ],
  },
  {
    label: "sinh viên",
    canonical: "sinh viên",
    canonicalKey: "full",
    variants: [
      { key: "short", pattern: /(?<![\p{L}\p{N}_])sv(?![\p{L}\p{N}_])/giu },
      { key: "full", pattern: /(?<![\p{L}\p{N}_])sinh\s+viên(?![\p{L}\p{N}_])/giu },
    ],
  },
  {
    label: "cộng tác viên",
    canonical: "cộng tác viên",
    canonicalKey: "full",
    variants: [
      { key: "short", pattern: /(?<![\p{L}\p{N}_])ctv(?![\p{L}\p{N}_])/giu },
      { key: "full", pattern: /(?<![\p{L}\p{N}_])cộng\s+tác\s+viên(?![\p{L}\p{N}_])/giu },
    ],
  },
  {
    label: "đăng ký",
    canonical: "đăng ký",
    canonicalKey: "full",
    variants: [
      { key: "short", pattern: /(?<![\p{L}\p{N}_])(?:đk|dk)(?![\p{L}\p{N}_])/giu },
      { key: "full", pattern: /(?<![\p{L}\p{N}_])đăng\s+ký(?![\p{L}\p{N}_])/giu },
    ],
  },
  {
    label: "Facebook",
    canonical: "Facebook",
    canonicalKey: "full",
    variants: [
      { key: "short", pattern: /(?<![\p{L}\p{N}_])fb(?![\p{L}\p{N}_])/giu },
      { key: "full", pattern: /(?<![\p{L}\p{N}_])facebook(?![\p{L}\p{N}_])/giu },
    ],
  },
  {
    label: "Instagram",
    canonical: "Instagram",
    canonicalKey: "full",
    variants: [
      { key: "short", pattern: /(?<![\p{L}\p{N}_])ig(?![\p{L}\p{N}_])/giu },
      { key: "full", pattern: /(?<![\p{L}\p{N}_])instagram(?![\p{L}\p{N}_])/giu },
    ],
  },
  {
    label: "thương mại điện tử",
    canonical: "thương mại điện tử",
    canonicalKey: "full",
    variants: [
      { key: "short", pattern: /(?<![\p{L}\p{N}_])(?:tmđt|tmdt)(?![\p{L}\p{N}_])/giu },
      { key: "full", pattern: /(?<![\p{L}\p{N}_])thương\s+mại\s+điện\s+tử(?![\p{L}\p{N}_])/giu },
    ],
  },
  {
    label: "công nghệ thông tin",
    canonical: "công nghệ thông tin",
    canonicalKey: "full",
    variants: [
      { key: "short", pattern: /(?<![\p{L}\p{N}_])cntt(?![\p{L}\p{N}_])/giu },
      { key: "full", pattern: /(?<![\p{L}\p{N}_])công\s+nghệ\s+thông\s+tin(?![\p{L}\p{N}_])/giu },
    ],
  },
  {
    label: "ban tổ chức",
    canonical: "ban tổ chức",
    canonicalKey: "full",
    variants: [
      { key: "short", pattern: /(?<![\p{L}\p{N}_])btc(?![\p{L}\p{N}_])/giu },
      { key: "full", pattern: /(?<![\p{L}\p{N}_])ban\s+tổ\s+chức(?![\p{L}\p{N}_])/giu },
    ],
  },
  {
    label: "câu lạc bộ",
    canonical: "câu lạc bộ",
    canonicalKey: "full",
    variants: [
      { key: "short", pattern: /(?<![\p{L}\p{N}_])clb(?![\p{L}\p{N}_])/giu },
      { key: "full", pattern: /(?<![\p{L}\p{N}_])câu\s+lạc\s+bộ(?![\p{L}\p{N}_])/giu },
    ],
  },
  {
    label: "đại học",
    canonical: "đại học",
    canonicalKey: "full",
    variants: [
      { key: "short", pattern: /(?<![\p{L}\p{N}_])(?:đh|dh)(?![\p{L}\p{N}_])/giu },
      { key: "full", pattern: /(?<![\p{L}\p{N}_])đại\s+học(?![\p{L}\p{N}_])/giu },
    ],
  },
];

function normalizedVariant(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("vi-VN").replace(/\s+/g, " ").trim();
}

function lineForIndex(text: string, index: number) {
  const lineStart = text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const lineEndRaw = text.indexOf("\n", index);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  return text.slice(lineStart, lineEnd).trim();
}

function isLikelyHeadingAt(text: string, index: number): boolean {
  const line = lineForIndex(text, index);
  if (!line) return false;
  const words = line.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0 || words.length > 14 || line.length > 120) return false;
  if (/[:;]|\bhttps?:\/\//iu.test(line)) return false;
  const firstNonEmpty = text.split("\n").find((item) => item.trim().length > 0)?.trim();
  if (firstNonEmpty === line) return true;
  const letters = line.match(/\p{L}/gu) ?? [];
  if (letters.length < 4) return false;
  const upperLetters = letters.filter((letter) => letter === letter.toLocaleUpperCase("vi-VN")).length;
  return upperLetters / letters.length >= 0.65;
}

function isUppercaseLetter(letter: string) {
  return letter === letter.toLocaleUpperCase("vi-VN") && letter !== letter.toLocaleLowerCase("vi-VN");
}

function isLowercaseLetter(letter: string) {
  return letter === letter.toLocaleLowerCase("vi-VN") && letter !== letter.toLocaleUpperCase("vi-VN");
}

function rangeOverlapsAny(range: TextRange, ranges: TextRange[]) {
  return ranges.some((item) => rangesOverlap(range, item));
}

function uppercaseHeadingStats(line: string, lineStart: number, excludedRanges: TextRange[]) {
  let upper = 0;
  let lower = 0;
  for (const match of line.matchAll(/\p{L}/gu)) {
    const index = lineStart + match.index!;
    if (rangeOverlapsAny({ start: index, end: index + match[0].length }, excludedRanges)) continue;
    if (isUppercaseLetter(match[0])) upper += 1;
    if (isLowercaseLetter(match[0])) lower += 1;
  }
  return { upper, lower, total: upper + lower };
}

function isUppercaseStyleHeadingLine(
  text: string,
  line: string,
  lineStart: number,
  excludedRanges: TextRange[]
) {
  if (!line || !isLikelyHeadingAt(text, lineStart)) return false;
  const words = line.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0 || words.length > 14 || line.length > 120) return false;
  if (/[:;]|\bhttps?:\/\//iu.test(line)) return false;
  const stats = uppercaseHeadingStats(line, lineStart, excludedRanges);
  return stats.total >= 4 && stats.upper >= 4 && stats.upper / stats.total >= 0.65;
}

function isUppercaseStyleHeadingAt(
  text: string,
  start: number,
  end: number,
  excludedRanges: TextRange[]
) {
  const lineStart = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const lineEndRaw = text.indexOf("\n", start);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  const line = text.slice(lineStart, lineEnd).trim();
  const trimOffset = text.slice(lineStart, lineEnd).search(/\S/u);
  if (trimOffset < 0) return false;
  if (!isUppercaseStyleHeadingLine(text, line, lineStart + trimOffset, excludedRanges)) return false;
  return start >= lineStart && end <= lineEnd;
}

function headingUppercaseConsistencyHits(text: string, brandKit: BrandKit): RuleHit[] {
  const hits: RuleHit[] = [];
  const excludedRanges = [
    ...findUrlRanges(text),
    ...findProtectedTermRanges(text, canonicalProtectedTerms(brandKit)),
  ];

  forEachLine(text, (rawLine, offset) => {
    const trimOffset = rawLine.search(/\S/u);
    if (trimOffset < 0) return;
    const line = rawLine.trim();
    const lineStart = offset + trimOffset;
    if (!isUppercaseStyleHeadingLine(text, line, lineStart, excludedRanges)) return;

    for (const match of line.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu)) {
      const start = lineStart + match.index!;
      const end = start + match[0].length;
      if (rangeOverlapsAny({ start, end }, excludedRanges)) continue;
      const letters = match[0].match(/\p{L}/gu) ?? [];
      if (!letters.some(isLowercaseLetter)) continue;
      hits.push({
        start,
        end,
        original: match[0],
        suggestion: match[0].toLocaleUpperCase("vi-VN"),
        type: "style",
        severity: "medium",
        reason: "Heading đang dùng format viết hoa, nên các chữ trong heading cần đồng bộ uppercase.",
        confidence: 0.9,
        is_definite_error: false,
      });
    }
  });

  return hits;
}

function hasFixedCanonicalCase(value: string) {
  return /[A-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚĂĐĨŨƠƯẠ-ỹ]*[A-Z][a-zà-ỹ]+[A-Z]|[A-Z]{2,}|\./u.test(value);
}

function isCanonicalProtectedSuggestion(suggestion: string, brandKit: BrandKit) {
  const normalized = suggestion.trim().toLocaleLowerCase("vi-VN");
  return canonicalProtectedTerms(brandKit).some((term) => term.toLocaleLowerCase("vi-VN") === normalized);
}

function formatCorrectionSuggestion(
  text: string,
  start: number,
  end: number,
  original: string,
  suggestion: string,
  brandKit: BrandKit
) {
  if (isCanonicalProtectedSuggestion(suggestion, brandKit) || hasFixedCanonicalCase(suggestion)) return suggestion;
  const excludedRanges = [
    ...findUrlRanges(text),
    ...findProtectedTermRanges(text, canonicalProtectedTerms(brandKit)),
  ];
  if (isUppercaseStyleHeadingAt(text, start, end, excludedRanges)) {
    return suggestion.toLocaleUpperCase("vi-VN");
  }
  return preserveSimpleCase(original, suggestion);
}

function formatDictionarySuggestion(
  text: string,
  start: number,
  end: number,
  suggestion: string,
  brandKit: BrandKit
) {
  if (isCanonicalProtectedSuggestion(suggestion, brandKit) || hasFixedCanonicalCase(suggestion)) return suggestion;
  const excludedRanges = [
    ...findUrlRanges(text),
    ...findProtectedTermRanges(text, canonicalProtectedTerms(brandKit)),
  ];
  if (isUppercaseStyleHeadingAt(text, start, end, excludedRanges)) {
    return suggestion.toLocaleUpperCase("vi-VN");
  }
  return suggestion;
}

function formatTextVariantSuggestion(original: string, canonical: string, text?: string, start?: number) {
  if (hasFixedCanonicalCase(canonical)) return canonical;
  if (text && start !== undefined && isUppercaseStyleHeadingAt(text, start, start + original.length, [
    ...findUrlRanges(text),
  ])) {
    return canonical.toLocaleUpperCase("vi-VN");
  }
  const firstLetter = original.match(/\p{L}/u)?.[0];
  if (firstLetter && firstLetter === firstLetter.toLocaleUpperCase("vi-VN")) {
    const index = canonical.search(/\p{L}/u);
    if (index >= 0) {
      return `${canonical.slice(0, index)}${canonical[index].toLocaleUpperCase("vi-VN")}${canonical.slice(index + 1)}`;
    }
  }
  return canonical;
}

function textVariantConsistencyHits(text: string): RuleHit[] {
  const hits: RuleHit[] = [];

  for (const group of TEXT_VARIANT_GROUPS) {
    const occurrences: { key: string; start: number; end: number; original: string }[] = [];
    for (const variant of group.variants) {
      variant.pattern.lastIndex = 0;
      for (const match of text.matchAll(variant.pattern)) {
        const start = match.index!;
        const end = start + match[0].length;
        if (occurrences.some((item) => start < item.end && item.start < end)) continue;
        occurrences.push({ key: variant.key, start, end, original: match[0] });
      }
    }

    const distinctForms = new Set(occurrences.map((item) => item.key));
    if (distinctForms.size < 2) continue;

    for (const occurrence of occurrences) {
      if (occurrence.key === group.canonicalKey) continue;
      const suggestion = formatTextVariantSuggestion(occurrence.original, group.canonical, text, occurrence.start);
      if (normalizedVariant(occurrence.original) === normalizedVariant(suggestion)) continue;
      const inHeading = isLikelyHeadingAt(text, occurrence.start);
      hits.push({
        start: occurrence.start,
        end: occurrence.end,
        original: occurrence.original,
        suggestion,
        type: "style",
        severity: inHeading ? "medium" : "low",
        reason: inHeading
          ? `Heading đang dùng cách viết ${group.label} không đồng bộ với phần còn lại.`
          : `Cách viết ${group.label} chưa đồng bộ trong cùng nội dung.`,
        confidence: inHeading ? 0.88 : 0.82,
        is_definite_error: false,
      });
    }
  }

  return hits;
}

function cleanFieldLabel(label: string): string {
  return label
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("vi-VN");
}

function isLikelyFieldLabel(label: string): boolean {
  const cleaned = cleanFieldLabel(label);
  if (!cleaned) return false;
  const words = cleaned.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length < 1 || words.length > 7 || cleaned.length > 64) return false;
  if (/[.!?]/.test(cleaned)) return false;
  return FIELD_LABEL_HINTS.some((hint) => cleaned.includes(hint));
}

function fieldLabelColonHits(text: string): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const line of text.matchAll(/[^\n]+/g)) {
    const lineText = line[0];
    const semicolonIndex = lineText.indexOf(";");
    if (semicolonIndex <= 0) continue;
    const before = lineText.slice(0, semicolonIndex);
    const labelCandidate = before.split(/[.!?]/).pop() ?? before;
    const after = lineText.slice(semicolonIndex + 1);
    if (!after.trim() || !isLikelyFieldLabel(labelCandidate)) continue;
    const start = line.index! + semicolonIndex;
    const firstAfter = after.match(/\S/);
    const afterOffset = firstAfter?.index ?? -1;
    if (afterOffset === 0) {
      hits.push({
        start,
        end: start + 2,
        original: lineText.slice(semicolonIndex, semicolonIndex + 2),
        suggestion: `: ${lineText[semicolonIndex + 1]}`,
        type: "punctuation",
        severity: "high",
        reason: "Sau nhãn thông tin nên dùng dấu hai chấm và một khoảng trắng.",
        confidence: 0.95,
        is_definite_error: true,
      });
      continue;
    }
    hits.push({
      start,
      end: start + 1,
      original: ";",
      suggestion: ":",
      type: "punctuation",
      severity: "high",
      reason: "Sau nhãn thông tin nên dùng dấu hai chấm, không dùng dấu chấm phẩy.",
      confidence: 0.94,
      is_definite_error: true,
    });
  }
  return hits;
}

function dateStandardizationHits(text: string): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})([.-])(\d{1,2})\2(\d{4})(?!\d)/g)) {
    const day = Number.parseInt(m[1], 10);
    const month = Number.parseInt(m[3], 10);
    if (day < 1 || day > 31 || month < 1 || month > 12) continue;
    const suggestion = `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${m[4]}`;
    if (m[0] === suggestion) continue;
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion,
      type: "style",
      severity: "medium",
      reason: "Định dạng ngày nên dùng DD/MM/YYYY theo guideline.",
      confidence: 0.93,
      is_definite_error: true,
    });
  }
  return hits;
}

function timeFormatHits(text: string): RuleHit[] {
  const hits: RuleHit[] = [];
  const pushTime = (match: RegExpMatchArray, suggestion: string | null) => {
    if (!suggestion || match[0] === suggestion) return;
    hits.push({
      start: match.index!,
      end: match.index! + match[0].length,
      original: match[0],
      suggestion,
      type: "style",
      severity: "medium",
      reason: "Định dạng giờ nên dùng HH:mm theo guideline.",
      confidence: 0.93,
      is_definite_error: true,
    });
  };

  for (const m of text.matchAll(/(?<![\p{L}\p{N}])(\d{1,2})h(\d{2})(?![\p{L}\p{N}])/giu)) {
    pushTime(m, normalizeTime(m[1], m[2]));
  }
  for (const m of text.matchAll(/(?<![\p{L}\p{N}])(\d{1,2})h(?![\p{L}\p{N}])/giu)) {
    if (hits.some((h) => m.index! >= h.start && m.index! + m[0].length <= h.end)) continue;
    pushTime(m, normalizeTime(m[1]));
  }
  for (const m of text.matchAll(/(?<![\p{L}\p{N}])(\d{1,2})\s+giờ\s+(\d{1,2})(?![\p{L}\p{N}])/giu)) {
    pushTime(m, normalizeTime(m[1], m[2]));
  }
  for (const m of text.matchAll(/(?<![\p{L}\p{N}])(\d{1,2})\s+giờ(?![\p{L}\p{N}])/giu)) {
    if (hits.some((h) => m.index! >= h.start && m.index! + m[0].length <= h.end)) continue;
    pushTime(m, normalizeTime(m[1]));
  }
  for (const m of text.matchAll(/(?<![\p{L}\p{N}])(\d):(\d{2})(?![\p{L}\p{N}])/gu)) {
    pushTime(m, normalizeTime(m[1], m[2]));
  }

  return hits;
}

function forEachLine(text: string, cb: (line: string, offset: number) => void) {
  let offset = 0;
  for (const line of text.split("\n")) {
    cb(line, offset);
    offset += line.length + 1;
  }
}

function lineHygieneHits(text: string): RuleHit[] {
  const hits: RuleHit[] = [];
  const seenLines = new Map<string, number>();

  for (const m of text.matchAll(/\n{3,}/g)) {
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: "\n\n",
      type: "spacing",
      severity: "low",
      reason: "Không nên để quá nhiều dòng trống liên tiếp.",
      confidence: 0.96,
      is_definite_error: true,
    });
  }

  forEachLine(text, (line, offset) => {
    if (line.length === 0) return;
    const leading = line.match(/^[ \t]+/);
    if (leading?.[0]) {
      hits.push({
        start: offset,
        end: offset + leading[0].length,
        original: leading[0],
        suggestion: "",
        type: "spacing",
        severity: "low",
        reason: "Dòng này đang dư khoảng trắng ở đầu.",
        confidence: 0.97,
        is_definite_error: true,
      });
    }
    const trailing = line.match(/[ \t]+$/);
    if (trailing?.[0] && trailing.index !== undefined) {
      hits.push({
        start: offset + trailing.index,
        end: offset + trailing.index + trailing[0].length,
        original: trailing[0],
        suggestion: "",
        type: "spacing",
        severity: "low",
        reason: "Dòng này đang dư khoảng trắng ở cuối.",
        confidence: 0.97,
        is_definite_error: true,
      });
    }

    const trimmed = line.trim();
    if (/^(?:-{3,}|\*{3,}|~{3,}|_{3,})$/.test(trimmed)) {
      hits.push({
        start: offset + line.indexOf(trimmed),
        end: offset + line.indexOf(trimmed) + trimmed.length,
        original: trimmed,
        suggestion: "",
        type: "style",
        severity: "low",
        reason: "Dòng này giống ký tự phân cách/paste artifact, nên bỏ nếu không phải nội dung.",
        confidence: 0.9,
        is_definite_error: true,
      });
    }

    const normalized = trimmed.replace(/\s+/g, " ").toLocaleLowerCase("vi-VN");
    if (normalized.length < 8) return;
    const previous = seenLines.get(normalized);
    if (previous !== undefined) {
      hits.push({
        start: offset + line.indexOf(trimmed),
        end: offset + line.indexOf(trimmed) + trimmed.length,
        original: trimmed,
        suggestion: "",
        type: "grammar",
        severity: "medium",
        reason: "Dòng nội dung này bị lặp lại.",
        confidence: 0.9,
        is_definite_error: true,
      });
    } else {
      seenLines.set(normalized, offset);
    }
  });

  return hits;
}

function duplicatePhraseHits(text: string): RuleHit[] {
  const hits: RuleHit[] = [];
  forEachLine(text, (line, offset) => {
    const words = [...line.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
      text: match[0].toLocaleLowerCase("vi-VN"),
      start: match.index!,
      end: match.index! + match[0].length,
    }));
    for (let size = 5; size >= 2; size -= 1) {
      for (let i = 0; i + size * 2 <= words.length; i += 1) {
        const first = words.slice(i, i + size);
        const second = words.slice(i + size, i + size * 2);
        if (!first.every((word, index) => word.text === second[index].text)) continue;
        const firstStart = first[0].start;
        const firstEnd = first[first.length - 1].end;
        const secondStart = second[0].start;
        const secondEnd = second[second.length - 1].end;
        if (!/^[ \t]+$/.test(line.slice(firstEnd, secondStart))) continue;
        hits.push({
          start: offset + firstStart,
          end: offset + secondEnd,
          original: line.slice(firstStart, secondEnd),
          suggestion: line.slice(firstStart, firstEnd),
          type: "grammar",
          severity: "medium",
          reason: "Cụm từ bị lặp lại.",
          confidence: 0.88,
          is_definite_error: true,
        });
      }
    }
  });
  return hits;
}

function listMarkerHits(text: string): RuleHit[] {
  const hits: RuleHit[] = [];

  for (const m of text.matchAll(/(^|\n)(\p{Extended_Pictographic})(?=[\p{L}\p{N}#@])/gu)) {
    const start = m.index! + m[1].length;
    hits.push({
      start,
      end: start + m[2].length,
      original: m[2],
      suggestion: `${m[2]} `,
      type: "spacing",
      severity: "low",
      reason: "Nên có khoảng trắng sau emoji/bullet ở đầu dòng.",
      confidence: 0.92,
      is_definite_error: true,
    });
  }

  for (const m of text.matchAll(/(^|\n)([-*•+])(?=[\p{L}\p{N}#@])/gu)) {
    const start = m.index! + m[1].length;
    hits.push({
      start,
      end: start + m[2].length,
      original: m[2],
      suggestion: `${m[2]} `,
      type: "spacing",
      severity: "low",
      reason: "Nên có khoảng trắng sau ký hiệu bullet.",
      confidence: 0.95,
      is_definite_error: true,
    });
  }

  for (const m of text.matchAll(/(^|\n)(\d{1,2}[.)])(?=[\p{L}#@])/gu)) {
    const start = m.index! + m[1].length;
    hits.push({
      start,
      end: start + m[2].length,
      original: m[2],
      suggestion: `${m[2]} `,
      type: "spacing",
      severity: "low",
      reason: "Nên có khoảng trắng sau số thứ tự.",
      confidence: 0.95,
      is_definite_error: true,
    });
  }

  return hits;
}

function mostCommon<T extends string>(items: T[]): T | null {
  if (items.length === 0) return null;
  const counts = new Map<T, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function listConsistencyHits(text: string): RuleHit[] {
  const hits: RuleHit[] = [];
  const numbered: { start: number; original: string; number: string; delimiter: "." | ")" }[] = [];
  const bullets: { start: number; marker: string }[] = [];

  forEachLine(text, (line, offset) => {
    const numberedMatch = line.match(/^(\s*)(\d{1,3})([.)])\s+/);
    if (numberedMatch) {
      numbered.push({
        start: offset + numberedMatch[1].length,
        original: `${numberedMatch[2]}${numberedMatch[3]}`,
        number: numberedMatch[2],
        delimiter: numberedMatch[3] as "." | ")",
      });
    }
    const bulletMatch = line.match(/^(\s*)([-*•+])\s+/);
    if (bulletMatch) {
      bullets.push({
        start: offset + bulletMatch[1].length,
        marker: bulletMatch[2],
      });
    }
  });

  const delimiter = mostCommon(numbered.map((item) => item.delimiter));
  const hasMixedDelimiter = new Set(numbered.map((item) => item.delimiter)).size > 1;
  const hasMixedZeroPadding = new Set(numbered.map((item) => (item.number.length > 1 && item.number.startsWith("0") ? "padded" : "plain"))).size > 1;
  if (numbered.length >= 2 && delimiter && (hasMixedDelimiter || hasMixedZeroPadding)) {
    for (const item of numbered) {
      const normalizedNumber = hasMixedZeroPadding ? String(Number.parseInt(item.number, 10)) : item.number;
      const suggestion = `${normalizedNumber}${delimiter}`;
      if (suggestion === item.original) continue;
      hits.push({
        start: item.start,
        end: item.start + item.original.length,
        original: item.original,
        suggestion,
        type: "style",
        severity: "low",
        reason: "Format số thứ tự trong cùng một danh sách chưa đồng bộ.",
        confidence: 0.78,
        is_definite_error: false,
      });
    }
  }

  const bulletMarker = mostCommon(bullets.map((item) => item.marker));
  if (bullets.length >= 2 && bulletMarker && new Set(bullets.map((item) => item.marker)).size > 1) {
    for (const item of bullets) {
      if (item.marker === bulletMarker) continue;
      hits.push({
        start: item.start,
        end: item.start + item.marker.length,
        original: item.marker,
        suggestion: bulletMarker,
        type: "style",
        severity: "low",
        reason: "Ký hiệu bullet trong cùng một danh sách chưa đồng bộ.",
        confidence: 0.78,
        is_definite_error: false,
      });
    }
  }

  return hits;
}

function looksLikeFieldValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^(\d|https?:\/\/|www\.|@|#)/iu.test(trimmed)
    || /^(online|offline|hybrid|cá nhân|nhóm|tất cả|vng|zalopay|facebook|linkedin|google|starter|internal|external)\b/iu.test(trimmed)
    || /^[\p{Lu}\p{Extended_Pictographic}]/u.test(trimmed);
}

function fieldLabelFormatHits(text: string): RuleHit[] {
  const hits: RuleHit[] = [];

  forEachLine(text, (line, offset) => {
    const extraSpace = line.match(/^(\s*)([^:\n]{1,80}?)\s+:(\s*)(.+)$/u);
    if (extraSpace && isLikelyFieldLabel(extraSpace[2])) {
      const labelStart = offset + extraSpace[1].length;
      const original = `${extraSpace[2]}${line.slice(extraSpace[1].length + extraSpace[2].length, extraSpace[0].length - extraSpace[4].length)}${extraSpace[4]}`;
      hits.push({
        start: labelStart,
        end: labelStart + original.length,
        original,
        suggestion: `${extraSpace[2]}: ${extraSpace[4].trimStart()}`,
        type: "punctuation",
        severity: "medium",
        reason: "Nhãn thông tin nên viết liền với dấu hai chấm.",
        confidence: 0.98,
        is_definite_error: true,
      });
    }

    const delimiter = line.match(/^(\s*)([^,|:\n]{1,80}?)(\s*)([,|])(\s*)(.+)$/u);
    if (delimiter && isLikelyFieldLabel(delimiter[2]) && looksLikeFieldValue(delimiter[6])) {
      const labelStart = offset + delimiter[1].length;
      const original = `${delimiter[2]}${delimiter[3]}${delimiter[4]}${delimiter[5]}${delimiter[6]}`;
      hits.push({
        start: labelStart,
        end: labelStart + original.length,
        original,
        suggestion: `${delimiter[2]}: ${delimiter[6].trimStart()}`,
        type: "punctuation",
        severity: "high",
        reason: delimiter[4] === "|" ? "Typolice có thể đã đọc nhầm dấu hai chấm thành dấu gạch đứng sau nhãn thông tin." : "Sau nhãn thông tin nên dùng dấu hai chấm.",
        confidence: delimiter[4] === "|" ? 0.86 : 0.94,
        is_definite_error: delimiter[4] !== "|",
      });
    }

    const trimmedStart = line.search(/\S/u);
    if (trimmedStart < 0) return;
    const trimmed = line.slice(trimmedStart);
    const lower = trimmed.toLocaleLowerCase("vi-VN");
    for (const prefix of FIELD_LABEL_PREFIXES) {
      if (!lower.startsWith(prefix)) continue;
      const rest = trimmed.slice(prefix.length);
      if (/^\s*[:;,|]/.test(rest)) continue;
      const next = trimmed[prefix.length] ?? "";
      if (!/\s/.test(next)) continue;
      const value = rest.trim();
      if (!looksLikeFieldValue(value)) continue;
      const start = offset + trimmedStart + prefix.length;
      const space = trimmed.slice(prefix.length).match(/^\s+/)?.[0] ?? " ";
      hits.push({
        start,
        end: start + space.length,
        original: space,
        suggestion: ": ",
        type: "punctuation",
        severity: "medium",
        reason: "Nhãn thông tin đang thiếu dấu hai chấm.",
        confidence: 0.84,
        is_definite_error: false,
      });
      break;
    }
  });

  return hits;
}

function markupAndEntityHits(text: string): RuleHit[] {
  const hits: RuleHit[] = [];
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&nbsp;": " ",
    "&lt;": "<",
    "&gt;": ">",
  };

  for (const m of text.matchAll(/\[([^\]\n]{1,120})\]\(((?:https?:\/\/|www\.)[^\s)]+)\)/giu)) {
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: `${m[1]}: ${m[2]}`,
      type: "style",
      severity: "medium",
      reason: "Nội dung đang lộ cú pháp link Markdown.",
      confidence: 0.93,
      is_definite_error: true,
    });
  }

  for (const m of text.matchAll(/(\*\*|__)([^\n]{1,120}?)\1/g)) {
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: m[2],
      type: "style",
      severity: "low",
      reason: "Nội dung đang lộ cú pháp Markdown.",
      confidence: 0.93,
      is_definite_error: true,
    });
  }

  for (const m of text.matchAll(/`([^`\n]{1,120})`/g)) {
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: m[1],
      type: "style",
      severity: "low",
      reason: "Nội dung đang lộ dấu backtick từ Markdown.",
      confidence: 0.9,
      is_definite_error: true,
    });
  }

  for (const [entity, replacement] of Object.entries(entities)) {
    for (const m of text.matchAll(new RegExp(escapeRegExp(entity), "g"))) {
      hits.push({
        start: m.index!,
        end: m.index! + entity.length,
        original: entity,
        suggestion: replacement,
        type: "style",
        severity: "low",
        reason: "Nội dung đang lộ HTML entity.",
        confidence: 0.94,
        is_definite_error: true,
      });
    }
  }

  return hits;
}

function socialTokenHits(text: string, brandKit: BrandKit): RuleHit[] {
  const hits: RuleHit[] = [];
  const seenHashtags = new Set<string>();

  for (const m of text.matchAll(/#[\p{L}\p{N}_]+/gu)) {
    const key = m[0].toLocaleLowerCase("vi-VN");
    if (!seenHashtags.has(key)) {
      seenHashtags.add(key);
      continue;
    }
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: "",
      type: "hashtag",
      severity: "low",
      reason: "Hashtag này bị lặp lại trong cùng nội dung.",
      confidence: 0.9,
      is_definite_error: true,
    });
  }

  for (const m of text.matchAll(/#[\p{L}\p{N}_]*[-&][\p{L}\p{N}_&-]+/gu)) {
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: m[0].replace(/[-&]/g, ""),
      type: "hashtag",
      severity: "medium",
      reason: "Hashtag chỉ nên dùng chữ, số hoặc dấu gạch dưới.",
      confidence: 0.9,
      is_definite_error: true,
    });
  }

  for (const m of text.matchAll(/([\p{L}\p{N}])(#(?:[\p{L}\p{N}_]+))/gu)) {
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: `${m[1]} ${m[2]}`,
      type: "spacing",
      severity: "medium",
      reason: "Cần có khoảng trắng trước hashtag.",
      confidence: 0.92,
      is_definite_error: true,
    });
  }

  for (const m of text.matchAll(/@\s+([A-Za-z0-9_.]+)/g)) {
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: `@${m[1]}`,
      type: "spacing",
      severity: "medium",
      reason: "Mention không nên có khoảng trắng sau dấu @.",
      confidence: 0.94,
      is_definite_error: true,
    });
  }

  const mentionCandidates = new Map<string, string>();
  for (const [wrong, right] of Object.entries(brandKit.product_terms)) {
    if (!/\s/.test(wrong) || /\s/.test(right)) continue;
    mentionCandidates.set(wrong, right);
  }
  for (const term of brandKit.brand_terms) {
    if (!/^[A-Z][a-z]+[A-Z]/.test(term)) continue;
    mentionCandidates.set(term.replace(/([a-z])([A-Z])/g, "$1 $2"), term);
  }
  for (const [wrong, right] of mentionCandidates) {
    const compactRight = right.replace(/\s+/g, "");
    if (!/^[\p{L}\p{N}_]+$/u.test(compactRight)) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])@${escapeRegExp(wrong)}(?![\\p{L}\\p{N}_])`, "giu");
    for (const m of text.matchAll(re)) {
      hits.push({
        start: m.index!,
        end: m.index! + m[0].length,
        original: m[0],
        suggestion: `@${compactRight}`,
        type: "spacing",
        severity: "medium",
        reason: "Mention/handle không nên có khoảng trắng.",
        confidence: 0.86,
        is_definite_error: false,
      });
    }
  }

  for (const m of text.matchAll(/\b([A-Z0-9._%+-]+)\s+@([A-Z0-9.-]+\.[A-Z]{2,})\b/giu)) {
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: `${m[1]}@${m[2]}`,
      type: "spacing",
      severity: "high",
      reason: "Email đang bị tách khoảng trắng trước dấu @.",
      confidence: 0.96,
      is_definite_error: true,
    });
  }
  for (const m of text.matchAll(/\b([A-Z0-9._%+-]+@)\s+([A-Z0-9.-]+\.[A-Z]{2,})\b/giu)) {
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: `${m[1]}${m[2]}`,
      type: "spacing",
      severity: "high",
      reason: "Email đang bị tách khoảng trắng sau dấu @.",
      confidence: 0.96,
      is_definite_error: true,
    });
  }

  for (const m of text.matchAll(/\b(https?:\/\/)\s+([^\s]+)/giu)) {
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: `${m[1]}${m[2]}`,
      type: "spacing",
      severity: "high",
      reason: "Link đang bị tách khoảng trắng sau phần https://.",
      confidence: 0.96,
      is_definite_error: true,
    });
  }

  for (const m of text.matchAll(/\b((?:https?:\/\/|www\.)[^\s]+[.,;:!?])(?=\s|$)/giu)) {
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: m[0].slice(0, -1),
      type: "ambiguity",
      severity: "needs_review",
      reason: "Link có dấu câu ở cuối; cần kiểm tra dấu này có thuộc URL hay không.",
      confidence: 0.72,
      is_definite_error: false,
    });
  }

  return hits;
}

function daysInMonth(month: number, year: number): number {
  return new Date(year, month, 0).getDate();
}

function numericAndDateHits(text: string): RuleHit[] {
  const hits: RuleHit[] = [];

  for (const m of text.matchAll(/(?<!\d)(\d+(?:[.,]\d+)?)\s+%/g)) {
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: `${m[1]}%`,
      type: "spacing",
      severity: "low",
      reason: "Không nên có khoảng trắng giữa số và ký hiệu phần trăm.",
      confidence: 0.96,
      is_definite_error: true,
    });
  }

  for (const m of text.matchAll(/(?<![\p{L}\p{N}])(\d[\d.,]*)\s+(k|đ|vnđ)(?![\p{L}\p{N}])/giu)) {
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: `${m[1]}${m[2]}`,
      type: "spacing",
      severity: "low",
      reason: "Đơn vị tiền nên viết liền với số.",
      confidence: 0.86,
      is_definite_error: false,
    });
  }

  for (const m of text.matchAll(/(?<![\p{L}\p{N}])(\d+(?:[.,]\d+)?)(\s*)(kb|mb|gb|tb)(?![\p{L}\p{N}])/giu)) {
    const suggestion = `${m[1]} ${m[3].toLocaleUpperCase("en-US")}`;
    if (m[0] === suggestion) continue;
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion,
      type: "style",
      severity: "low",
      reason: "Đơn vị dữ liệu nên thống nhất dạng số + khoảng trắng + chữ in hoa.",
      confidence: 0.86,
      is_definite_error: false,
    });
  }

  for (const m of text.matchAll(/\b\d{1,3}(?:,\d{3})+\b/g)) {
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: m[0].replace(/,/g, "."),
      type: "style",
      severity: "low",
      reason: "Theo format tiếng Việt, hàng nghìn nên phân tách bằng dấu chấm.",
      confidence: 0.88,
      is_definite_error: false,
    });
  }

  for (const m of text.matchAll(/(?<!\d)(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})(?!\d)/g)) {
    const suggestion = `${m[1]} - ${m[2]}`;
    if (m[0] === suggestion) continue;
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion,
      type: "spacing",
      severity: "low",
      reason: "Khoảng thời gian nên có khoảng trắng hai bên dấu gạch nối.",
      confidence: 0.9,
      is_definite_error: true,
    });
  }

  for (const m of text.matchAll(/(?<!\d)(\d{1,2})([./-])(\d{1,2})(?:\2(\d{2}|\d{4}))?(?!\d)/g)) {
    const day = Number.parseInt(m[1], 10);
    const month = Number.parseInt(m[3], 10);
    const year = m[4] ? Number.parseInt(m[4].length === 2 ? `20${m[4]}` : m[4], 10) : 2024;
    const invalid = day < 1 || month < 1 || month > 12 || day > daysInMonth(month, year);
    if (!invalid) continue;
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: m[0],
      type: "ambiguity",
      severity: "needs_review",
      reason: "Ngày/tháng có vẻ không hợp lệ, cần kiểm tra lại.",
      confidence: 0.9,
      is_definite_error: false,
    });
  }

  for (const m of text.matchAll(/(?<!\d)(\d{1,2}):(\d{2})(?!\d)/g)) {
    if (normalizeTime(m[1], m[2])) continue;
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: m[0],
      type: "ambiguity",
      severity: "needs_review",
      reason: "Giờ/phút có vẻ không hợp lệ, cần kiểm tra lại.",
      confidence: 0.9,
      is_definite_error: false,
    });
  }

  const weekdayMap: Record<string, number> = {
    "thứ hai": 1,
    "thứ 2": 1,
    "thứ ba": 2,
    "thứ 3": 2,
    "thứ tư": 3,
    "thứ 4": 3,
    "thứ năm": 4,
    "thứ 5": 4,
    "thứ sáu": 5,
    "thứ 6": 5,
    "thứ bảy": 6,
    "thứ 7": 6,
    "chủ nhật": 0,
  };
  for (const m of text.matchAll(/((?:thứ\s*(?:hai|ba|tư|năm|sáu|bảy|2|3|4|5|6|7))|chủ\s*nhật),?\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/giu)) {
    const weekday = m[1].toLocaleLowerCase("vi-VN").replace(/\s+/g, " ");
    const expected = weekdayMap[weekday];
    if (expected === undefined) continue;
    const day = Number.parseInt(m[2], 10);
    const month = Number.parseInt(m[3], 10);
    const year = Number.parseInt(m[4], 10);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) continue;
    if (date.getDay() === expected) continue;
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: m[0],
      type: "ambiguity",
      severity: "needs_review",
      reason: "Thứ trong tuần không khớp với ngày/tháng/năm.",
      confidence: 0.88,
      is_definite_error: false,
    });
  }

  for (const phrase of RELATIVE_DATE_WORDS) {
    for (const m of text.matchAll(phraseRegExp(phrase))) {
      hits.push({
        start: m.index!,
        end: m.index! + m[0].length,
        original: m[0],
        suggestion: m[0],
        type: "ambiguity",
        severity: "needs_review",
        reason: "Cụm thời gian tương đối có thể gây mơ hồ khi bài được đăng/lên lịch khác ngày.",
        confidence: 0.7,
        is_definite_error: false,
      });
    }
  }

  for (const m of text.matchAll(/(?<!\d)(0(?:[\s.-]?\d){7,11})(?!\d)/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length === 10) continue;
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: m[0],
      type: "ambiguity",
      severity: "needs_review",
      reason: "Số điện thoại có độ dài chưa quen thuộc, cần kiểm tra lại.",
      confidence: 0.78,
      is_definite_error: false,
    });
  }

  return hits;
}

function unicodeNormalizationHits(text: string): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const m of text.matchAll(/[\p{L}]\p{M}+/gu)) {
    const suggestion = m[0].normalize("NFC");
    if (suggestion === m[0]) continue;
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion,
      type: "spelling",
      severity: "low",
      reason: "Ký tự tiếng Việt đang dùng dạng Unicode tổ hợp, có thể gây lỗi tìm kiếm/hiển thị.",
      confidence: 0.98,
      is_definite_error: true,
    });
  }
  return hits;
}

function compactStyleTermHits(text: string): RuleHit[] {
  const hits: RuleHit[] = [];
  const replacements: Record<string, string> = {
    GenZ: "Gen Z",
    genZ: "Gen Z",
    genz: "Gen Z",
  };

  for (const [wrong, right] of Object.entries(replacements)) {
    for (const m of text.matchAll(phraseRegExp(wrong))) {
      hits.push({
        start: m.index!,
        end: m.index! + m[0].length,
        original: m[0],
        suggestion: right,
        type: "style",
        severity: "low",
        reason: "Cụm này nên viết tách theo format phổ biến.",
        confidence: 0.86,
        is_definite_error: false,
      });
    }
  }

  for (const m of text.matchAll(/(?<![\p{L}\p{N}_])Top(\d{1,3})(?![\p{L}\p{N}_])/gu)) {
    hits.push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: `Top ${m[1]}`,
      type: "style",
      severity: "low",
      reason: "Nên có khoảng trắng giữa Top và số.",
      confidence: 0.86,
      is_definite_error: false,
    });
  }

  return hits;
}

function ocrSpecificTextHits(text: string): RuleHit[] {
  const hits: RuleHit[] = [];

  forEachLine(text, (line, offset) => {
    const iconNoise = line.match(/^(\s*)([O0Il1])\s+(?=\p{L})/u);
    if (iconNoise) {
      const rest = line.slice(iconNoise[0].length);
      if (FIELD_LABEL_PREFIXES.some((prefix) => rest.toLocaleLowerCase("vi-VN").startsWith(prefix))) {
        const start = offset + iconNoise[1].length;
        hits.push({
          start,
          end: start + iconNoise[2].length + 1,
          original: `${iconNoise[2]} `,
          suggestion: "",
          type: "ocr_low_confidence",
          severity: "needs_review",
          reason: "Typolice có thể đã đọc nhầm icon/trang trí thành chữ ở đầu dòng.",
          confidence: 0.74,
          is_definite_error: false,
        });
      }
    }

  });

  return hits;
}

function acronymExplanationHits(text: string, brandKit: BrandKit): RuleHit[] {
  const hits: RuleHit[] = [];
  const protectedUpper = new Set(
    canonicalProtectedTerms(brandKit)
      .flatMap((term) => term.match(/\b[A-Z]{2,5}\b/g) ?? [])
  );

  for (const acronym of INTERNAL_ACRONYMS_TO_EXPLAIN) {
    if (protectedUpper.has(acronym)) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${acronym}(?![\\p{L}\\p{N}_])`, "gu");
    for (const m of text.matchAll(re)) {
      const after = text.slice(m.index! + acronym.length, m.index! + acronym.length + 3);
      if (/^\s*\(/.test(after)) continue;
      hits.push({
        start: m.index!,
        end: m.index! + acronym.length,
        original: m[0],
        suggestion: m[0],
        type: "ambiguity",
        severity: "needs_review",
        reason: "Acronym nội bộ nên được giải thích ở lần xuất hiện đầu nếu người đọc có thể không quen.",
        confidence: 0.68,
        is_definite_error: false,
      });
      break;
    }
  }

  return hits;
}

/**
 * Deterministic Vietnamese / formatting checks. Runs on raw text, returns
 * issues with exact validated ranges. Runs before any LLM call.
 */
export function runRuleChecker(
  text: string,
  brandKit: BrandKit,
  source: { source_type: Issue["source_type"]; source_id: string; box_id?: string | null; artboard_id?: string | null }
): Issue[] {
  const hits: RuleHit[] = [];
  const captionLike = isCaptionLikeSource(source.source_type);
  const urlRanges = findUrlRanges(text);
  const protectedRanges = findProtectedTermRanges(text, canonicalProtectedTerms(brandKit));
  const overlapsUrl = (h: RuleHit) => urlRanges.some((range) => rangesOverlap(hitRange(h), range));
  const insideProtectedTerm = (h: RuleHit) => protectedRanges.some((range) => rangeContains(range, hitRange(h)));

  const push = (h: RuleHit) => {
    if (h.original === h.suggestion) return;
    if (overlapsUrl(h) && !isUrlFormatCleanup(h)) return;
    if (insideProtectedTerm(h) && !isCaseOnlyCorrection(h.original, h.suggestion)) return;
    if (isProtected(h.original, brandKit) && !isCaseOnlyCorrection(h.original, h.suggestion)) return;
    hits.push(h);
  };
  const addHit = (h: RuleHit) => {
    if (h.original === h.suggestion) {
      if (overlapsUrl(h) && !isUrlFormatCleanup(h)) return;
      if (insideProtectedTerm(h)) return;
      hits.push(h);
      return;
    }
    push(h);
  };

  // 0. Caption-only boundary cleanup.
  if (captionLike) {
    const leading = text.match(/^[ \t]+/);
    if (leading?.[0]) {
      push({
        start: 0,
        end: leading[0].length,
        original: leading[0],
        suggestion: "",
        type: "spacing",
        severity: "low",
        reason: "Xóa khoảng trắng thừa ở đầu caption.",
        confidence: 0.98,
        is_definite_error: true,
      });
    }
    const trailing = text.match(/[ \t]+$/);
    if (trailing?.[0] && trailing.index !== undefined) {
      push({
        start: trailing.index,
        end: trailing.index + trailing[0].length,
        original: trailing[0],
        suggestion: "",
        type: "spacing",
        severity: "low",
        reason: "Xóa khoảng trắng thừa ở cuối caption.",
        confidence: 0.98,
        is_definite_error: true,
      });
    }
  }

  for (const hit of lineHygieneHits(text)) {
    addHit(hit);
  }
  for (const hit of duplicatePhraseHits(text)) {
    addHit(hit);
  }
  for (const hit of listMarkerHits(text)) {
    addHit(hit);
  }
  for (const hit of listConsistencyHits(text)) {
    addHit(hit);
  }
  for (const hit of headingUppercaseConsistencyHits(text, brandKit)) {
    addHit(hit);
  }
  for (const hit of textVariantConsistencyHits(text)) {
    addHit(hit);
  }
  for (const hit of fieldLabelFormatHits(text)) {
    addHit(hit);
  }
  for (const hit of markupAndEntityHits(text)) {
    addHit(hit);
  }
  for (const hit of socialTokenHits(text, brandKit)) {
    addHit(hit);
  }
  for (const hit of numericAndDateHits(text)) {
    addHit(hit);
  }
  for (const hit of unicodeNormalizationHits(text)) {
    addHit(hit);
  }
  for (const hit of compactStyleTermHits(text)) {
    addHit(hit);
  }
  for (const hit of ocrSpecificTextHits(text)) {
    addHit(hit);
  }
  for (const hit of acronymExplanationHits(text, brandKit)) {
    addHit(hit);
  }

  // 1. Multiple spaces (not at line start, not inside leading indentation)
  for (const m of text.matchAll(/(\S)( {2,})(\S)/gu)) {
    const start = m.index!;
    const original = m[0];
    push({
      start,
      end: start + original.length,
      original,
      suggestion: `${m[1]} ${m[3]}`,
      type: "spacing",
      severity: "medium",
      reason: "Dư khoảng trắng.",
      confidence: 0.99,
      is_definite_error: true,
    });
  }

  // 2. Space before punctuation
  for (const m of text.matchAll(/(\S) +([.,!?;:])/g)) {
    push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: `${m[1]}${m[2]}`,
      type: "punctuation",
      severity: "medium",
      reason: "Không có khoảng trắng trước dấu câu.",
      confidence: 0.98,
      is_definite_error: true,
    });
  }

  // 3. Missing space after punctuation.
  for (const m of text.matchAll(/([,!?;:]|\.)([\p{L}])/gu)) {
    if (m[1] === "." && isProbablyUrlPeriod(text, m.index!)) continue;
    push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: `${m[1]} ${m[2]}`,
      type: "spacing",
      severity: "medium",
      reason: "Cần một khoảng trắng sau dấu câu.",
      confidence: 0.94,
      is_definite_error: true,
    });
  }

  // 4. Emoji spacing: "text🔥" -> "text 🔥", "Tuyệt!🥳" -> "Tuyệt! 🥳"
  for (const m of text.matchAll(/([\p{L}\p{N}.,!?;:])(\p{Extended_Pictographic})/gu)) {
    push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: `${m[1]} ${m[2]}`,
      type: "spacing",
      severity: "low",
      reason: "Nên có khoảng trắng trước emoji để caption dễ đọc.",
      confidence: 0.88,
      is_definite_error: true,
    });
  }

  // 5. Ellipsis formatting: keep "..." valid, but fix spaced or overlong ellipses.
  for (const m of text.matchAll(/\. ?\. ?\./g)) {
    if (m[0] === "...") continue;
    push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: "...",
      type: "punctuation",
      severity: "low",
      reason: "Dấu ba chấm nên viết liền thành ...",
      confidence: 0.96,
      is_definite_error: true,
    });
  }
  for (const m of text.matchAll(/\.{4,}/g)) {
    push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: "...",
      type: "punctuation",
      severity: "low",
      reason: "Dấu ba chấm chỉ nên dùng đúng ba dấu chấm.",
      confidence: 0.96,
      is_definite_error: true,
    });
  }

  // 6. Repeated punctuation. Valid "..." is intentionally handled above.
  for (const m of text.matchAll(/([!,?;:])\1+|(?<!\.)\.{2}(?!\.)/g)) {
    push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: m[0][0],
      type: "punctuation",
      severity: "medium",
      reason: "Dấu câu bị lặp.",
      confidence: 0.94,
      is_definite_error: true,
    });
  }

  // 7. Space after opening bracket / before closing bracket.
  for (const m of text.matchAll(/([\(\[])\s+([^\s\)\]])|([^\s\(\[])\s+([\)\]])/g)) {
    const original = m[0];
    const suggestion = m[1]
      ? `${m[1]}${m[2]}`
      : `${m[3]}${m[4]}`;
    push({
      start: m.index!,
      end: m.index! + original.length,
      original,
      suggestion,
      type: "spacing",
      severity: "low",
      reason: "Không nên có khoảng trắng ngay bên trong ngoặc.",
      confidence: 0.95,
      is_definite_error: true,
    });
  }

  // 8. Missing or extra brackets/quotes. Kept deterministic and local to punctuation.
  for (const hit of bracketAndQuoteHits(text)) {
    push(hit);
  }

  // 9. CamelCase collision and acronym merge from team skill.
  for (const hit of camelCaseCollisionHits(text, brandKit)) {
    push(hit);
  }

  // 10. Hashtag with space: "# Tag" -> "#Tag"
  for (const m of text.matchAll(/#\s+([\p{L}\p{N}_]+)/gu)) {
    push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: `#${m[1]}`,
      type: "hashtag",
      severity: "high",
      reason: "Hashtag không được có khoảng trắng sau dấu #.",
      confidence: 0.99,
      is_definite_error: true,
    });
  }

  // 11. Hyphen spacing inside known hyphenated names: "AI -native" -> "AI-native"
  for (const m of text.matchAll(/([\p{L}\p{N}]+)\s+(-[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*)/gu)) {
    const candidate = `${m[1]}${m[2]}`;
    const known = [...brandKit.brand_terms, ...Object.values(brandKit.preferred_spellings)];
    if (known.some((t) => {
      const last = t.split(" ").pop() ?? "";
      return t.includes(candidate) || (last.length > 0 && candidate.includes(last));
    })) {
      push({
        start: m.index!,
        end: m.index! + m[0].length,
        original: m[0],
        suggestion: candidate,
        type: "spacing",
        severity: "high",
        reason: "Sai khoảng trắng quanh dấu gạch nối trong tên riêng.",
        confidence: 0.92,
        is_definite_error: true,
      });
    }
  }

  // 12. Known typos: builtin dictionary + Brand Kit preferred_spellings
  const dict: Record<string, string> = { ...BUILTIN_TYPOS, ...brandKit.preferred_spellings };
  for (const [wrong, right] of Object.entries(dict)) {
    if (!wrong || wrong === right) continue;
    const re = phraseRegExp(wrong);
    for (const m of text.matchAll(re)) {
      // skip if an earlier (longer) hit already covers this span
      if (hits.some((h) => m.index! >= h.start && m.index! + m[0].length <= h.end)) continue;
      const isBrand = brandKit.brand_terms.some((t) => right.includes(t));
      const suggestion = formatDictionarySuggestion(text, m.index!, m.index! + m[0].length, right, brandKit);
      push({
        start: m.index!,
        end: m.index! + m[0].length,
        original: m[0],
        suggestion,
        type: isBrand ? "brand_term" : "spelling",
        severity: "high",
        reason: isBrand ? "Sai tên brand/campaign theo Brand Kit." : "Sai chính tả tiếng Việt.",
        confidence: 0.96,
        is_definite_error: true,
      });
    }
  }

  // 13. Product/service names from team brand guideline skill.
  for (const [wrong, right] of Object.entries(brandKit.product_terms).sort((a, b) => b[0].length - a[0].length)) {
    if (!wrong || wrong === right) continue;
    const re = phraseRegExp(wrong);
    for (const m of text.matchAll(re)) {
      if (hits.some((h) => m.index! >= h.start && m.index! + m[0].length <= h.end)) continue;
      push({
        start: m.index!,
        end: m.index! + m[0].length,
        original: m[0],
        suggestion: right,
        type: "brand_term",
        severity: "high",
        reason: `Tên sản phẩm/dịch vụ phải viết là ${right}.`,
        confidence: 0.96,
        is_definite_error: true,
      });
    }
  }

  // 14. Vietnamese tone dictionaries from team skill.
  for (const [wrong, right] of Object.entries(brandKit.missing_tone_map).sort((a, b) => b[0].length - a[0].length)) {
    const re = phraseRegExp(wrong);
    for (const m of text.matchAll(re)) {
      if (hits.some((h) => m.index! >= h.start && m.index! + m[0].length <= h.end)) continue;
      push({
        start: m.index!,
        end: m.index! + m[0].length,
        original: m[0],
        suggestion: formatCorrectionSuggestion(text, m.index!, m.index! + m[0].length, m[0], right, brandKit),
        type: "spelling",
        severity: "medium",
        reason: "Cụm từ thiếu dấu tiếng Việt.",
        confidence: 0.9,
        is_definite_error: true,
      });
    }
  }
  for (const [wrong, right] of Object.entries(brandKit.wrong_tone_map).sort((a, b) => b[0].length - a[0].length)) {
    const re = phraseRegExp(wrong);
    for (const m of text.matchAll(re)) {
      if (hits.some((h) => m.index! >= h.start && m.index! + m[0].length <= h.end)) continue;
      push({
        start: m.index!,
        end: m.index! + m[0].length,
        original: m[0],
        suggestion: formatCorrectionSuggestion(text, m.index!, m.index! + m[0].length, m[0], right, brandKit),
        type: "spelling",
        severity: "medium",
        reason: "Sai dấu tiếng Việt.",
        confidence: 0.93,
        is_definite_error: true,
      });
    }
  }

  // 15. Brand voice dictionaries: preferred wording and risky wording.
  for (const [original, replacement] of Object.entries(brandKit.preferred_wording).sort((a, b) => b[0].length - a[0].length)) {
    const re = phraseRegExp(original);
    for (const m of text.matchAll(re)) {
      if (hits.some((h) => m.index! >= h.start && m.index! + m[0].length <= h.end)) continue;
      push({
        start: m.index!,
        end: m.index! + m[0].length,
        original: m[0],
        suggestion: formatCorrectionSuggestion(text, m.index!, m.index! + m[0].length, m[0], replacement, brandKit),
        type: "style",
        severity: "medium",
        reason: "Cụm từ chưa phù hợp giọng văn thương hiệu; nên dùng cách diễn đạt trung tính/chuyên nghiệp hơn.",
        confidence: 0.82,
        is_definite_error: false,
      });
    }
  }
  for (const [phrase, info] of Object.entries(brandKit.risky_words).sort((a, b) => b[0].length - a[0].length)) {
    const re = phraseRegExp(phrase);
    for (const m of text.matchAll(re)) {
      if (hits.some((h) => m.index! >= h.start && m.index! + m[0].length <= h.end)) continue;
      hits.push({
        start: m.index!,
        end: m.index! + m[0].length,
        original: m[0],
        suggestion: m[0],
        type: "style",
        severity: info.priority === "high" ? "high" : info.priority === "low" ? "low" : "medium",
        reason: `Từ/cụm từ có rủi ro brand voice. Gợi ý: ${info.suggestion}`,
        confidence: 0.78,
        is_definite_error: false,
      });
    }
  }

  // 16. Duplicated words: "ngay ngay" -> "ngay"
  // NOTE: \b is ASCII-only and breaks on Vietnamese accents — use \p{L} lookarounds
  for (const m of text.matchAll(/(?<![\p{L}])([\p{L}]+) +\1(?![\p{L}])/giu)) {
    push({
      start: m.index!,
      end: m.index! + m[0].length,
      original: m[0],
      suggestion: m[1],
      type: "grammar",
      severity: "medium",
      reason: "Từ bị lặp.",
      confidence: 0.9,
      is_definite_error: true,
    });
  }

  // 17. Brand term spacing variants: "VNG Games" -> "VNGGames"
  for (const term of brandKit.brand_terms) {
    if (!/^[A-Z][a-z]+[A-Z]/.test(term)) continue; // CamelCase single-word terms only
    const spaced = term.replace(/([a-z])([A-Z])/g, "$1 $2");
    const re = phraseRegExp(spaced);
    for (const m of text.matchAll(re)) {
      push({
        start: m.index!,
        end: m.index! + m[0].length,
        original: m[0],
        suggestion: term,
        type: "brand_term",
        severity: "high",
        reason: `Brand Kit quy định viết liền: ${term}.`,
        confidence: 0.95,
        is_definite_error: true,
      });
    }
  }

  // 18. Sentence capitalization for captions.
  if (captionLike) {
    const first = text.match(/\S/u);
    if (first?.[0] && /\p{Ll}/u.test(first[0])) {
      push({
        start: first.index!,
        end: first.index! + first[0].length,
        original: first[0],
        suggestion: first[0].toLocaleUpperCase("vi-VN"),
        type: "grammar",
        severity: "low",
        reason: "Ký tự đầu tiên của caption nên viết hoa.",
        confidence: 0.88,
        is_definite_error: true,
      });
    }
    for (const [phrase, replacement] of Object.entries(brandKit.preferred_wording)) {
      const re = sentenceInitialRegExp(phrase);
      for (const m of text.matchAll(re)) {
        const original = m[0];
        const prefix = m[1] ?? "";
        const start = m.index! + prefix.length;
        if (hits.some((h) => start >= h.start && start + phrase.length <= h.end)) continue;
        push({
          start,
          end: start + phrase.length,
          original: text.slice(start, start + phrase.length),
          suggestion: formatCorrectionSuggestion(text, start, start + phrase.length, original.slice(prefix.length), replacement, brandKit),
          type: "style",
          severity: "medium",
          reason: "Cụm từ chưa phù hợp giọng văn thương hiệu; nên dùng cách diễn đạt trung tính/chuyên nghiệp hơn.",
          confidence: 0.82,
          is_definite_error: false,
        });
      }
    }
  }

  // 19. Date/time formats from team brand guideline skill.
  for (const hit of dateStandardizationHits(text)) {
    push(hit);
  }
  for (const hit of timeFormatHits(text)) {
    push(hit);
  }

  // 21. Date format consistency: "3/7", "03/07", "03.07", "03-07" in one content
  for (const hit of dateConsistencyHits(text)) {
    push(hit);
  }

  // 22. Field label delimiter: "Hình thức tham gia; ..." -> "Hình thức tham gia: ..."
  for (const hit of fieldLabelColonHits(text)) {
    push(hit);
  }

  // 23. Caption-only final punctuation.
  if (captionLike) {
    const trimmed = text.trimEnd();
    const end = trimmed.length;
    const finalChar = trimmed[end - 1];
    if (finalChar === ",") {
      push({
        start: end - 1,
        end,
        original: ",",
        suggestion: ".",
        type: "punctuation",
        severity: "medium",
        reason: "Caption không nên kết thúc bằng dấu phẩy.",
        confidence: 0.94,
        is_definite_error: true,
      });
    } else if (finalChar && /[\p{L}\p{N}]/u.test(finalChar) && !/#([\p{L}\p{N}_]+)$/u.test(trimmed)) {
      push({
        start: end - 1,
        end,
        original: finalChar,
        suggestion: `${finalChar}.`,
        type: "punctuation",
        severity: "suggestion",
        reason: "Caption dạng câu nên có dấu kết thúc phù hợp.",
        confidence: 0.72,
        is_definite_error: false,
      });
    }
  }

  // Resolve overlaps between rule hits: prefer the longer span (it contains
  // the smaller typo), then higher confidence. Definite fixes always beat
  // broad needs_review/suggestion warnings so fuzzy checks cannot hide a
  // concrete spacing/punctuation issue on the same text.
  const sorted = [...hits].sort(
    (a, b) => Number(b.is_definite_error) - Number(a.is_definite_error)
      || b.end - b.start - (a.end - a.start)
      || b.confidence - a.confidence
  );
  const kept: RuleHit[] = [];
  for (const h of sorted) {
    if (!kept.some((k) => h.start < k.end && k.start < h.end)) kept.push(h);
  }
  kept.sort((a, b) => a.start - b.start);

  return kept.map((h) => ({
    issue_id: nextId("issue"),
    source_type: source.source_type,
    source_id: source.source_id,
    artboard_id: source.artboard_id ?? null,
    box_id: source.box_id ?? null,
    type: h.type,
    severity: h.severity,
    original: h.original,
    suggestion: h.suggestion,
    reason: h.reason,
    confidence: h.confidence,
    is_definite_error: h.is_definite_error,
    range: { start: h.start, end: h.end },
    bbox: null,
    context_before: text.slice(Math.max(0, h.start - 12), h.start),
    context_after: text.slice(h.end, h.end + 12),
    status: "open",
    created_by: "rule_checker",
  }));
}
