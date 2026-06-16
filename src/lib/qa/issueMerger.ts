import type { Issue } from "@/types";
import { findProtectedTermRanges, findUrlRanges, rangesOverlap, type TextRange } from "@/lib/qa/protectedText";

const SEVERITY_RANK: Record<string, number> = {
  critical: 0, high: 1, medium: 2, low: 3, suggestion: 4, needs_review: 5,
};

function isCaseOnlyChange(original: string, suggestion: string): boolean {
  return (
    original !== suggestion &&
    original.toLocaleLowerCase("vi-VN") === suggestion.toLocaleLowerCase("vi-VN")
  );
}

function normalized(value: string) {
  return value.trim().toLocaleLowerCase("vi-VN");
}

function rangeContains(container: TextRange, inner: TextRange) {
  return inner.start >= container.start && inner.end <= container.end;
}

function isCanonicalProtectedCaseFix(original: string, suggestion: string, protectedTerms: string[]) {
  return protectedTerms.some(
    (term) => normalized(original) === normalized(term) &&
      original !== term &&
      suggestion === term
  );
}

function isExactProtectedTerm(value: string, protectedTerms: string[]) {
  return protectedTerms.some((term) => value.trim() === term);
}

function editsProtectedOrUrlText(
  text: string,
  range: TextRange,
  original: string,
  suggestion: string,
  protectedTerms: string[]
) {
  if (findUrlRanges(text).some((urlRange) => rangesOverlap(range, urlRange))) return true;
  if (isCanonicalProtectedCaseFix(original, suggestion, protectedTerms)) return false;

  const protectedRanges = findProtectedTermRanges(text, protectedTerms);
  for (const protectedRange of protectedRanges) {
    if (!rangesOverlap(range, protectedRange)) continue;
    const protectedText = text.slice(protectedRange.start, protectedRange.end);

    if (isExactProtectedTerm(original, protectedTerms) && suggestion !== original) return true;
    if (rangeContains(protectedRange, range)) return true;
    if (rangeContains(range, protectedRange) && !suggestion.includes(protectedText)) return true;
  }

  return false;
}

