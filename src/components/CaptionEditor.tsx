"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQAStore } from "@/lib/store";
import { SEVERITY_COLORS } from "@/lib/presets";
import { requiresManualIssueCheck } from "@/lib/qa/issueDisplay";
import type { Issue } from "@/types";

interface Segment {
  text: string;
  issue: Issue | null;
}

function buildSegments(text: string, issues: Issue[]): Segment[] {
  const marks = issues
    .filter((i) => i.source_type === "caption" && i.status === "open" && i.range)
    .sort((a, b) => a.range!.start - b.range!.start);
  const segments: Segment[] = [];
  let pos = 0;
  for (const issue of marks) {
    const { start, end } = issue.range!;
    if (start < pos || end > text.length) continue; // overlap/stale — skip
    if (start > pos) segments.push({ text: text.slice(pos, start), issue: null });
    segments.push({ text: text.slice(start, end), issue });
    pos = end;
  }
  if (pos < text.length) segments.push({ text: text.slice(pos), issue: null });
  return segments;
}

function IssuePopover({ issue }: { issue: Issue }) {
  const acceptIssue = useQAStore((s) => s.acceptIssue);
  const checkIssue = useQAStore((s) => s.checkIssue);
  const ignoreIssue = useQAStore((s) => s.ignoreIssue);
  const addToDictionary = useQAStore((s) => s.addToDictionary);
  const color = SEVERITY_COLORS[issue.severity];
  const isWarningOnly = issue.original === issue.suggestion;
  const manualCheck = requiresManualIssueCheck(issue);

  return (
    <div className="absolute left-0 top-full z-50 mt-1 w-80 rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-sm shadow-2xl">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded px-1.5 py-0.5 text-xs font-semibold uppercase" style={{ backgroundColor: `${color}22`, color }}>
          {issue.severity}
        </span>
        <span className="text-xs text-zinc-400">{issue.type}</span>
        <span className="ml-auto text-xs text-zinc-500">{Math.round(issue.confidence * 100)}%</span>
      </div>
      {!isWarningOnly && (
        <div className="mb-1.5 font-mono text-[13px]">
          <span className="rounded bg-red-500/10 px-1 text-red-300">{issue.original}</span>
          <span className="mx-1.5 text-zinc-500">→</span>
          <span className="text-emerald-400">{issue.suggestion}</span>
        </div>
      )}
      <p className="mb-2.5 text-xs leading-relaxed text-zinc-300">{issue.reason}</p>
      <div className="flex gap-1.5">
        {manualCheck ? (
          <button
            onClick={() => checkIssue(issue.issue_id)}
            className="cp-success-button cp-button-xs"
            title="Đánh dấu đã tự kiểm tra — không áp dụng gợi ý tự động"
          >
            Checked
          </button>
        ) : (
          <>
            {!isWarningOnly && (
              <button
                onClick={() => acceptIssue(issue.issue_id)}
                className="cp-success-button cp-button-xs"
              >
                Accept
              </button>
            )}
            <button
              onClick={() => ignoreIssue(issue.issue_id)}
              className="cp-muted-button cp-button-xs"
            >
              Ignore
            </button>
            {(issue.type === "brand_term" || issue.type === "spelling") && (
              <button
                onClick={() => addToDictionary(issue.issue_id)}
                className="cp-info-button cp-button-xs"
                title="Add this to Brand Kit so Typolice will not flag it again"
              >
                + Dictionary
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function CaptionEditor() {
  const captionText = useQAStore((s) => s.captionText);
  const issues = useQAStore((s) => s.issues);
  const setCaption = useQAStore((s) => s.setCaption);
  const editorMode = useQAStore((s) => s.editorMode);
  const setEditorMode = useQAStore((s) => s.setEditorMode);
  const analyzing = useQAStore((s) => s.analyzing);
  const selectedIssueId = useQAStore((s) => s.selectedIssueId);

  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const segments = useMemo(() => buildSegments(captionText, issues), [captionText, issues]);
  const openCount = issues.filter((i) => i.source_type === "caption" && i.status === "open").length;

  // panel → editor: scroll selected issue's mark into view
  useEffect(() => {
    if (!selectedIssueId || editorMode !== "review") return;
    const el = containerRef.current?.querySelector(`[data-issue-id="${selectedIssueId}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [selectedIssueId, editorMode]);

  const hoverEnter = (id: string) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setHoveredId(id);
  };
  const hoverLeave = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setHoveredId(null), 250);
  };

  return (
    <div className="flex h-full flex-col border-t border-zinc-800 bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Caption</span>
        {openCount > 0 && (
          <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-[11px] font-medium text-red-400">
            {openCount} issue{openCount > 1 ? "s" : ""}
          </span>
        )}
        {analyzing && <span className="text-[11px] text-zinc-500 animate-pulse">checking…</span>}
        <div className="ml-auto flex rounded-md border border-zinc-700 text-xs">
          <button
            onClick={() => setEditorMode("edit")}
            className={`rounded-l-md px-2.5 py-1 ${editorMode === "edit" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
          >
            Edit
          </button>
          <button
            onClick={() => setEditorMode("review")}
            className={`rounded-r-md px-2.5 py-1 ${editorMode === "review" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
          >
            Review
          </button>
        </div>
      </div>

      <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto p-3">
        {editorMode === "edit" ? (
          <textarea
            value={captionText}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Paste your caption here..."
            className="h-full w-full resize-none bg-transparent font-sans text-[14px] leading-7 text-zinc-100 outline-none placeholder:text-zinc-600"
            spellCheck={false}
          />
        ) : (
          <div className="whitespace-pre-wrap font-sans text-[14px] leading-7 text-zinc-100">
            {segments.length === 0 && (
              <span className="text-zinc-600">No caption yet. Switch to Edit to paste your caption.</span>
            )}
            {segments.map((seg, i) =>
              seg.issue ? (
                <span
                  key={i}
                  data-issue-id={seg.issue.issue_id}
                  className="cp-inline-issue-highlight"
                  data-selected={selectedIssueId === seg.issue.issue_id ? "true" : "false"}
                  style={{ "--issue-color": SEVERITY_COLORS[seg.issue.severity] } as CSSProperties}
                  onMouseEnter={() => hoverEnter(seg.issue!.issue_id)}
                  onMouseLeave={hoverLeave}
                >
                  {seg.text}
                  {hoveredId === seg.issue.issue_id && <IssuePopover issue={seg.issue} />}
                </span>
              ) : (
                <span key={i}>{seg.text}</span>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}
