import type { Issue } from "@/types";

export type PatchMode = "accepted_only" | "definite" | "all_open";

const DEFINITE_CONFIDENCE_THRESHOLD = 0.85;

function eligible(issue: Issue, mode: PatchMode): boolean {
  if (!issue.range) return false;
  if (issue.original === issue.suggestion) return false;
  if (issue.status === "accepted") return true;
  if (issue.status !== "open") return false;
  if (mode === "accepted_only") return false;
  if (mode === "definite") {
    return issue.is_definite_error && issue.confidence >= DEFINITE_CONFIDENCE_THRESHOLD;
  }
  return true; // all_open
}

/**
 * Apply fixes to the raw caption. Patches are applied end-to-start so earlier
 * ranges stay valid. Never rewrites anything outside issue ranges — line
 * breaks, emoji, and hashtags are preserved byte-for-byte.
 */
export function applyPatches(rawText: string, issues: Issue[], mode: PatchMode): {
  text: string;
  applied: Issue[];
} {
  const candidates = issues
    .filter((i) => eligible(i, mode))
    .sort((a, b) => b.range!.start - a.range!.start);

  let text = rawText;
  const applied: Issue[] = [];
  let lastStart = Infinity;
  for (const issue of candidates) {
    const { start, end } = issue.range!;
    if (end > lastStart) continue; // overlap with an already-applied patch
    // safety: the quoted original must still be at the recorded range
    if (text.slice(start, end) !== issue.original) continue;
    text = text.slice(0, start) + issue.suggestion + text.slice(end);
    applied.push(issue);
    lastStart = start;
  }
  return { text, applied };
}

/**
 * After the user accepts one fix, shift the ranges of the remaining issues so
 * highlights stay aligned without a full re-check.
 */
export function shiftRangesAfterPatch(
  issues: Issue[],
  patchedIssue: Issue
): Issue[] {
  if (!patchedIssue.range) return issues;
  const { start, end } = patchedIssue.range;
  const delta = patchedIssue.suggestion.length - (end - start);
  return issues.map((i) => {
    if (i.issue_id === patchedIssue.issue_id || !i.range) return i;
    if (i.range.start >= end) {
      return { ...i, range: { start: i.range.start + delta, end: i.range.end + delta } };
    }
    if (i.range.end <= start) return i;
    // overlapping issue becomes stale after the text changed underneath it
    return { ...i, status: "resolved" as const };
  });
}
