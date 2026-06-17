"use client";

import { type CSSProperties, type FormEvent, useEffect, useMemo, useState } from "react";
import { useQAStore, type AppMode, type GuidelineInput, type QATab } from "@/lib/store";
import { SEVERITY_COLORS, SEVERITY_ORDER } from "@/lib/presets";
import { friendlyIssueReason, friendlyIssueType, requiresManualIssueCheck } from "@/lib/qa/issueDisplay";
import { applyPatches } from "@/lib/qa/patchService";
import { formatFileSize } from "@/lib/uploadLimits";
import ReportDownloadButton from "@/components/ReportDownloadButton";
import type { Artboard, Asset, Issue } from "@/types";

const SOURCE_BADGE: Record<string, string> = {
  caption: "bg-indigo-500/20 text-indigo-300",
  image: "bg-pink-500/20 text-pink-300",
  layout: "bg-teal-500/20 text-teal-300",
};

function severityStyle(color: string): CSSProperties {
  return {
    "--severity-color": color,
    "--severity-bg": `${color}22`,
    backgroundColor: "var(--severity-bg)",
    color: "var(--severity-color)",
  } as CSSProperties;
}

function severityHeadingStyle(color: string): CSSProperties {
  return {
    "--severity-color": color,
    color: "var(--severity-color)",
  } as CSSProperties;
}

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={`h-3.5 w-3.5 fill-none stroke-current stroke-[1.7] text-zinc-500 transition-transform ${collapsed ? "-rotate-90" : ""}`}
    >
      <path d="m4.4 6.3 3.6 3.6 3.6-3.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function artboardKind(ab: Artboard) {
  return ab.kind ?? (ab.format === "caption" ? "caption" : ab.format === "note" ? "note" : "visual");
}

function issuesForPanelMode(issues: Issue[], appMode: AppMode, artboards: Artboard[]) {
  const artboardIds = new Set(artboards.map((artboard) => artboard.id));
  const projectAssetIds = new Set(
    artboards
      .filter((artboard) => artboardKind(artboard) === "visual")
      .flatMap((artboard) => artboard.layers.map((layer) => layer.asset_id))
  );

  if (appMode === "project") {
    return issues.filter((issue) => {
      if (issue.source_type === "caption") {
        return issue.artboard_id === null || artboardIds.has(issue.artboard_id);
      }
      if (issue.source_type === "image") {
        return Boolean(issue.artboard_id && artboardIds.has(issue.artboard_id)) || projectAssetIds.has(issue.source_id);
      }
      return Boolean(issue.artboard_id && artboardIds.has(issue.artboard_id)) || artboardIds.has(issue.source_id);
    });
  }

  return issues.filter((issue) => {
    if (issue.source_type === "caption") return true;
    if (issue.source_type === "image") return issue.artboard_id === null;
    return false;
  });
}

