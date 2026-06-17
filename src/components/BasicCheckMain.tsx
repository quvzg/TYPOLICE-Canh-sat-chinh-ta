"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type SyntheticEvent, type WheelEvent as ReactWheelEvent } from "react";
import { useQAStore, type CardScanStatus, type ScanPhase } from "@/lib/store";
import { SEVERITY_COLORS } from "@/lib/presets";
import IssueHoverCard from "@/components/IssueHoverCard";
import type { Artboard, Asset, Issue, OcrStatus } from "@/types";

const PRIMARY_CAPTION_ARTBOARD_ID = "artboard_caption";

const OCR_BADGE: Record<OcrStatus, { label: string; cls: string }> = {
  pending: { label: "Chưa đọc chữ", cls: "bg-zinc-800 text-zinc-400" },
  processing: { label: "Đang đọc chữ", cls: "bg-blue-500/15 text-blue-300" },
  done: { label: "Đã đọc chữ", cls: "bg-emerald-500/15 text-emerald-300" },
  low_confidence: { label: "Cần xem lại", cls: "bg-yellow-500/15 text-yellow-300" },
  failed: { label: "Chưa đọc được", cls: "bg-red-500/15 text-red-300" },
};

function artboardKind(ab: Artboard) {
  return ab.kind ?? (ab.format === "caption" ? "caption" : ab.format === "note" ? "note" : "visual");
}

function isPrimaryCaption(ab: Artboard) {
  return ab.id === PRIMARY_CAPTION_ARTBOARD_ID;
}

function isPrimaryCaptionIssue(issue: Issue) {
  return issue.source_type === "caption" &&
    (
      issue.artboard_id === null ||
      issue.artboard_id === PRIMARY_CAPTION_ARTBOARD_ID ||
      issue.source_id.startsWith("caption_")
    );
}

function scanTone(phase: ScanPhase) {
  if (phase === "complete") return "done";
  if (phase === "failed") return "failed";
  if (phase === "needs_rerun") return "warning";
  return "busy";
}

function scanCoverageLabel(status: CardScanStatus) {
  const coverageText = status.coverage === "still_checking"
    ? "Đang rà soát"
    : status.coverage === "needs_review"
      ? "Cần xem lại"
      : status.coverage === "could_not_fully_read"
        ? "Chưa đọc hết"
        : status.coverage === "checked"
          ? "Đã kiểm tra"
          : null;
  const withCoverage = (count: string | null) => coverageText && count ? `${coverageText} · ${count}` : coverageText ?? count;
  if (status.phase === "deep_running" && typeof status.fastIssueCount === "number") {
    return withCoverage(`${status.fastIssueCount} lỗi đã thấy`);
  }
  if (status.phase === "complete" && typeof status.finalIssueCount === "number") {
    return withCoverage(`${status.finalIssueCount} lỗi đang mở`);
  }
  if (status.phase === "failed" && typeof status.fastIssueCount === "number") {
    return withCoverage(`giữ ${status.fastIssueCount} lỗi nhanh`);
  }
  return coverageText;
}

function isScanInProgress(status?: CardScanStatus) {
  return status?.phase === "fast_running" || status?.phase === "deep_running";
}

function ScanStatusLine({ status }: { status?: CardScanStatus }) {
  if (!status) return null;
  const coverage = scanCoverageLabel(status);
  return (
    <div className="cp-scan-status" data-scan-status={scanTone(status.phase)} title={status.detail}>
      <span className="cp-scan-status-dot" />
      <span className="min-w-0 truncate">{status.message}</span>
      {coverage && <span className="cp-scan-status-count">{coverage}</span>}
    </div>
  );
}

interface CaptionSegment {
  text: string;
  issue: Issue | null;
}

interface ImagePreviewGeometry {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  scale: number;
}

function buildCaptionSegments(text: string, issues: Issue[]): CaptionSegment[] {
  const marks = issues
    .filter((i) => i.source_type === "caption" && i.status === "open" && i.range)
    .sort((a, b) => a.range!.start - b.range!.start);
  const segments: CaptionSegment[] = [];
  let pos = 0;
  for (const issue of marks) {
    const { start, end } = issue.range!;
    if (start < pos || end > text.length) continue;
    if (start > pos) segments.push({ text: text.slice(pos, start), issue: null });
    segments.push({ text: text.slice(start, end), issue });
    pos = end;
  }
  if (pos < text.length) segments.push({ text: text.slice(pos), issue: null });
  return segments;
}