function firstCaptionHeadingRange(text: string): { start: number; end: number } | null {
  const lineMatch = text.match(/^[\s\n\r]*([^\n\r]+)/u);
  if (!lineMatch || lineMatch.index === undefined) return null;
  const line = lineMatch[1];
  const start = lineMatch[0].length - line.length;
  const trimmedStartOffset = line.search(/\S/u);
  if (trimmedStartOffset < 0) return null;
  const rawEnd = start + line.length;
  const headingStart = start + trimmedStartOffset;
  const headingText = text.slice(headingStart, rawEnd).trimEnd();
  const headingEnd = headingStart + headingText.length;
  if (headingEnd <= headingStart) return null;

  const letters = [...headingText.matchAll(/\p{L}/gu)].map((m) => m[0]);
  if (letters.length < 2) return null;
  const lowercaseCount = letters.filter((ch) => ch === ch.toLocaleLowerCase("vi-VN") && ch !== ch.toLocaleUpperCase("vi-VN")).length;
  const uppercaseCount = letters.filter((ch) => ch === ch.toLocaleUpperCase("vi-VN") && ch !== ch.toLocaleLowerCase("vi-VN")).length;
  const wordCount = (headingText.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  if (lowercaseCount > 0) return null;
  if (uppercaseCount / letters.length < 0.8) return null;
  if (wordCount > 14 || headingText.length > 120) return null;

  return { start: headingStart, end: headingEnd };
}

function isInitialCaptionHeadingCaseFalsePositive(text: string, issue: Partial<Issue>, range: { start: number; end: number }): boolean {
  if (issue.source_type !== "caption") return false;
  if (!issue.original || !issue.suggestion) return false;
  if (!isCaseOnlyChange(issue.original, issue.suggestion)) return false;

  const heading = firstCaptionHeadingRange(text);
  if (!heading) return false;
  if (range.start < heading.start || range.end > heading.end) return false;

  const originalLetters = [...issue.original.matchAll(/\p{L}/gu)].map((m) => m[0]);
  if (originalLetters.length < 2) return false;
  const hasLowercase = originalLetters.some((ch) => ch === ch.toLocaleLowerCase("vi-VN") && ch !== ch.toLocaleUpperCase("vi-VN"));
  return !hasLowercase;
}

/**
 * Never trust LLM offsets. Given an LLM candidate issue (which only quotes
 * `original` + optional context), locate the exact range in the raw text.
 * Returns null when the quote does not exist — such candidates are discarded.
 */
export function locateRange(
  text: string,
  original: string,
  contextBefore?: string,
  contextAfter?: string
): { start: number; end: number } | null {
  if (!original) return null;
  const positions: number[] = [];
  let idx = text.indexOf(original);
  while (idx !== -1) {
    positions.push(idx);
    idx = text.indexOf(original, idx + 1);
  }
  if (positions.length === 0) return null;
  if (positions.length === 1) {
    return { start: positions[0], end: positions[0] + original.length };
  }
  // Multiple matches: disambiguate with context
  if (contextBefore || contextAfter) {
    for (const p of positions) {
      const before = text.slice(Math.max(0, p - (contextBefore?.length ?? 0)), p);
      const after = text.slice(p + original.length, p + original.length + (contextAfter?.length ?? 0));
      if ((!contextBefore || before === contextBefore) && (!contextAfter || after === contextAfter)) {
        return { start: p, end: p + original.length };
      }
    }
  }
  // Ambiguous: take first occurrence (frontend shows it; same fix applies anywhere)
  return { start: positions[0], end: positions[0] + original.length };
}

/** Validate LLM candidates against raw text and brand kit protections. */
export function validateLLMIssues(
  text: string,
  candidates: Partial<Issue>[],
  protectedTerms: string[]
): Issue[] {
  const valid: Issue[] = [];
  let n = 0;
  for (const c of candidates) {
    if (!c.original || typeof c.original !== "string") continue;
    if (!c.suggestion || typeof c.suggestion !== "string") continue;
    if (!c.type || !c.severity || !c.reason) continue;
    const range = locateRange(text, c.original, c.context_before, c.context_after);
    if (!range) continue; // hallucinated quote
    if (editsProtectedOrUrlText(text, range, c.original, c.suggestion, protectedTerms)) continue;
    if (isInitialCaptionHeadingCaseFalsePositive(text, c, range)) continue;
    n += 1;
    valid.push({
      issue_id: `issue_llm_${Date.now().toString(36)}_${n}`,
      source_type: (c.source_type as Issue["source_type"]) ?? "caption",
      source_id: c.source_id ?? "",
      artboard_id: c.artboard_id ?? null,
      box_id: c.box_id ?? null,
      type: c.type as Issue["type"],
      severity: c.severity as Issue["severity"],
      original: c.original,
      suggestion: c.suggestion,
      reason: c.reason,
      confidence: typeof c.confidence === "number" ? Math.min(1, Math.max(0, c.confidence)) : 0.6,
      is_definite_error: c.is_definite_error === true,
      range,
      bbox: c.bbox ?? null,
      context_before: text.slice(Math.max(0, range.start - 12), range.start),
      context_after: text.slice(range.end, range.end + 12),
      status: "open",
      created_by: c.created_by ?? "llm_qa",
    });
  }
  return valid;
}

function overlaps(a: Issue, b: Issue): boolean {
  if (!a.range || !b.range) return false;
  return a.range.start < b.range.end && b.range.start < a.range.end;
}

/**
 * Merge rule-based + LLM issues. On overlap:
 *  1. prefer rule_checker over LLM
 *  2. prefer the longer span
 *  3. prefer higher severity
 */
export function mergeIssues(ruleIssues: Issue[], llmIssues: Issue[]): Issue[] {
  const merged: Issue[] = [...ruleIssues];
  for (const cand of llmIssues) {
    const clash = merged.find((m) => overlaps(m, cand) || (m.original === cand.original && m.range?.start === cand.range?.start));
    if (!clash) {
      merged.push(cand);
      continue;
    }
    const candLen = cand.range ? cand.range.end - cand.range.start : 0;
    const clashLen = clash.range ? clash.range.end - clash.range.start : 0;
    const clashIsRule = clash.created_by === "rule_checker";
    if (!clashIsRule && (candLen > clashLen || SEVERITY_RANK[cand.severity] < SEVERITY_RANK[clash.severity])) {
      merged[merged.indexOf(clash)] = cand;
    }
    // otherwise keep existing (rule wins)
  }
  merged.sort((a, b) => (a.range?.start ?? 0) - (b.range?.start ?? 0));
  return merged;
}

export function summarize(issues: Issue[]) {
  const active = issues.filter((i) => i.status !== "ignored" && i.status !== "resolved");
  const by_severity: Record<string, number> = {};
  const by_source: Record<string, number> = {};
  for (const i of active) {
    by_severity[i.severity] = (by_severity[i.severity] ?? 0) + 1;
    by_source[i.source_type] = (by_source[i.source_type] ?? 0) + 1;
  }
  return {
    total_issues: active.length,
    definite_errors: active.filter((i) => i.is_definite_error).length,
    suggestions: active.filter((i) => !i.is_definite_error && i.severity !== "needs_review").length,
    needs_review: active.filter((i) => i.severity === "needs_review").length,
    by_severity,
    by_source,
  };
}