function AgentTab() {
  const llmConfigured = useQAStore((s) => s.llmConfigured);

  return (
    <div className="space-y-3 p-3">
      <div className="cp-agent-card">
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-orange-100">Typolice Agent</h3>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${llmConfigured ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-800 text-zinc-500"}`}>
            {llmConfigured ? "AgentBase MaaS" : "Rules-only"}
          </span>
        </div>
        <p className="text-[11px] leading-relaxed text-zinc-300">
          Automation & Integration agent for social content QA: caption, poster text, brand guideline memory, human review and exportable report.
        </p>
      </div>
    </div>
  );
}

function IssueCard({ issue }: { issue: Issue }) {
  const acceptIssue = useQAStore((s) => s.acceptIssue);
  const checkIssue = useQAStore((s) => s.checkIssue);
  const ignoreIssue = useQAStore((s) => s.ignoreIssue);
  const addToDictionary = useQAStore((s) => s.addToDictionary);
  const selectIssue = useQAStore((s) => s.selectIssue);
  const setEditorMode = useQAStore((s) => s.setEditorMode);
  const selected = useQAStore((s) => s.selectedIssueId) === issue.issue_id;
  const artboards = useQAStore((s) => s.artboards);
  const assets = useQAStore((s) => s.assets);

  const color = SEVERITY_COLORS[issue.severity];
  const done = issue.status === "accepted" || issue.status === "ignored" || issue.status === "resolved";
  const isWarningOnly = issue.original === issue.suggestion;
  const manualCheck = requiresManualIssueCheck(issue);
  const issueType = friendlyIssueType(issue);
  const reason = friendlyIssueReason(issue.reason);

  const sourceLabel = useMemo(() => {
    if (issue.source_type === "caption") return "Caption";
    if (issue.source_type === "image") {
      const asset = assets.find((a) => a.id === issue.source_id);
      return asset ? `Ảnh: ${asset.filename}` : "Ảnh";
    }
    const ab = artboards.find((a) => a.id === issue.artboard_id);
    return ab ? `Layout: ${ab.label}` : "Layout";
  }, [issue, assets, artboards]);

  const jump = () => {
    selectIssue(issue.issue_id);
    if (issue.source_type === "caption") setEditorMode("review");
  };

  return (
    <div
      onClick={jump}
      style={{
        borderColor: done ? undefined : `${color}55`,
        boxShadow: selected && !done ? `0 0 0 1px ${color}66` : undefined,
      }}
      className={`cursor-pointer rounded-lg border p-2.5 pl-3 transition-colors ${
        selected ? "border-zinc-500 bg-zinc-800/80" : "border-zinc-800 bg-zinc-900 hover:border-zinc-700"
      } ${done ? "opacity-50" : ""}`}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <span
          data-severity={issue.severity}
          className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
          style={severityStyle(color)}
        >
          {issue.severity}
        </span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${SOURCE_BADGE[issue.source_type]}`}>
          {sourceLabel}
        </span>
        <span className="ml-auto text-[10px] text-zinc-500">{issueType}</span>
      </div>

      {isWarningOnly ? (
        <p className="mb-1 font-mono text-[12px] text-yellow-300">{issue.original}</p>
      ) : (
        <p className="mb-1 font-mono text-[12px]">
          <span className="rounded bg-red-500/10 px-1 text-red-300">{issue.original}</span>
          <span className="mx-1 text-zinc-500">→</span>
          <span className="text-emerald-400">{issue.suggestion}</span>
        </p>
      )}
      <p className="mb-1.5 text-[11px] leading-relaxed text-zinc-400">{reason}</p>

      {done ? (
        <span className="text-[10px] font-medium uppercase text-zinc-500">{issue.status}</span>
      ) : (
        <div className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
          {manualCheck ? (
            <button onClick={() => checkIssue(issue.issue_id)} className="cp-success-button cp-button-xs" title="Đánh dấu đã tự kiểm tra — không áp dụng gợi ý tự động">
              Checked
            </button>
          ) : (
            <>
              {!isWarningOnly && issue.source_type === "caption" && (
                <button onClick={() => acceptIssue(issue.issue_id)} className="cp-success-button cp-button-xs">
                  Accept
                </button>
              )}
              {issue.source_type === "image" && (
                <button onClick={() => acceptIssue(issue.issue_id)} className="cp-success-button cp-button-xs" title="Đánh dấu đã ghi nhận — cần sửa file ảnh gốc">
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
      )}
    </div>
  );
}

type IssueGroup = {
  key: string;
  title: string;
  subtitle: string;
  issues: Issue[];
  order: number;
};

function cardLabelForIssue(
  issue: Issue,
  artboards: Artboard[],
  assets: Asset[],
  imageCheckLabel: string
): Omit<IssueGroup, "issues"> {
  const artboardIndex = (id: string | null | undefined) => {
    const index = artboards.findIndex((ab) => ab.id === id);
    return index === -1 ? 1000 : index;
  };

  if (issue.source_type === "caption") {
    const ab = issue.artboard_id
      ? artboards.find((item) => item.id === issue.artboard_id)
      : artboards.find((item) => item.format === "caption" && item.kind === "caption") ??
        artboards.find((item) => item.format === "caption");
    return {
      key: issue.artboard_id ? `caption:${issue.artboard_id}` : "caption:primary",
      title: ab?.label || "Caption Input 1",
      subtitle: "",
      order: issue.artboard_id ? artboardIndex(issue.artboard_id) : -10,
    };
  }

  if (issue.source_type === "image") {
    const ab = issue.artboard_id
      ? artboards.find((item) => item.id === issue.artboard_id)
      : artboards.find((item) => item.layers.some((layer) => layer.asset_id === issue.source_id));
    if (ab) {
      return {
        key: `artboard:${ab.id}`,
        title: ab.label || "Image artboard",
        subtitle: "Image text in project artboard",
        order: artboardIndex(ab.id),
      };
    }

    const asset = assets.find((item) => item.id === issue.source_id);
    return {
      key: "image-check",
      title: imageCheckLabel || "Visual Text Scanner",
      subtitle: asset ? `Image check • ${asset.filename}` : "Image check",
      order: 900,
    };
  }

  const ab = issue.artboard_id ? artboards.find((item) => item.id === issue.artboard_id) : null;
  return {
    key: ab ? `layout:${ab.id}` : "layout",
    title: ab?.label || "Layout",
    subtitle: "Layout check",
    order: ab ? artboardIndex(ab.id) : 950,
  };
}

function IssuesTab({ issues }: { issues: Issue[] }) {
  const artboards = useQAStore((s) => s.artboards);
  const assets = useQAStore((s) => s.assets);
  const imageCheckLabel = useQAStore((s) => s.imageCheckLabel);
  const [showDone, setShowDone] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const visible = useMemo(
    () => issues.filter((i) => showDone ? true : i.status === "open" || i.status === "needs_human_review"),
    [issues, showDone]
  );
  const open = issues.filter((i) => i.status === "open");
  const groups = useMemo(() => {
    const byCard = new Map<string, IssueGroup>();
    for (const issue of visible) {
      const meta = cardLabelForIssue(issue, artboards, assets, imageCheckLabel);
      const group = byCard.get(meta.key);
      if (group) {
        group.issues.push(issue);
      } else {
        byCard.set(meta.key, { ...meta, issues: [issue] });
      }
    }

    return Array.from(byCard.values())
      .map((group) => ({
        ...group,
        issues: [...group.issues].sort(
          (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
        ),
      }))
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  }, [assets, artboards, imageCheckLabel, visible]);

  if (issues.length === 0) {
    return <p className="cp-qa-empty">No issues in this view. Run the card you are reviewing to see its results here.</p>;
  }
  return (
    <div className="space-y-3 p-2.5">
      <div className="flex items-center justify-between px-0.5">
        <span className="text-xs text-zinc-400">
          {open.length === 0 ? "✅ Không còn lỗi mở" : `${open.length} issue đang mở`}
        </span>
        <label className="flex items-center gap-1.5 text-[11px] text-zinc-500">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
          đã xử lý
        </label>
      </div>
      {groups.map((group) => {
        const openInGroup = group.issues.filter((i) => i.status === "open").length;
        const collapsed = collapsedGroups[group.key] === true;
        return (
          <section key={group.key} className="cp-issue-group">
            <button
              type="button"
              aria-expanded={!collapsed}
              onClick={() => setCollapsedGroups((current) => ({ ...current, [group.key]: !collapsed }))}
              className={`cp-issue-group-header ${collapsed ? "" : "mb-2"}`}
              title={collapsed ? "Show this card's issues" : "Hide this card's issues"}
            >
              <div className="flex min-w-0 items-start gap-1.5">
                <span className="mt-0.5 shrink-0">
                  <ChevronIcon collapsed={collapsed} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-semibold text-zinc-100">{group.title}</span>
                  {!group.key.startsWith("caption:") && group.subtitle && (
                    <span className="mt-0.5 block truncate text-[10px] text-zinc-500">{group.subtitle}</span>
                  )}
                </span>
              </div>
              <span className="shrink-0 text-right">
                <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums ${
                  openInGroup > 0 ? "bg-red-500/15 text-red-300 ring-1 ring-inset ring-red-500/20" : "bg-zinc-800 text-zinc-500"
                }`}>
                  {openInGroup > 0 ? `${openInGroup} open` : "clear"}
                </span>
                <span className="mt-1 block text-[10px] text-zinc-600">{group.issues.length} total</span>
              </span>
            </button>
            {!collapsed && (
              <div className="space-y-2">
                {SEVERITY_ORDER.map((sev) => {
                  const severityIssues = group.issues.filter((issue) => issue.severity === sev);
                  if (severityIssues.length === 0) return null;
                  return (
                    <div key={sev} className="space-y-1.5">
                      <h5
                        data-severity-heading={sev}
                        className="px-0.5 text-[10px] font-bold uppercase tracking-wider"
                        style={severityHeadingStyle(SEVERITY_COLORS[sev])}
                      >
                        {sev} ({severityIssues.length})
                      </h5>
                      {severityIssues.map((i) => <IssueCard key={i.issue_id} issue={i} />)}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function CorrectedTab() {
  const captionText = useQAStore((s) => s.captionText);
  const issues = useQAStore((s) => s.issues);
  const applyAllDefinite = useQAStore((s) => s.applyAllDefinite);
  const [copied, setCopied] = useState(false);

  const captionIssues = issues.filter((i) => i.source_type === "caption" && i.artboard_id === null);
  const { text: preview, applied } = useMemo(
    () => applyPatches(captionText, captionIssues, "definite"),
    [captionText, captionIssues]
  );
  const acceptedCount = captionIssues.filter((i) => i.status === "accepted").length;
  const ignoredCount = captionIssues.filter((i) => i.status === "ignored").length;
  const needsReview = captionIssues.filter((i) => i.severity === "needs_review" && i.status === "open").length;
  const pendingDefinite = applied.filter((i) => i.status === "open").length;

  const copy = async () => {
    await navigator.clipboard.writeText(preview);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex h-full flex-col p-2.5">
      <div className="mb-2 grid grid-cols-3 divide-x divide-zinc-800 rounded-lg border border-zinc-800 bg-zinc-900/40 py-1.5 text-center">
        <div className="px-1"><div className="text-base font-bold tabular-nums text-emerald-400">{acceptedCount}</div><div className="text-[10px] text-zinc-500">Applied</div></div>
        <div className="px-1"><div className="text-base font-bold tabular-nums text-zinc-400">{ignoredCount}</div><div className="text-[10px] text-zinc-500">Ignored</div></div>
        <div className="px-1"><div className="text-base font-bold tabular-nums text-yellow-400">{needsReview}</div><div className="text-[10px] text-zinc-500">Review</div></div>
      </div>
      <p className="mb-1 text-[11px] text-zinc-500">
        Live Preview: Current text with auto-fixes applied (Confidence ≥ 85%):
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-[13px] leading-6 text-zinc-100">
        {preview || <span className="text-zinc-600">No caption yet.</span>}
      </div>
      <div className="mt-2 flex gap-1.5">
        <button onClick={copy} className="cp-button cp-button-secondary cp-button-sm flex-1">
          {copied ? "✓ Copied" : "Copy corrected caption"}
        </button>
        <button
          onClick={applyAllDefinite}
          disabled={pendingDefinite === 0}
          className="cp-button cp-button-sm flex-1"
        >
          Apply all definite fixes
        </button>
      </div>
    </div>
  );
}

function BrandKitTab() {
  const brandKit = useQAStore((s) => s.brandKit);
  const guidelineFiles = useQAStore((s) => s.guidelineFiles);
  const addGuideline = useQAStore((s) => s.addGuideline);
  const uploadGuidelineFile = useQAStore((s) => s.uploadGuidelineFile);
  const [kind, setKind] = useState<GuidelineInput["list"]>("do_not_change");
  const [term, setTerm] = useState("");
  const [wrong, setWrong] = useState("");
  const [correct, setCorrect] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (!brandKit) return null;

  type PairGuidelineKind = Extract<GuidelineInput, { wrong: string }>["list"];
  const pairKinds = new Set<PairGuidelineKind>([
    "preferred_spellings",
    "product_terms",
    "preferred_wording",
    "risky_words",
  ]);
  const isPairKind = (value: GuidelineInput["list"]): value is PairGuidelineKind =>
    pairKinds.has(value as PairGuidelineKind);
  const pairKind = isPairKind(kind);
  const pairPlaceholders: Record<string, { wrong: string; correct: string }> = {
    preferred_spellings: { wrong: "Sai", correct: "Đúng" },
    product_terms: { wrong: "vng games", correct: "VNGGames" },
    preferred_wording: { wrong: "xịn sò", correct: "nổi bật" },
    risky_words: { wrong: "sập app", correct: "Dùng cách diễn đạt trung lập hơn." },
  };

  const canSave =
    pairKind
      ? wrong.trim().length > 0 && correct.trim().length > 0
      : kind === "style_guideline"
        ? note.trim().length > 0
        : term.trim().length > 0;

  const resetInputs = () => {
    setTerm("");
    setWrong("");
    setCorrect("");
    setNote("");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave || saving) return;

    const input: GuidelineInput =
      pairKind
        ? { list: kind, wrong: wrong.trim(), correct: correct.trim() }
        : kind === "style_guideline"
          ? { list: kind, note: note.trim() }
          : { list: kind, add_term: term.trim() };

    setSaving(true);
    setMessage(null);
    const ok = await addGuideline(input);
    setSaving(false);
    setMessage(ok ? "Đã thêm guideline." : "Không thêm được guideline.");
    if (ok) resetInputs();
    setTimeout(() => setMessage(null), 1800);
  };

  const upload = async (file: File | null | undefined) => {
    if (!file || uploading) return;
    setUploading(true);
    setMessage(null);
    const result = await uploadGuidelineFile(file);
    setUploading(false);
    setMessage(result.message);
    setTimeout(() => setMessage(null), 2200);
  };

  const inputClass =
    "w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-indigo-500";
  const latestGuideline = guidelineFiles[0];

  return (
    <div className="space-y-3 p-3">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5">
        <div className="mb-2">
          <h4 className="text-xs font-semibold text-zinc-200">Upload project guideline</h4>
        </div>
        <label className="cp-button cp-button-secondary cp-button-sm flex w-full cursor-pointer items-center justify-center">
          {uploading ? "Uploading…" : "Upload PDF / Word / Excel"}
          <input
            type="file"
            accept=".pdf,.doc,.docx,.xlsx,.json,.csv,.md,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/json,text/csv,text/markdown,text/plain"
            className="sr-only"
            disabled={uploading}
            onChange={(event) => {
              void upload(event.target.files?.[0]);
              event.currentTarget.value = "";
            }}
          />
        </label>
        {latestGuideline && (
          <a
            href={latestGuideline.url}
            target="_blank"
            rel="noreferrer"
            className="cp-button cp-button-secondary cp-button-sm mt-2 w-full"
            title={`${latestGuideline.original_name} · ${formatFileSize(latestGuideline.size)}`}
          >
            View uploaded guideline
          </a>
        )}
      </div>

      <form onSubmit={submit} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5">
        <div className="mb-2 flex items-center gap-2">
          <h4 className="text-xs font-semibold text-zinc-200">Add guideline</h4>
          {message && <span className="ml-auto text-[10px] text-emerald-400">{message}</span>}
        </div>
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value as GuidelineInput["list"])}
          className={`${inputClass} mb-2`}
        >
          <option value="do_not_change">Do not change term</option>
          <option value="brand_terms">Brand term</option>
          <option value="preferred_spellings">Preferred spelling</option>
          <option value="product_terms">Product/service term</option>
          <option value="preferred_wording">Preferred wording</option>
          <option value="risky_words">Risky wording</option>
          <option value="style_guideline">Style guideline</option>
        </select>

        {pairKind ? (
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5">
            <input
              value={wrong}
              onChange={(event) => setWrong(event.target.value)}
              placeholder={pairPlaceholders[kind]?.wrong ?? "Sai"}
              className={inputClass}
            />
            <span className="text-xs text-zinc-500">→</span>
            <input
              value={correct}
              onChange={(event) => setCorrect(event.target.value)}
              placeholder={pairPlaceholders[kind]?.correct ?? "Đúng"}
              className={inputClass}
            />
          </div>
        ) : kind === "style_guideline" ? (
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Ví dụ: Luôn dùng giọng văn trẻ trung, tránh hứa hẹn tuyệt đối."
            rows={3}
            className={`${inputClass} resize-none leading-5`}
          />
        ) : (
          <input
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Life at VNG"
            className={inputClass}
          />
        )}

        <button
          type="submit"
          disabled={!canSave || saving}
          className="cp-button cp-button-sm mt-2 w-full"
        >
          {saving ? "Adding…" : "Add guideline"}
        </button>
      </form>
    </div>
  );
}

function ExportTab() {
  const issues = useQAStore((s) => s.issues);
  const open = issues.filter((i) => i.status === "open").length;
  return (
    <div className="space-y-2 p-3">
      <div
        className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium ring-1 ring-inset ${
          open === 0
            ? "bg-emerald-500/10 text-emerald-300 ring-emerald-500/20"
            : "bg-amber-500/10 text-amber-300 ring-amber-500/20"
        }`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${open === 0 ? "bg-emerald-400" : "bg-amber-400"}`} />
        {open === 0 ? "Sẵn sàng publish" : `Còn ${open} issue đang mở`}
      </div>
      <ReportDownloadButton
        format="pdf"
        filename="monthly-content-qc-report.pdf"
        className="cp-button cp-button-sm w-full"
      >
        Download Monthly QC Report (PDF)
      </ReportDownloadButton>
      <ReportDownloadButton
        format="xlsx"
        filename="monthly-content-qc-report.xlsx"
        className="cp-button cp-button-secondary cp-button-sm w-full"
      >
        Download detail log (Excel)
      </ReportDownloadButton>
      <p className="pt-1 text-[10px] leading-relaxed text-zinc-600">
        PDF gồm Executive Summary, Quality & Brand Compliance, Velocity & Timestamps, AI Strategic Insights. Excel gồm dashboard và nhật ký kiểm duyệt chi tiết.
      </p>
    </div>
  );
}

const TABS: { id: QATab; label: string }[] = [
  { id: "agent", label: "Agent" },
  { id: "issues", label: "Issues" },
  { id: "corrected", label: "Corrected" },
  { id: "brandkit", label: "Guidelines" },
  { id: "export", label: "Export" },
];

export default function QAPanel({ showBrandKit = true }: { showBrandKit?: boolean }) {
  const activeTab = useQAStore((s) => s.activeTab);
  const setTab = useQAStore((s) => s.setTab);
  const issues = useQAStore((s) => s.issues);
  const artboards = useQAStore((s) => s.artboards);
  const appMode = useQAStore((s) => s.appMode);
  const panelIssues = useMemo(
    () => issuesForPanelMode(issues, appMode, artboards),
    [appMode, artboards, issues]
  );
  const openCount = panelIssues.filter((i) => i.status === "open").length;
  const tabs = useMemo(
    () => TABS.filter((tab) => showBrandKit || tab.id !== "brandkit"),
    [showBrandKit]
  );

  useEffect(() => {
    if (!showBrandKit && activeTab === "brandkit") setTab("issues");
  }, [activeTab, setTab, showBrandKit]);

  return (
    <aside className="cp-qa-panel flex w-80 shrink-0 flex-col">
      <div className="cp-qa-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="cp-qa-tab"
            data-active={activeTab === t.id ? "true" : "false"}
          >
            {t.label}
            {t.id === "issues" && openCount > 0 && (
              <span className="ml-1 rounded-full bg-red-500/20 px-1.5 text-[10px] font-semibold tabular-nums text-red-400">
                {openCount}
              </span>
            )}
            {activeTab === t.id && <span className="cp-qa-tab-indicator" />}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeTab === "agent" && <AgentTab />}
        {activeTab === "issues" && <IssuesTab issues={panelIssues} />}
        {activeTab === "corrected" && <CorrectedTab />}
        {showBrandKit && activeTab === "brandkit" && <BrandKitTab />}
        {activeTab === "export" && <ExportTab />}
      </div>
    </aside>
  );
}