function isActiveIssue(issue: Issue) {
  return issue.status === "open" || issue.status === "needs_human_review";
}

function clampValue(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function imagePreviewGeometry(sourceSize: { width: number; height: number }, frame: { width: number; height: number } | null): ImagePreviewGeometry | null {
  if (!frame || sourceSize.width <= 0 || sourceSize.height <= 0 || frame.width <= 0 || frame.height <= 0) return null;
  const scale = Math.min(frame.width / sourceSize.width, frame.height / sourceSize.height);
  const width = sourceSize.width * scale;
  const height = sourceSize.height * scale;
  return {
    width,
    height,
    offsetX: (frame.width - width) / 2,
    offsetY: (frame.height - height) / 2,
    scale,
  };
}

function clampImagePan(
  pan: { x: number; y: number },
  zoom: number,
  geometry: ImagePreviewGeometry | null,
  frame: { width: number; height: number } | null
) {
  if (!geometry || !frame || zoom <= 1.01) return { x: 0, y: 0 };
  const scaledWidth = geometry.width * zoom;
  const scaledHeight = geometry.height * zoom;
  const slack = 24;
  const minX = frame.width - geometry.offsetX - scaledWidth - slack;
  const maxX = slack - geometry.offsetX;
  const minY = frame.height - geometry.offsetY - scaledHeight - slack;
  const maxY = slack - geometry.offsetY;

  return {
    x: scaledWidth <= frame.width ? 0 : clampValue(pan.x, minX, maxX),
    y: scaledHeight <= frame.height ? 0 : clampValue(pan.y, minY, maxY),
  };
}

function imageIssueBoxStyle(issue: Issue, geometry: ImagePreviewGeometry | null): CSSProperties | null {
  if (!issue.bbox || !geometry) return null;
  const [x0, y0, x1, y1] = issue.bbox;
  const width = Math.max(8, (x1 - x0) * geometry.scale);
  const height = Math.max(8, (y1 - y0) * geometry.scale);

  return {
    left: x0 * geometry.scale,
    top: y0 * geometry.scale,
    width,
    height,
    "--issue-color": SEVERITY_COLORS[issue.severity],
  } as CSSProperties;
}

function RunIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.7]">
      <path d="M5.2 3.5 12 8l-6.8 4.5V3.5Z" strokeLinejoin="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.7]">
      <path d="M8 3.4v9.2M3.4 8h9.2" strokeLinecap="round" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.7]">
      <path d="M3.5 8h9" strokeLinecap="round" />
    </svg>
  );
}

function ResetViewIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.65]">
      <path d="M4.5 5.1A4.6 4.6 0 1 1 3.8 9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.6 2.8v2.5H2.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.55]">
      <path d="M5.2 4.4V3.2c0-.4.3-.8.8-.8h4c.4 0 .8.3.8.8v1.2" strokeLinecap="round" />
      <path d="M3.7 4.4h8.6M5 6.3l.4 6c0 .5.4.9.9.9h3.4c.5 0 .9-.4.9-.9l.4-6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.1 7.1v4M8.9 7.1v4" strokeLinecap="round" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.7]">
      <path d="M8 11.6V3.8M5.2 6.5 8 3.7l2.8 2.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 11.4v1.1c0 .5.4.9.9.9h8.2c.5 0 .9-.4.9-.9v-1.1" strokeLinecap="round" />
    </svg>
  );
}

