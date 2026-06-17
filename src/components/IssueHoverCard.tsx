"use client";

import { type CSSProperties } from "react";
import { useQAStore } from "@/lib/store";
import { SEVERITY_COLORS } from "@/lib/presets";
import { friendlyIssueReason, friendlyIssueType, requiresManualIssueCheck } from "@/lib/qa/issueDisplay";
import type { Issue } from "@/types";

function severityBadgeStyle(color: string): CSSProperties {
  return {
    "--severity-color": color,
    "--severity-bg": `${color}22`,
    backgroundColor: "var(--severity-bg)",
    color: "var(--severity-color)",
  } as CSSProperties;
}

export default function IssueHoverCard({ issue }: { issue: Issue }) {
  const acceptIssue = useQAStore((s) => s.acceptIssue);
  const checkIssue = useQAStore((s) => s.checkIssue);
  const ignoreIssue = useQAStore((s) => s.ignoreIssue);
  const addToDictionary = useQAStore((s) => s.addToDictionary);
  const color = SEVERITY_COLORS[issue.severity];
  const warningOnly = issue.original === issue.suggestion;
  const manualCheck = requiresManualIssueCheck(issue);
  const issueType = friendlyIssueType(issue);
  const reason = friendlyIssueReason(issue.reason);

  return (
    <div
      data-canvas-issue-card="1"
      onClick={(e) => e.stopPropagation()}
      className="w-[360px] rounded-lg border border-zinc-700 bg-zinc-950 p-3 text-left text-[12px] leading-relaxed text-zinc-200 shadow-2xl"
    >
      <div className="mb-2 flex items-center gap-1.5">
        <span
          data-severity={issue.severity}
          className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
          style={severityBadgeStyle(color)}
        >
          {issue.severity}
        </span>
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300">
          {issue.source_type}
        </span>
        <span className="ml-auto text-[10px] text-zinc-500">{issueType} · {Math.round(issue.confidence * 100)}%</span>
      </div>

      {warningOnly ? (
        <p className="mb-1.5 font-mono text-[12px] text-yellow-300">{issue.original}</p>
      ) : (
        <p className="mb-1.5 font-mono text-[12px]">
          <span className="rounded bg-red-500/10 px-1 text-red-300">{issue.original}</span>
          <span className="mx-1 text-zinc-500">→</span>
          <span className="text-emerald-400">{issue.suggestion}</span>
        </p>
      )}
      <p className="mb-2 text-[11px] text-zinc-400">{reason}</p>

      <div className="flex flex-wrap gap-1.5">
        {manualCheck ? (
          <button onClick={() => checkIssue(issue.issue_id)} className="cp-success-button cp-button-xs" title="Đánh dấu đã tự kiểm tra — không áp dụng gợi ý tự động">
            Checked
          </button>
        ) : (
          <>
            {!warningOnly && issue.source_type === "caption" && (
              <button onClick={() => acceptIssue(issue.issue_id)} className="cp-success-button cp-button-xs">
                Accept
              </button>
            )}
            {issue.source_type === "image" && (
              <button onClick={() => acceptIssue(issue.issue_id)} className="cp-success-button cp-button-xs">
                Accept note
              </button>
            )}
            <button onClick={() => ignoreIssue(issue.issue_id)} className="cp-muted-button cp-button-xs">
              Ignore
            </button>
            {(issue.type === "brand_term" || issue.type === "spelling") && (
              <button onClick={() => void addToDictionary(issue.issue_id)} className="cp-info-button cp-button-xs">
                + Dict
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
