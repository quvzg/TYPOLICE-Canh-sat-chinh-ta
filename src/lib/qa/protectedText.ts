import type { BrandKit } from "@/types";

export interface TextRange {
  start: number;
  end: number;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTerm(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export function protectedTermsFromBrandKit(brandKit: BrandKit): string[] {
  return Array.from(new Set([
    ...brandKit.brand_terms,
    ...brandKit.protected_terms,
    ...brandKit.do_not_change,
    ...Object.values(brandKit.product_terms),
    ...Object.values(brandKit.preferred_spellings),
  ].map(normalizeTerm).filter(Boolean)));
}

export function findProtectedTermRanges(text: string, terms: string[]): TextRange[] {
  const ranges: TextRange[] = [];
  const sortedTerms = Array.from(new Set(terms.map(normalizeTerm).filter(Boolean)))
    .sort((a, b) => b.length - a.length);

  for (const term of sortedTerms) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`, "giu");
    for (const match of text.matchAll(re)) {
      ranges.push({ start: match.index!, end: match.index! + match[0].length });
    }
  }

  return mergeRanges(ranges);
}

export function findUrlRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  const urlPattern = /https?:\/\/[^\s<>"'`]+|www\.[^\s<>"'`]+|(?<![@\p{L}\p{N}_-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|vn|app|dev|ai|co|me|edu|gov|info|biz|xyz|site|online|cloud|gg|ly)(?:\/[^\s<>"'`]*)?/giu;

  for (const match of text.matchAll(urlPattern)) {
    let end = match.index! + match[0].length;
    while (end > match.index! && /[),.!?;:]+$/u.test(text.slice(match.index!, end))) {
      end -= 1;
    }
    if (end > match.index!) ranges.push({ start: match.index!, end });
  }

  return mergeRanges(ranges);
}

export function rangesOverlap(a: TextRange, b: TextRange) {
  return a.start < b.end && b.start < a.end;
}

function mergeRanges(ranges: TextRange[]): TextRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: TextRange[] = [];

  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) {
      merged.push({ ...range });
    } else {
      last.end = Math.max(last.end, range.end);
    }
  }

  return merged;
}