function CaptionCheckCard({ artboard, index }: { artboard: Artboard; index: number }) {
  const captionText = useQAStore((s) => s.captionText);
  const issues = useQAStore((s) => s.issues);
  const qaRunningTargets = useQAStore((s) => s.qaRunningTargets);
  const deepQaRunningTargets = useQAStore((s) => s.deepQaRunningTargets);
  const cardScanStatus = useQAStore((s) => s.cardScanStatus[artboard.id]);
  const setCaption = useQAStore((s) => s.setCaption);
  const updateArtboardLabel = useQAStore((s) => s.updateArtboardLabel);
  const updateArtboardText = useQAStore((s) => s.updateArtboardText);
  const removeArtboard = useQAStore((s) => s.removeArtboard);
  const runQA = useQAStore((s) => s.runQA);
  const setTab = useQAStore((s) => s.setTab);
  const selectedIssueId = useQAStore((s) => s.selectedIssueId);
  const selectIssue = useQAStore((s) => s.selectIssue);
  const primary = isPrimaryCaption(artboard);
  const text = primary ? captionText : artboard.text ?? "";
  const openIssues = issues.filter((issue) =>
    issue.source_type === "caption" &&
    issue.status === "open" &&
    (primary ? isPrimaryCaptionIssue(issue) : issue.artboard_id === artboard.id)
  );
  const running = Boolean(qaRunningTargets[artboard.id] || deepQaRunningTargets[artboard.id]);
  const [mode, setMode] = useState<"edit" | "review">("edit");
  const [hoverCard, setHoverCard] = useState<{ issue: Issue; x: number; y: number } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const segments = useMemo(() => buildCaptionSegments(text, openIssues), [text, openIssues]);
  const scanInProgress = running || isScanInProgress(cardScanStatus);

  useEffect(() => {
    if (openIssues.length > 0) setMode("review");
  }, [openIssues.length]);

  const keepHoverCard = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };

  const scheduleHideHoverCard = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setHoverCard(null), 240);
  };

  const showHoverCard = (issue: Issue, target: HTMLElement) => {
    keepHoverCard();
    const rect = target.getBoundingClientRect();
    const cardWidth = 360;
    const gap = 10;
    const x = Math.min(window.innerWidth - cardWidth - 16, Math.max(16, rect.left));
    const below = rect.bottom + gap;
    const y = below + 220 > window.innerHeight ? Math.max(16, rect.top - 230) : below;
    setHoverCard({ issue, x, y });
  };

  return (
    <section className="cp-main-card">
      <div className="cp-main-card-header">
        <div className="min-w-0 flex-1">
          <input
            key={`${artboard.id}-${artboard.label}`}
            defaultValue={artboard.label || `Caption Input ${index + 1}`}
            onBlur={(event) => updateArtboardLabel(artboard.id, event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            aria-label={`Rename caption ${index + 1}`}
            className="cp-card-title-input w-full"
          />
          <ScanStatusLine status={cardScanStatus} />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {openIssues.length > 0 && (
            <button
              type="button"
              onClick={() => setTab("issues")}
              className="cp-card-action-button"
              data-card-action="issue"
              title={`${openIssues.length} issue${openIssues.length === 1 ? "" : "s"}`}
              aria-label={`${openIssues.length} issue${openIssues.length === 1 ? "" : "s"}`}
            >
              {openIssues.length > 99 ? "99+" : openIssues.length}
            </button>
          )}
          {!primary && (
            <button
              type="button"
              onClick={() => removeArtboard(artboard.id)}
              className="cp-card-action-button"
              data-card-action="danger"
              title="Remove caption card"
              aria-label="Remove caption card"
            >
              <TrashIcon />
            </button>
          )}
          <button
            type="button"
            data-run-action-button="1"
            disabled={!text.trim() || scanInProgress}
            onClick={() => void runQA("smart", artboard.id)}
            className="cp-card-action-button"
            title={scanInProgress ? "Typolice vẫn đang rà soát caption này" : "Scan this card"}
            aria-label={scanInProgress ? "Typolice vẫn đang rà soát caption này" : "Scan this card"}
          >
            <RunIcon />
          </button>
        </div>
      </div>
      <div className="cp-main-card-body">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="cp-card-meta">
            {openIssues.length > 0 ? `${openIssues.length} issue${openIssues.length === 1 ? "" : "s"} highlighted` : "No highlighted issues yet"}
          </div>
          <div className="cp-card-mode-switch">
            <button
              type="button"
              onClick={() => setMode("edit")}
              className="cp-card-mode-button"
              data-active={mode === "edit" ? "true" : "false"}
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => setMode("review")}
              className="cp-card-mode-button"
              data-active={mode === "review" ? "true" : "false"}
            >
              Review
            </button>
          </div>
        </div>
        {scanInProgress && (
          <div className="cp-caption-scan-warning" role="status">
            <span className="cp-caption-scan-warning-dot" />
            <span>
              Typolice vẫn đang rà soát caption này. Lỗi mới vẫn có thể xuất hiện, vui lòng đợi rà xong trước khi bấm Run lại.
            </span>
          </div>
        )}
        {mode === "edit" ? (
          <textarea
            value={text}
            onChange={(event) => {
              if (primary) setCaption(event.target.value);
              else updateArtboardText(artboard.id, event.target.value);
            }}
            placeholder="Paste your caption here..."
            className="cp-basic-caption-input min-h-[180px] w-full resize-y rounded-xl border p-4 outline-none"
          />
        ) : (
          <div className="cp-basic-caption-review min-h-[180px] w-full overflow-y-auto whitespace-pre-wrap rounded-xl border p-4">
            {segments.length === 0 && <span className="text-zinc-600">No caption yet.</span>}
            {segments.map((seg, segmentIndex) =>
              seg.issue ? (
                <span
                  key={`${seg.issue.issue_id}-${segmentIndex}`}
                  data-issue-id={seg.issue.issue_id}
                  onClick={() => {
                    selectIssue(seg.issue!.issue_id);
                    setTab("issues");
                  }}
                  onMouseEnter={(event) => showHoverCard(seg.issue!, event.currentTarget)}
                  onMouseLeave={scheduleHideHoverCard}
                  className="cp-inline-issue-highlight"
                  data-selected={selectedIssueId === seg.issue.issue_id ? "true" : "false"}
                  style={{ "--issue-color": SEVERITY_COLORS[seg.issue.severity] } as CSSProperties}
                >
                  {seg.text}
                </span>
              ) : (
                <span key={`plain-${segmentIndex}`}>{seg.text}</span>
              )
            )}
          </div>
        )}
        {hoverCard && (
          <div
            data-space-issue-card="1"
            className="fixed z-[300]"
            style={{ left: hoverCard.x, top: hoverCard.y }}
            onMouseEnter={keepHoverCard}
            onMouseLeave={scheduleHideHoverCard}
          >
            <IssueHoverCard issue={hoverCard.issue} />
          </div>
        )}
      </div>
    </section>
  );
}

function AssetCard({ asset }: { asset: Asset }) {
  const issues = useQAStore((s) => s.issues);
  const runOcr = useQAStore((s) => s.runOcr);
  const removeAsset = useQAStore((s) => s.removeAsset);
  const selectedIssueId = useQAStore((s) => s.selectedIssueId);
  const selectIssue = useQAStore((s) => s.selectIssue);
  const setTab = useQAStore((s) => s.setTab);
  const frameRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panStartRef = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [hoverCard, setHoverCard] = useState<{ issue: Issue; x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const imageIssues = useMemo(
    () => issues.filter((issue) => issue.source_type === "image" && issue.source_id === asset.id && isActiveIssue(issue)),
    [asset.id, issues]
  );
  const boxedIssues = imageIssues.filter((issue) => issue.bbox);
  const count = imageIssues.length;
  const badge = OCR_BADGE[asset.ocr_status];
  const sourceSize = naturalSize ?? { width: asset.width || 1, height: asset.height || 1 };
  const previewGeometry = useMemo(() => imagePreviewGeometry(sourceSize, frameSize), [frameSize, sourceSize.height, sourceSize.width]);
  const zoomLayerStyle = previewGeometry
    ? ({
        width: previewGeometry.width,
        height: previewGeometry.height,
        transform: `translate(${previewGeometry.offsetX + pan.x}px, ${previewGeometry.offsetY + pan.y}px) scale(${zoom})`,
      } as CSSProperties)
    : undefined;

  useEffect(() => {
    const updateFrameSize = () => {
      const frame = frameRef.current;
      if (!frame) return;
      const rect = frame.getBoundingClientRect();
      setFrameSize({ width: rect.width, height: rect.height });
    };
    updateFrameSize();
    const observer = new ResizeObserver(updateFrameSize);
    if (frameRef.current) observer.observe(frameRef.current);
    window.addEventListener("resize", updateFrameSize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateFrameSize);
    };
  }, [asset.url]);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setNaturalSize(null);
  }, [asset.id]);

  useEffect(() => {
    setPan((current) => clampImagePan(current, zoom, previewGeometry, frameSize));
  }, [frameSize, previewGeometry, zoom]);

  const measureFrame = () => {
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    setFrameSize({ width: rect.width, height: rect.height });
  };

  const handleImageLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight });
    }
    requestAnimationFrame(measureFrame);
  };

  const keepHoverCard = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };

  const scheduleHideHoverCard = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setHoverCard(null), 220);
  };

  const showHoverCard = (issue: Issue, target: HTMLElement) => {
    keepHoverCard();
    const rect = target.getBoundingClientRect();
    const cardWidth = 360;
    const gap = 12;
    const canOpenRight = rect.right + cardWidth + gap < window.innerWidth;
    const x = canOpenRight
      ? rect.right + gap
      : Math.max(16, Math.min(window.innerWidth - cardWidth - 16, rect.left - cardWidth - gap));
    const y = Math.max(16, Math.min(window.innerHeight - 240, rect.top));
    setHoverCard({ issue, x, y });
  };

  const applyZoom = (next: number | ((current: number) => number), point?: { clientX: number; clientY: number }) => {
    const frame = frameRef.current;
    setZoom((currentZoom) => {
      const nextZoom = clampValue(typeof next === "function" ? next(currentZoom) : next, 1, 4);
      if (!frame || !previewGeometry || !frameSize) {
        setPan(nextZoom <= 1.01 ? { x: 0, y: 0 } : pan);
        return nextZoom;
      }

      setPan((currentPan) => {
        if (nextZoom <= 1.01) return { x: 0, y: 0 };
        const rect = frame.getBoundingClientRect();
        const pointX = point ? point.clientX - rect.left : frameSize.width / 2;
        const pointY = point ? point.clientY - rect.top : frameSize.height / 2;
        const imageX = (pointX - previewGeometry.offsetX - currentPan.x) / currentZoom;
        const imageY = (pointY - previewGeometry.offsetY - currentPan.y) / currentZoom;
        return clampImagePan(
          {
            x: pointX - previewGeometry.offsetX - imageX * nextZoom,
            y: pointY - previewGeometry.offsetY - imageY * nextZoom,
          },
          nextZoom,
          previewGeometry,
          frameSize
        );
      });
      return nextZoom;
    });
  };

  const resetZoom = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleWheelZoom = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const direction = event.deltaY > 0 ? -1 : 1;
    applyZoom((current) => current + direction * 0.18, { clientX: event.clientX, clientY: event.clientY });
  };

  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (zoom <= 1.01 || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panStartRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    setIsPanning(true);
  };

  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = panStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    setPan(
      clampImagePan(
        {
          x: start.panX + event.clientX - start.startX,
          y: start.panY + event.clientY - start.startY,
        },
        zoom,
        previewGeometry,
        frameSize
      )
    );
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panStartRef.current?.pointerId === event.pointerId) {
      panStartRef.current = null;
      setIsPanning(false);
    }
  };

  const handleDeleteAsset = () => {
    const ok = window.confirm(`Delete "${asset.filename}" from this check? Related image issues and artboard placements will also be removed.`);
    if (ok) removeAsset(asset.id);
  };

  return (
    <div className="cp-asset-card">
      <div
        ref={frameRef}
        className="cp-asset-preview-frame"
        style={{ aspectRatio: `${sourceSize.width} / ${sourceSize.height}` }}
        data-zoomed={zoom > 1.01 ? "true" : "false"}
        data-panning={isPanning ? "true" : "false"}
        onWheel={handleWheelZoom}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onDoubleClick={resetZoom}
      >
        {zoomLayerStyle ? (
          <div className="cp-asset-zoom-layer" style={zoomLayerStyle}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={asset.url}
              alt={asset.filename}
              className="cp-asset-preview-image"
              draggable={false}
              onLoad={handleImageLoad}
            />
            {boxedIssues.map((issue) => {
              const style = imageIssueBoxStyle(issue, previewGeometry);
              if (!style) return null;
              return (
                <button
                  key={issue.issue_id}
                  type="button"
                  data-issue-id={issue.issue_id}
                  className="cp-image-issue-box"
                  data-selected={selectedIssueId === issue.issue_id ? "true" : "false"}
                  style={style}
                  aria-label={`Image issue: ${issue.original}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    selectIssue(issue.issue_id);
                    setTab("issues");
                  }}
                  onMouseEnter={(event) => showHoverCard(issue, event.currentTarget)}
                  onMouseLeave={scheduleHideHoverCard}
                />
              );
            })}
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={asset.url} alt={asset.filename} className="cp-asset-preview-image" draggable={false} onLoad={handleImageLoad} />
        )}
        <div className="cp-image-zoom-controls" onPointerDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="cp-image-zoom-button"
            onClick={() => applyZoom((current) => current - 0.25)}
            disabled={zoom <= 1.01}
            title="Zoom out"
            aria-label="Zoom out"
          >
            <MinusIcon />
          </button>
          <span className="cp-image-zoom-level">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            className="cp-image-zoom-button"
            onClick={() => applyZoom((current) => current + 0.25)}
            disabled={zoom >= 3.99}
            title="Zoom in"
            aria-label="Zoom in"
          >
            <PlusIcon />
          </button>
          <button
            type="button"
            className="cp-image-zoom-button"
            onClick={resetZoom}
            disabled={zoom <= 1.01}
            title="Reset zoom"
            aria-label="Reset zoom"
          >
            <ResetViewIcon />
          </button>
        </div>
      </div>
      {hoverCard && (
        <div
          data-space-issue-card="1"
          className="fixed z-[300]"
          style={{ left: hoverCard.x, top: hoverCard.y }}
          onMouseEnter={keepHoverCard}
          onMouseLeave={scheduleHideHoverCard}
        >
          <IssueHoverCard issue={hoverCard.issue} />
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-zinc-100" title={asset.filename}>{asset.filename}</p>
          <p className="mt-0.5 text-[11px] tabular-nums text-zinc-500">{asset.width}x{asset.height}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <span className={`rounded-full px-2 py-1 text-[11px] font-semibold ${badge.cls}`}>{badge.label}</span>
          {count > 0 && (
            <button type="button" className="rounded-full bg-red-500/15 px-2 py-1 text-[11px] font-semibold text-red-300" onClick={() => useQAStore.getState().setTab("issues")}>
              {count} issues
            </button>
          )}
          <button
            type="button"
            onClick={() => asset.ocr_status !== "processing" && void runOcr(asset.id)}
            className="cp-button cp-button-secondary cp-button-xs"
          >
            {asset.ocr_status === "processing" ? "Đang đọc chữ" : "Đọc lại chữ"}
          </button>
          <button
            type="button"
            onClick={handleDeleteAsset}
            className="cp-button cp-button-secondary cp-button-xs"
            title="Delete image"
            aria-label={`Delete ${asset.filename}`}
          >
            <TrashIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function BasicCheckMain() {
  const artboards = useQAStore((s) => s.artboards);
  const assets = useQAStore((s) => s.assets);
  const qaRunningTargets = useQAStore((s) => s.qaRunningTargets);
  const deepQaRunningTargets = useQAStore((s) => s.deepQaRunningTargets);
  const deepQaRunning = useQAStore((s) => s.deepQaRunning);
  const imageScanStatus = useQAStore((s) => s.cardScanStatus.__workspace__);
  const imageCheckLabel = useQAStore((s) => s.imageCheckLabel);
  const ensureCaptionArtboardAt = useQAStore((s) => s.ensureCaptionArtboardAt);
  const updateImageCheckLabel = useQAStore((s) => s.updateImageCheckLabel);
  const uploadFiles = useQAStore((s) => s.uploadFiles);
  const runQA = useQAStore((s) => s.runQA);
  const fileRef = useRef<HTMLInputElement>(null);
  const [imageDragActive, setImageDragActive] = useState(false);
  const captionArtboards = useMemo(
    () => artboards.filter((artboard) => artboardKind(artboard) === "caption").sort((a, b) => Number(!isPrimaryCaption(a)) - Number(!isPrimaryCaption(b))),
    [artboards]
  );
  const imageRunKey = "__workspace__";
  const running = Boolean(qaRunningTargets[imageRunKey] || deepQaRunningTargets[imageRunKey]);

  const addCaptionBox = () => {
    const nextIndex = captionArtboards.length;
    ensureCaptionArtboardAt(120, 120 + nextIndex * 760);
  };

  const uploadImageFiles = async (files: FileList | File[] | null | undefined) => {
    if (!files || files.length === 0) return;
    const imageFiles = Array.from(files).filter((file) =>
      file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(file.name)
    );
    if (imageFiles.length === 0) {
      window.alert("Typolice chỉ nhận file ảnh PNG, JPG, JPEG hoặc WebP.");
      return;
    }
    try {
      await uploadFiles(imageFiles);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Chưa upload được ảnh. Hãy thử lại với file PNG, JPG, JPEG hoặc WebP.");
    }
  };

  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-[var(--space-shell-bg)]">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-6 py-6">
        {deepQaRunning && (
          <div
            data-space-deep-scan-notice="1"
            className="cp-scan-notice"
          >
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-300" />
              <span className="font-semibold">Typolice vẫn đang rà soát...</span>
              <span className="ml-auto rounded-full bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-200">Đã hiện kết quả nhanh</span>
            </div>
            <p className="mt-0.5 text-amber-200/70">Lỗi mới vẫn có thể xuất hiện. Vui lòng đợi rà xong trước khi chốt nội dung.</p>
          </div>
        )}

        <div className="space-y-4">
          {captionArtboards.map((artboard, index) => (
            <CaptionCheckCard key={artboard.id} artboard={artboard} index={index} />
          ))}
          <div className="flex justify-center">
            <button type="button" onClick={addCaptionBox} className="cp-button cp-button-sm w-fit">
              <PlusIcon />
              Add New Caption
            </button>
          </div>
        </div>

        <section
          className="cp-main-card"
          data-drag-active={imageDragActive ? "true" : "false"}
          onDragEnter={(event) => {
            if (!Array.from(event.dataTransfer.types).includes("Files")) return;
            event.preventDefault();
            setImageDragActive(true);
          }}
          onDragOver={(event) => {
            if (!Array.from(event.dataTransfer.types).includes("Files")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setImageDragActive(true);
          }}
          onDragLeave={(event) => {
            const relatedTarget = event.relatedTarget as Node | null;
            if (relatedTarget && event.currentTarget.contains(relatedTarget)) return;
            setImageDragActive(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setImageDragActive(false);
            void uploadImageFiles(event.dataTransfer.files);
          }}
        >
          <div className="cp-main-card-header">
            <div className="min-w-0 flex-1">
              <input
                key={imageCheckLabel}
                defaultValue={imageCheckLabel}
                onBlur={(event) => updateImageCheckLabel(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
                aria-label="Rename image check"
                className="cp-card-title-input w-full"
              />
              <ScanStatusLine status={imageScanStatus} />
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="cp-card-action-button"
                title="Upload Images"
                aria-label="Upload Images"
              >
                <UploadIcon />
              </button>
              <button
                type="button"
                data-run-action-button="1"
                disabled={assets.length === 0 || running}
                onClick={() => void runQA("smart")}
                className="cp-card-action-button"
                title={running ? "Đang kiểm tra chữ trên ảnh" : "Kiểm tra chữ trên ảnh"}
                aria-label={running ? "Đang kiểm tra chữ trên ảnh" : "Kiểm tra chữ trên ảnh"}
              >
                <RunIcon />
              </button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event) => {
                if (event.target.files?.length) {
                  void uploadImageFiles(event.target.files);
                }
                event.target.value = "";
              }}
            />
          </div>
          <div className="cp-main-card-body grid gap-3">
            {assets.length === 0 ? (
              <div className="cp-empty-dropzone col-span-full" data-drag-active={imageDragActive ? "true" : "false"}>
                Drop or upload posters/banners here.
              </div>
            ) : (
              assets.map((asset) => <AssetCard key={asset.id} asset={asset} />)
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
