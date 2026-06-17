"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQAStore } from "@/lib/store";
import { ARTBOARD_PRESETS, SEVERITY_COLORS } from "@/lib/presets";
import { getAvailablePostLayouts, getLayoutSlotsFor, getPostLayout, type PostLayoutPreset } from "@/lib/postLayouts";
import IssueHoverCard from "@/components/IssueHoverCard";
import type { Artboard, ArtboardPreset, Asset, Issue, Layer } from "@/types";

/** Map an OCR bbox (asset px) into artboard px for one image slot. */
function bboxToLayer(
  bbox: [number, number, number, number],
  asset: Asset,
  layer: Layer,
  fit: "cover" | "contain"
): { left: number; top: number; width: number; height: number } {
  const scale =
    fit === "cover"
      ? Math.max(layer.width / asset.width, layer.height / asset.height)
      : Math.min(layer.width / asset.width, layer.height / asset.height);
  const offsetX = (asset.width * scale - layer.width) / 2;
  const offsetY = (asset.height * scale - layer.height) / 2;
  return {
    left: layer.x + bbox[0] * scale - offsetX,
    top: layer.y + bbox[1] * scale - offsetY,
    width: (bbox[2] - bbox[0]) * scale,
    height: (bbox[3] - bbox[1]) * scale,
  };
}

function artboardKind(ab: Artboard) {
  return ab.kind ?? (ab.format === "caption" ? "caption" : ab.format === "note" ? "note" : "visual");
}

const PRIMARY_CAPTION_ARTBOARD_ID = "artboard_caption";

function isPrimaryCaptionArtboard(ab: Artboard) {
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

const SNAP_THRESHOLD = 36;
const MIN_TEXT_BOARD_WIDTH = 640;
const MIN_TEXT_BOARD_HEIGHT = 360;
const VISUAL_ARTBOARD_HEADER_HEIGHT = 80;
const CONTEXT_MENU_WIDTH = 240;
const CONTEXT_MENU_HEIGHT = 360;
const CONTEXT_MENU_MARGIN = 12;
const LAYOUT_PICKER_WIDTH = 340;
const LAYOUT_PICKER_HEIGHT = 430;

type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

interface SpacePatternPointer {
  x: number;
  y: number;
  active: boolean;
}

const SPACE_BACKGROUND_STYLE: CSSProperties = {
  background: "var(--space-bg)",
};

const SLASH_GRID_X = 16;
const SLASH_GRID_Y = 16;
const SLASH_LENGTH = 4.8;
const SLASH_HOVER_RADIUS = 58;
const SLASH_BASE_ANGLE = Math.PI / 4;

const ARTBOARD_STROKE_COLORS = {
  caption: "240, 90, 34",
  facebook: "8, 102, 255",
  linkedin: "10, 102, 194",
  note: "251, 191, 36",
  default: "63, 63, 70",
};

interface SnapGuides {
  vertical: number[];
  horizontal: number[];
}

interface ContextMenuState {
  screenX: number;
  screenY: number;
  worldX: number;
  worldY: number;
}

interface SpaceIssueCardState {
  issue: Issue;
  x: number;
  y: number;
}

interface SpaceArtboardIssuesState {
  artboardId: string;
  label: string;
  issues: Issue[];
  x: number;
  y: number;
}

interface SpaceLayoutPickerState {
  artboardId: string;
  label: string;
  platform: Artboard["platform"];
  currentLayoutId: string;
  x: number;
  y: number;
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

function mixAngle(from: number, to: number, amount: number) {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * amount;
}

function compactPresetLabel(preset: ArtboardPreset) {
  return preset.label
    .replace(/^FB\s+/i, "")
    .replace(/^LI\s+/i, "")
    .replace("Cover Landscape", "Cover H")
    .replace("Cover Vertical", "Cover V")
    .replace("Single Landscape", "Single H")
    .replace("Single Vertical", "Single V")
    .replace("ảnh - chính", "")
    .replace("ảnh -", "")
    .replace(/\s+/g, " ")
    .trim();
}

function drawSpaceSlashPattern(canvas: HTMLCanvasElement, pointer: SpacePatternPointer) {
  const parent = canvas.parentElement;
  if (!parent) return;
  const width = parent.clientWidth;
  const height = parent.clientHeight;
  if (width <= 0 || height <= 0) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const patternRgb = getComputedStyle(parent).getPropertyValue("--space-pattern-rgb").trim() || "244, 244, 245";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.lineCap = "round";

  const startX = 8;
  const startY = 8;
  for (let y = startY; y < height + SLASH_GRID_Y; y += SLASH_GRID_Y) {
    for (let x = startX; x < width + SLASH_GRID_X; x += SLASH_GRID_X) {
      const dx = pointer.x - x;
      const dy = pointer.y - y;
      const distance = pointer.active ? Math.hypot(dx, dy) : Number.POSITIVE_INFINITY;
      const influence = pointer.active
        ? easeOutCubic(Math.max(0, 1 - distance / SLASH_HOVER_RADIUS))
        : 0;
      const targetAngle = pointer.active && distance > 1 ? Math.atan2(dy, dx) : SLASH_BASE_ANGLE;
      const angle = mixAngle(SLASH_BASE_ANGLE, targetAngle, influence * 0.9);
      const length = SLASH_LENGTH;
      const alpha = 0.18;
      const lineWidth = 0.82;
      const half = length / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      ctx.strokeStyle = `rgba(${patternRgb}, ${alpha})`;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.moveTo(x - cos * half, y - sin * half);
      ctx.lineTo(x + cos * half, y + sin * half);
      ctx.stroke();
    }
  }
}

function snapArtboard(
  movingId: string,
  x: number,
  y: number,
  width: number,
  height: number,
  artboards: Artboard[]
): { x: number; y: number; guides: SnapGuides } {
  const movingX = [x, x + width / 2, x + width];
  const movingY = [y, y + height / 2, y + height];
  let snapX: { delta: number; guide: number; distance: number } | null = null;
  let snapY: { delta: number; guide: number; distance: number } | null = null;

  for (const other of artboards) {
    if (other.id === movingId) continue;
    const targetX = [other.x, other.x + other.width / 2, other.x + other.width];
    const targetY = [other.y, other.y + other.height / 2, other.y + other.height];

    for (const from of movingX) {
      for (const to of targetX) {
        const distance = Math.abs(to - from);
        if (distance <= SNAP_THRESHOLD && (!snapX || distance < snapX.distance)) {
          snapX = { delta: to - from, guide: to, distance };
        }
      }
    }

    for (const from of movingY) {
      for (const to of targetY) {
        const distance = Math.abs(to - from);
        if (distance <= SNAP_THRESHOLD && (!snapY || distance < snapY.distance)) {
          snapY = { delta: to - from, guide: to, distance };
        }
      }
    }
  }

  return {
    x: x + (snapX?.delta ?? 0),
    y: y + (snapY?.delta ?? 0),
    guides: {
      vertical: snapX ? [snapX.guide] : [],
      horizontal: snapY ? [snapY.guide] : [],
    },
  };
}

interface CaptionSegment {
  text: string;
  issue: Issue | null;
}

function isActiveIssue(issue: Issue) {
  return issue.status === "open" || issue.status === "needs_human_review";
}

function issuesForArtboard(ab: Artboard, issues: Issue[]) {
  const kind = artboardKind(ab);
  const layerAssetIds = new Set(ab.layers.map((l) => l.asset_id));
  return issues.filter((issue) => {
    if (!isActiveIssue(issue)) return false;
    if (kind === "caption") {
      return isPrimaryCaptionArtboard(ab)
        ? isPrimaryCaptionIssue(issue)
        : issue.source_type === "caption" && issue.artboard_id === ab.id;
    }
    return issue.artboard_id === ab.id || (issue.source_type === "image" && layerAssetIds.has(issue.source_id));
  });
}

function canStartArtboardDrag(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return !target.closest(
    [
      "button",
      "input",
      "textarea",
      "select",
      "[contenteditable='true']",
      "[data-artboard-no-drag]",
      "[data-resize-corner]",
      "[data-artboard-control-dock]",
      "[data-artboard-action-dock]",
      "[data-layout-picker-button]",
      "[data-canvas-issue-card]",
      "[data-issue-id]",
    ].join(",")
  );
}

function shouldLetNestedElementHandleWheel(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest(
    [
      "input",
      "textarea",
      "select",
      "[contenteditable='true']",
      "[data-canvas-wheel-local]",
      "[data-artboard-no-drag]",
      "[data-canvas-issue-card]",
      "[data-space-issue-card]",
      "[data-space-artboard-issues]",
      "[data-space-layout-picker]",
    ].join(",")
  ));
}

function CanvasIssueCard({ issue }: { issue: Issue }) {
  return <IssueHoverCard issue={issue} />;
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

function EditableArtboardTitle({ ab, locked, className = "" }: { ab: Artboard; locked: boolean; className?: string }) {
  const updateArtboardLabel = useQAStore((s) => s.updateArtboardLabel);
  const [draftLabel, setDraftLabel] = useState(ab.label);

  useEffect(() => {
    setDraftLabel(ab.label);
  }, [ab.label]);

  const commit = () => {
    const clean = draftLabel.trim();
    const next = clean || ab.label;
    setDraftLabel(next);
    if (next !== ab.label) updateArtboardLabel(ab.id, next);
  };

  return (
    <input
      data-artboard-no-drag="1"
      value={draftLabel}
      readOnly={locked}
      onChange={(event) => setDraftLabel(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.preventDefault();
          setDraftLabel(ab.label);
          event.currentTarget.blur();
        }
      }}
      className={`cp-space-artboard-title-input ${className}`}
      aria-label={`Rename ${ab.label}`}
      title={locked ? "Artboard is locked" : "Rename artboard"}
    />
  );
}

function CaptionArtboardBody({
  ab,
  locked,
  showIssueCard,
  scheduleHideIssueCard,
}: {
  ab: Artboard;
  locked: boolean;
  showIssueCard: (issue: Issue, target: HTMLElement) => void;
  scheduleHideIssueCard: () => void;
}) {
  const isPrimary = isPrimaryCaptionArtboard(ab);
  const captionText = useQAStore((s) => s.captionText);
  const setCaption = useQAStore((s) => s.setCaption);
  const updateArtboardText = useQAStore((s) => s.updateArtboardText);
  const issues = useQAStore((s) => s.issues);
  const editorMode = useQAStore((s) => s.editorMode);
  const setEditorMode = useQAStore((s) => s.setEditorMode);
  const selectedIssueId = useQAStore((s) => s.selectedIssueId);
  const selectIssue = useQAStore((s) => s.selectIssue);
  const setTab = useQAStore((s) => s.setTab);
  const analyzing = useQAStore((s) => s.analyzing);

  const text = isPrimary ? captionText : ab.text ?? "";
  const openIssues = isPrimary
    ? issues.filter((i) => isPrimaryCaptionIssue(i) && i.status === "open")
    : issues.filter((i) => i.source_type === "caption" && i.artboard_id === ab.id && i.status === "open");
  const segments = useMemo(() => buildCaptionSegments(text, openIssues), [text, openIssues]);
  const effectiveEditorMode = editorMode;
  const handleTextChange = (nextText: string) => {
    if (isPrimary) setCaption(nextText);
    else updateArtboardText(ab.id, nextText);
  };

  return (
    <div className="flex h-full w-full flex-col bg-zinc-950 text-zinc-100">
      <div className="flex h-20 shrink-0 items-center gap-4 border-b border-zinc-800 px-9">
        <EditableArtboardTitle ab={ab} locked={locked} />
        {openIssues.length > 0 && (
          <span className="rounded-full bg-red-500/20 px-4 py-1 text-[22px] font-medium text-red-300">
            {openIssues.length} issues
          </span>
        )}
        {isPrimary && analyzing && <span className="text-[22px] text-zinc-500">checking...</span>}
        <div className="ml-auto flex rounded-xl border border-zinc-700 text-[22px]">
          <button
            onClick={() => setEditorMode("edit")}
            disabled={locked}
            title={locked ? "Artboard is locked" : "Edit caption"}
            className={`rounded-l-xl px-6 py-2 disabled:cursor-not-allowed disabled:opacity-40 ${
              editorMode === "edit" ? "bg-zinc-700 text-white" : "text-zinc-400"
            }`}
          >
            Edit
          </button>
          <button
            onClick={() => setEditorMode("review")}
            className={`rounded-r-xl px-6 py-2 ${editorMode === "review" ? "bg-zinc-700 text-white" : "text-zinc-400"}`}
          >
            Review
          </button>
        </div>
      </div>
      <div data-artboard-no-drag="1" data-canvas-wheel-local="1" className="cp-caption-type-area min-h-0 flex-1 cursor-default p-10">
        {effectiveEditorMode === "edit" ? (
          <textarea
            value={text}
            onChange={(e) => handleTextChange(e.target.value)}
            placeholder={isPrimary ? "Paste your caption here..." : "Paste your caption here..."}
            readOnly={locked}
            className={`cp-caption-type-box cp-caption-copy h-full w-full resize-none rounded-[12px] border p-6 shadow-inner shadow-black/10 outline-none ${
              locked ? "cursor-default opacity-75" : "cursor-text"
            }`}
            spellCheck={false}
          />
        ) : (
          <div data-canvas-wheel-local="1" className="cp-caption-copy h-full overflow-y-auto whitespace-pre-wrap text-zinc-100">
            {segments.length === 0 && <span className="text-zinc-700">No caption yet.</span>}
            {segments.map((seg, index) =>
              seg.issue ? (
                <span
                  key={`${seg.issue.issue_id}-${index}`}
                  data-issue-id={seg.issue.issue_id}
                  onClick={() => {
                    selectIssue(seg.issue!.issue_id);
                    setTab("issues");
                  }}
                  onMouseEnter={(e) => showIssueCard(seg.issue!, e.currentTarget)}
                  onMouseLeave={scheduleHideIssueCard}
                  className="cp-inline-issue-highlight"
                  data-selected={selectedIssueId === seg.issue.issue_id ? "true" : "false"}
                  style={{ "--issue-color": SEVERITY_COLORS[seg.issue.severity] } as CSSProperties}
                >
                  {seg.text}
                </span>
              ) : (
                <span key={`plain-${index}`}>{seg.text}</span>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function NoteArtboardBody({ ab }: { ab: Artboard }) {
  const updateArtboardText = useQAStore((s) => s.updateArtboardText);
  const locked = ab.locked === true;

  return (
    <div className="flex h-full w-full flex-col bg-amber-50 text-zinc-950">
      <div className="h-5 shrink-0 bg-amber-300" />
      <textarea
        data-artboard-no-drag="1"
        value={ab.text ?? ""}
        onChange={(e) => updateArtboardText(ab.id, e.target.value)}
        placeholder="Note..."
        readOnly={locked}
        className={`min-h-0 flex-1 resize-none bg-transparent p-10 text-[42px] leading-[1.35] outline-none placeholder:text-amber-700/50 ${
          locked ? "cursor-default opacity-75" : "cursor-text"
        }`}
        spellCheck={false}
      />
    </div>
  );
}

function LayoutMini({ layout, platform }: { layout: PostLayoutPreset; platform: Artboard["platform"] }) {
  const slots = getLayoutSlotsFor(layout.id, platform, 52, 36);
  return (
    <div className="relative h-9 w-[52px] shrink-0 rounded-sm bg-zinc-950">
      {slots.map((slot) => (
        <span
          key={slot.id}
          className="absolute rounded-[2px] bg-zinc-600"
          style={{ left: slot.x, top: slot.y, width: slot.width, height: slot.height }}
        />
      ))}
    </div>
  );
}

function LayoutIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 fill-none stroke-current stroke-[1.7]">
      <rect x="3" y="3" width="6" height="6" rx="1.2" />
      <rect x="11" y="3" width="6" height="6" rx="1.2" />
      <rect x="3" y="11" width="14" height="6" rx="1.2" />
    </svg>
  );
}

function LayoutPicker({
  ab,
  currentLayout,
  disabled,
  toggleLayoutPicker,
}: {
  ab: Artboard;
  currentLayout: PostLayoutPreset;
  disabled?: boolean;
  toggleLayoutPicker: (ab: Artboard, currentLayout: PostLayoutPreset, target: HTMLElement) => void;
}) {
  return (
    <div className="relative" onPointerDown={(e) => e.stopPropagation()}>
      <button
        data-layout-picker-button="1"
        onClick={(e) => {
          e.stopPropagation();
          if (disabled) return;
          toggleLayoutPicker(ab, currentLayout, e.currentTarget);
        }}
        disabled={disabled}
        aria-label={`Change layout: ${currentLayout.shortLabel}`}
        className="cp-artboard-button"
        title={disabled ? "Artboard is locked" : currentLayout.description}
      >
        <LayoutIcon />
      </button>
    </div>
  );
}

function LockIcon({ locked }: { locked: boolean }) {
  return locked ? (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4 fill-none stroke-current stroke-[1.7]">
      <path d="M4.4 7V5.4a3.6 3.6 0 0 1 7.2 0V7" />
      <rect x="3.2" y="6.8" width="9.6" height="6.7" rx="1.4" />
      <path d="M8 9.5v1.3" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4 fill-none stroke-current stroke-[1.7]">
      <path d="M5.2 7V5.2a3 3 0 0 1 5.7-1.3" />
      <rect x="3.2" y="6.8" width="9.6" height="6.7" rx="1.4" />
      <path d="M8 9.5v1.3" />
    </svg>
  );
}

function LockButton({
  locked,
  label,
  onToggle,
}: {
  locked: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-artboard-lock-button="1"
      aria-pressed={locked}
      aria-label={locked ? `Unlock ${label}` : `Lock ${label}`}
      title={locked ? "Unlock artboard" : "Lock artboard"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className={`cp-artboard-button ${
        locked
          ? "border-[#f05a22]/70 bg-[#f05a22]/12 text-[#ff9a72]"
          : ""
      }`}
    >
      <LockIcon locked={locked} />
    </button>
  );
}

function IssuesButton({
  count,
  onClick,
}: {
  count: number;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      data-artboard-issues-button="1"
      aria-label={`${count} artboard issues`}
      title={`${count} issue${count > 1 ? "s" : ""}`}
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      className="relative grid h-8 w-8 place-items-center rounded-full border border-red-500/35 bg-red-950/35 text-red-200 shadow-lg shadow-black/25 transition-colors hover:border-red-400/70 hover:bg-red-950/60"
    >
      <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 fill-none stroke-current stroke-[1.8]">
        <path d="M10 3.2 17 16H3L10 3.2Z" />
        <path d="M10 7.7v3.7M10 14.1h.01" />
      </svg>
      <span className="absolute -right-1.5 -top-1.5 min-w-4 rounded-full bg-red-500 px-1 text-center text-[9px] font-bold leading-4 text-white shadow shadow-black/40">
        {count}
      </span>
    </button>
  );
}

function RemoveArtboardButton({
  locked,
  onRemove,
}: {
  locked: boolean;
  onRemove: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      aria-label="Remove artboard"
      title={locked ? "Artboard is locked" : "Remove artboard"}
      onClick={onRemove}
      onPointerDown={(e) => e.stopPropagation()}
      disabled={locked}
      className="cp-artboard-button text-zinc-500 hover:border-red-500/50 hover:text-red-300 disabled:hover:border-zinc-700 disabled:hover:text-zinc-500"
    >
      <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 fill-none stroke-current stroke-[1.8]">
        <path d="m6 6 8 8M14 6l-8 8" />
      </svg>
    </button>
  );
}

function EdgeResizeHandles({
  kind,
  onPointerDown,
  scale,
}: {
  kind: "caption" | "note";
  onPointerDown: (direction: ResizeDirection, e: React.PointerEvent) => void;
  scale: number;
}) {
  const isCaption = kind === "caption";
  const hit = 18 / scale;
  const halfHit = hit / 2;
  const directions: ResizeDirection[] = ["nw", "ne", "sw", "se"];

  const handleStyle = (direction: ResizeDirection): CSSProperties => {
    const cursor = direction === "nw" || direction === "se" ? "nwse-resize" : "nesw-resize";

    return {
      cursor,
      touchAction: "none",
      width: hit,
      height: hit,
      ...(direction.includes("n") ? { top: -halfHit } : { bottom: -halfHit }),
      ...(direction.includes("w") ? { left: -halfHit } : { right: -halfHit }),
    };
  };

  return (
    <>
      {directions.map((direction) => {
        return (
          <div
            key={direction}
            data-resize-corner={direction}
            data-resize-kind={kind}
            title={isCaption ? "Resize caption" : "Resize note"}
            onPointerDown={(e) => onPointerDown(direction, e)}
            className="absolute z-[4] select-none"
            style={handleStyle(direction)}
          />
        );
      })}
    </>
  );
}

function ActionIcon({ name }: { name: "deep-check" | "deep-scan" | "run" }) {
  if (name === "run") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5 shrink-0 fill-current">
        <path d="M6.4 4.9c0-.7.76-1.13 1.36-.77l8.1 4.86c.58.35.58 1.19 0 1.54l-8.1 4.86c-.6.36-1.36-.07-1.36-.77V4.9Z" />
      </svg>
    );
  }

  if (name === "deep-scan") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 shrink-0 fill-none stroke-current stroke-[1.8]">
        <path d="M5 7V5h2M13 5h2v2M15 13v2h-2M7 15H5v-2" />
        <path d="M7 10h6" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 shrink-0 fill-none stroke-current stroke-[1.9]">
      <circle cx="10" cy="10" r="6.2" />
      <path d="m7.2 10.15 1.85 1.85 3.85-4.1" />
    </svg>
  );
}

function ActionButton({
  icon,
  label,
  title,
  className,
  disabled,
  onClick,
}: {
  icon: "deep-check" | "deep-scan" | "run";
  label: string;
  title: string;
  className: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-run-action-button={icon === "run" ? "1" : undefined}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title}
      className={`cp-artboard-button group relative overflow-visible ${className}`}
    >
      <ActionIcon name={icon} />
      <span className="pointer-events-none absolute left-full top-1/2 z-[2] ml-2 -translate-y-1/2 whitespace-nowrap rounded-full border border-[#f05a22]/35 bg-zinc-950/95 px-2.5 py-1 text-[11px] font-semibold text-[#ff9a72] opacity-0 shadow-xl shadow-black/30 backdrop-blur transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100 -translate-x-1">
        {label}
      </span>
    </button>
  );
}

function ArtboardActionBar({
  artboardId,
  kind,
  isPrimaryCaption,
}: {
  artboardId: string;
  kind: Artboard["kind"];
  isPrimaryCaption: boolean;
}) {
  const runQA = useQAStore((s) => s.runQA);
  const qaRunningTargets = useQAStore((s) => s.qaRunningTargets);
  const deepQaRunningTargets = useQAStore((s) => s.deepQaRunningTargets);
  const running = Boolean(qaRunningTargets[artboardId] || deepQaRunningTargets[artboardId]);

  if (kind === "note") return null;

  const stopPointer = (event: React.PointerEvent) => event.stopPropagation();

  return (
    <div
      data-artboard-actions="1"
      className="inline-flex flex-col items-center gap-1"
      onPointerDown={stopPointer}
      onClick={(e) => e.stopPropagation()}
    >
      <ActionButton
        icon="run"
        label={running ? "Running" : "Run"}
        title="Chạy QA nhanh trước, rồi tự chạy deep caption + image text scan ở nền nếu model đã cấu hình."
        onClick={() => void runQA("smart", artboardId)}
        disabled={running}
        className=""
      />
    </div>
  );
}

function ArtboardView({
  ab,
  scale,
  artboards,
  setSnapGuides,
  showIssueCard,
  scheduleHideIssueCard,
  toggleArtboardIssues,
  toggleLayoutPicker,
}: {
  ab: Artboard;
  scale: number;
  artboards: Artboard[];
  setSnapGuides: (guides: SnapGuides) => void;
  showIssueCard: (issue: Issue, target: HTMLElement) => void;
  scheduleHideIssueCard: () => void;
  toggleArtboardIssues: (ab: Artboard, issues: Issue[], target: HTMLElement) => void;
  toggleLayoutPicker: (ab: Artboard, currentLayout: PostLayoutPreset, target: HTMLElement) => void;
}) {
  const assets = useQAStore((s) => s.assets);
  const issues = useQAStore((s) => s.issues);
  const selectedIssueId = useQAStore((s) => s.selectedIssueId);
  const selectIssue = useQAStore((s) => s.selectIssue);
  const setTab = useQAStore((s) => s.setTab);
  const dropAssetOnArtboard = useQAStore((s) => s.dropAssetOnArtboard);
  const uploadFilesToArtboardSlot = useQAStore((s) => s.uploadFilesToArtboardSlot);
  const removeArtboard = useQAStore((s) => s.removeArtboard);
  const setLayerFit = useQAStore((s) => s.setLayerFit);
  const moveArtboard = useQAStore((s) => s.moveArtboard);
  const resizeArtboard = useQAStore((s) => s.resizeArtboard);
  const toggleArtboardLock = useQAStore((s) => s.toggleArtboardLock);
  const [dragOver, setDragOver] = useState(false);
  const slotUploadInputRef = useRef<HTMLInputElement>(null);
  const pendingUploadSlotRef = useRef<string | null>(null);

  const kind = artboardKind(ab);
  const isPrimaryCaption = kind === "caption" && isPrimaryCaptionArtboard(ab);
  const locked = ab.locked === true;
  const currentLayout = getPostLayout(ab.layout_id, ab.platform);
  const visualHeaderHeight = kind === "visual" ? VISUAL_ARTBOARD_HEADER_HEIGHT : 0;
  const layoutHeight = kind === "visual" ? Math.max(1, ab.height - visualHeaderHeight) : ab.height;
  const layoutSlots = useMemo(
    () => getLayoutSlotsFor(currentLayout.id, ab.platform, ab.width, layoutHeight),
    [currentLayout.id, ab.platform, ab.width, layoutHeight]
  );
  const slotById = useMemo(() => new Map(layoutSlots.map((slot) => [slot.id, slot])), [layoutSlots]);
  const visualLayers = useMemo(
    () =>
      ab.layers.map((layer, index) => {
        const fallbackSlot = layoutSlots[Math.min(index, Math.max(0, layoutSlots.length - 1))];
        const slot = layer.slot_id ? slotById.get(layer.slot_id) ?? fallbackSlot : fallbackSlot;
        return slot
          ? { ...layer, slot_id: slot.id, x: slot.x, y: slot.y + visualHeaderHeight, width: slot.width, height: slot.height }
          : layer;
      }),
    [ab.layers, layoutSlots, slotById, visualHeaderHeight]
  );
  const layerBySlot = useMemo(
    () => new Map(visualLayers.map((layer) => [layer.slot_id ?? "slot_1", layer])),
    [visualLayers]
  );
  const artboardIssues = useMemo(() => issuesForArtboard(ab, issues), [ab, issues]);

  const startDrag = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    e.preventDefault();
    if (locked) return;
    const startX = e.clientX, startY = e.clientY;
    const origX = ab.x, origY = ab.y;
    const onMove = (ev: PointerEvent) => {
      const rawX = origX + (ev.clientX - startX) / scale;
      const rawY = origY + (ev.clientY - startY) / scale;
      const snapped = snapArtboard(ab.id, rawX, rawY, ab.width, ab.height, artboards);
      moveArtboard(ab.id, snapped.x, snapped.y);
      setSnapGuides(snapped.guides);
    };
    const onUp = () => {
      setSnapGuides({ vertical: [], horizontal: [] });
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const startDragFromArtboard = (e: React.PointerEvent) => {
    if (!canStartArtboardDrag(e.target)) return;
    startDrag(e);
  };

  const startResize = (direction: ResizeDirection, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (locked) return;
    const startX = e.clientX, startY = e.clientY;
    const origX = ab.x, origY = ab.y;
    const origWidth = ab.width, origHeight = ab.height;
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / scale;
      const dy = (ev.clientY - startY) / scale;
      let nextX = origX;
      let nextY = origY;
      let nextWidth = origWidth;
      let nextHeight = origHeight;

      if (direction.includes("e")) {
        nextWidth = Math.max(MIN_TEXT_BOARD_WIDTH, Math.round(origWidth + dx));
      }
      if (direction.includes("s")) {
        nextHeight = Math.max(MIN_TEXT_BOARD_HEIGHT, Math.round(origHeight + dy));
      }
      if (direction.includes("w")) {
        nextWidth = Math.max(MIN_TEXT_BOARD_WIDTH, Math.round(origWidth - dx));
        nextX = Math.round(origX + (origWidth - nextWidth));
      }
      if (direction.includes("n")) {
        nextHeight = Math.max(MIN_TEXT_BOARD_HEIGHT, Math.round(origHeight - dy));
        nextY = Math.round(origY + (origHeight - nextHeight));
      }

      if (nextX !== origX || nextY !== origY) moveArtboard(ab.id, nextX, nextY);
      if (nextWidth !== origWidth || nextHeight !== origHeight) resizeArtboard(ab.id, nextWidth, nextHeight);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const uploadFilesIntoSlot = useCallback(async (files: FileList | File[], slotId?: string) => {
    if (locked) return;
    try {
      await uploadFilesToArtboardSlot(files, ab.id, slotId);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Typolice chưa upload được ảnh này. Hãy thử lại với file PNG, JPG hoặc WebP.");
    }
  }, [ab.id, locked, uploadFilesToArtboardSlot]);

  const openSlotUpload = useCallback((slotId: string) => {
    if (locked) return;
    pendingUploadSlotRef.current = slotId;
    if (slotUploadInputRef.current) {
      slotUploadInputRef.current.value = "";
      slotUploadInputRef.current.click();
    }
  }, [locked]);

  const labelScale = Math.min(3, 1 / scale);
  const actionScale = 0.78 / scale;
  const runActionScale = actionScale;
  const actionGap = 9 / scale;
  const artboardStroke = 1 / scale;
  const visualStrokeColor =
    ab.platform === "facebook"
      ? ARTBOARD_STROKE_COLORS.facebook
      : ab.platform === "linkedin"
        ? ARTBOARD_STROKE_COLORS.linkedin
        : ARTBOARD_STROKE_COLORS.default;
  const captionFrameStyle: CSSProperties = {
    boxShadow: `0 0 0 ${artboardStroke}px rgba(${ARTBOARD_STROKE_COLORS.caption}, 0.76)`,
  };
  const noteFrameStyle: CSSProperties = {
    boxShadow: `0 0 0 ${artboardStroke}px rgba(${ARTBOARD_STROKE_COLORS.note}, 0.78)`,
  };
  const visualFrameStyle: CSSProperties = {
    boxShadow: dragOver
      ? `0 0 0 ${artboardStroke}px rgba(${visualStrokeColor}, 0.9)`
      : `0 0 0 ${artboardStroke}px rgba(${visualStrokeColor}, 0.78)`,
  };

  return (
    <div
      className={`absolute ${locked ? "cursor-default" : "cursor-grab active:cursor-grabbing"}`}
      data-artboard-id={ab.id}
      data-artboard-kind={kind}
      data-artboard-locked={locked ? "true" : "false"}
      onPointerDown={startDragFromArtboard}
      style={{ left: ab.x, top: ab.y, width: ab.width, height: ab.height }}
    >
      {/* Artboard controls stay modest on screen while the canvas zooms. */}
      <div
        data-artboard-control-dock="1"
        className="absolute z-[125] flex select-none flex-col items-center gap-1"
        style={{
          left: ab.width + actionGap,
          top: kind !== "note" ? 36 / scale : 0,
          transform: `scale(${actionScale})`,
          transformOrigin: "left top",
        }}
      >
        <LockButton
          locked={locked}
          label={ab.label}
          onToggle={() => toggleArtboardLock(ab.id)}
        />
        {(!isPrimaryCaption || kind !== "caption") && artboardIssues.length > 0 && (
          <IssuesButton
            count={artboardIssues.length}
            onClick={(e) => {
              e.stopPropagation();
              toggleArtboardIssues(ab, artboardIssues, e.currentTarget);
            }}
          />
        )}
        {kind === "visual" && (
          <LayoutPicker
            ab={ab}
            currentLayout={currentLayout}
            disabled={locked}
            toggleLayoutPicker={toggleLayoutPicker}
          />
        )}
        {!isPrimaryCaption && (
          <RemoveArtboardButton
            locked={locked}
            onRemove={(e) => {
              e.stopPropagation();
              removeArtboard(ab.id);
            }}
          />
        )}
      </div>

      {kind === "caption" ? (
        <>
          <div
            className="relative h-full w-full overflow-hidden rounded-[15px]"
            style={captionFrameStyle}
          >
            <CaptionArtboardBody
              ab={ab}
              locked={locked}
              showIssueCard={showIssueCard}
              scheduleHideIssueCard={scheduleHideIssueCard}
            />
          </div>
          {!locked && (
            <EdgeResizeHandles kind="caption" scale={scale} onPointerDown={startResize} />
          )}
        </>
      ) : kind === "note" ? (
        <>
          <div
            className="relative h-full w-full overflow-hidden rounded-[15px]"
            style={noteFrameStyle}
          >
            <NoteArtboardBody ab={ab} />
          </div>
          {!locked && (
            <EdgeResizeHandles kind="note" scale={scale} onPointerDown={startResize} />
          )}
        </>
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (locked) return;
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (locked) return;
            if (e.dataTransfer.files?.length) {
              void uploadFilesIntoSlot(e.dataTransfer.files);
              return;
            }
            const assetId = e.dataTransfer.getData("application/x-asset-id");
            if (assetId) dropAssetOnArtboard(ab.id, assetId);
          }}
          className="cp-visual-artboard relative h-full w-full overflow-hidden rounded-[15px] bg-zinc-950 text-zinc-100"
          style={visualFrameStyle}
          data-layout-id={currentLayout.id}
        >
          <input
            ref={slotUploadInputRef}
            data-artboard-no-drag="1"
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const slotId = pendingUploadSlotRef.current;
              pendingUploadSlotRef.current = null;
              if (e.currentTarget.files?.length) {
                void uploadFilesIntoSlot(e.currentTarget.files, slotId ?? undefined);
              }
              e.currentTarget.value = "";
            }}
          />
          <div className="cp-visual-artboard-header flex h-20 shrink-0 items-center gap-4 border-b border-zinc-800 px-9">
            <EditableArtboardTitle ab={ab} locked={locked} />
            {artboardIssues.length > 0 && (
              <span className="rounded-full bg-red-500/20 px-4 py-1 text-[22px] font-medium text-red-300">
                {artboardIssues.length} issues
              </span>
            )}
          </div>
          {layoutSlots.map((slot) => {
            const layer = layerBySlot.get(slot.id);
            const asset = layer ? assets.find((a) => a.id === layer.asset_id) : undefined;
            const empty = !asset || !layer;
            return (
              <div
                key={slot.id}
                data-layout-slot={slot.id}
                data-artboard-no-drag={empty ? "1" : undefined}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (locked) return;
                  setDragOver(true);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragOver(false);
                  if (locked) return;
                  if (e.dataTransfer.files?.length) {
                    void uploadFilesIntoSlot(e.dataTransfer.files, slot.id);
                    return;
                  }
                  const assetId = e.dataTransfer.getData("application/x-asset-id");
                  if (assetId) dropAssetOnArtboard(ab.id, assetId, slot.id);
                }}
                onPointerDown={(e) => {
                  if (empty) e.stopPropagation();
                }}
                onClick={(e) => {
                  if (!empty || locked) return;
                  e.stopPropagation();
                  openSlotUpload(slot.id);
                }}
                className={`group absolute overflow-hidden bg-zinc-950 transition-colors ${
                  empty
                    ? locked
                      ? "border border-dashed border-zinc-700"
                      : "cursor-pointer border border-dashed border-zinc-700 hover:border-[#f05a22]/70 hover:bg-[#f05a22]/5"
                    : "border border-zinc-950"
                }`}
                style={{ left: slot.x, top: slot.y + visualHeaderHeight, width: slot.width, height: slot.height }}
              >
                {asset && layer ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={asset.url}
                      alt={asset.filename}
                      className="h-full w-full"
                      style={{ objectFit: layer.fit_mode }}
                      draggable={false}
                    />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (locked) return;
                        setLayerFit(ab.id, layer.id, layer.fit_mode === "cover" ? "contain" : "cover");
                      }}
                      disabled={locked}
                      className="cp-button cp-button-secondary cp-button-xs absolute right-2 top-2 opacity-0 backdrop-blur transition-opacity group-hover:opacity-100 disabled:opacity-0"
                    >
                      {layer.fit_mode}
                    </button>
                  </>
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-zinc-950/70 px-3">
                    <span className="select-none text-center font-semibold text-zinc-600" style={{ fontSize: 22 * labelScale }}>
                      {slot.label}
                    </span>
                    {!locked && (
                      <span className="select-none text-center font-medium text-zinc-500 opacity-0 transition-opacity group-hover:opacity-100" style={{ fontSize: 13 * labelScale }}>
                        Click/drop image
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* OCR issue overlays */}
          {visualLayers.flatMap((layer) => {
            const asset = assets.find((a) => a.id === layer.asset_id);
            if (!asset) return [];
            return issues
              .filter((issue) => issue.source_id === asset.id && issue.bbox && issue.status === "open")
              .map((issue) => {
                const pos = bboxToLayer(issue.bbox!, asset, layer, layer.fit_mode);
                const color =
                  issue.is_definite_error ? SEVERITY_COLORS.critical
                  : issue.severity === "needs_review" ? SEVERITY_COLORS.medium
                  : SEVERITY_COLORS.low;
                const selected = selectedIssueId === issue.issue_id;
                return (
                  <div
                    key={`${layer.id}-${issue.issue_id}`}
                    data-artboard-no-drag="1"
                    onMouseEnter={(e) => showIssueCard(issue, e.currentTarget)}
                    onMouseLeave={scheduleHideIssueCard}
                    onClick={(e) => {
                      e.stopPropagation();
                      selectIssue(issue.issue_id);
                      setTab("issues");
                    }}
                    className={`absolute cursor-pointer ${selected ? "animate-pulse" : ""}`}
                    style={{
                      left: pos.left,
                      top: pos.top,
                      width: pos.width,
                      height: pos.height,
                      border: `${Math.max(2, 3 * labelScale)}px solid ${color}`,
                      backgroundColor: `${color}1a`,
                      boxShadow: selected ? `0 0 0 ${4 * labelScale}px ${color}66` : undefined,
                    }}
                    title={`${issue.original} → ${issue.suggestion}`}
                  />
                );
              });
          })}
        </div>
      )}

      {kind !== "note" && (
        <div
          data-artboard-action-dock="1"
          className="absolute z-[125] select-none"
          style={{
            left: ab.width + actionGap,
            top: 0,
            transform: `scale(${runActionScale})`,
            transformOrigin: "left top",
          }}
        >
          <ArtboardActionBar artboardId={ab.id} kind={kind} isPrimaryCaption={isPrimaryCaption} />
        </div>
      )}
    </div>
  );
}

export default function CanvasArea() {
  const artboards = useQAStore((s) => s.artboards);
  const addArtboard = useQAStore((s) => s.addArtboard);
  const ensureCaptionArtboardAt = useQAStore((s) => s.ensureCaptionArtboardAt);
  const deepQaRunning = useQAStore((s) => s.deepQaRunning);
  const [view, setView] = useState({ x: 56, y: 92, scale: 0.22 });
  const [snapGuides, setSnapGuides] = useState<SnapGuides>({ vertical: [], horizontal: [] });
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [spaceIssueCard, setSpaceIssueCard] = useState<SpaceIssueCardState | null>(null);
  const [spaceArtboardIssues, setSpaceArtboardIssues] = useState<SpaceArtboardIssuesState | null>(null);
  const [spaceLayoutPicker, setSpaceLayoutPicker] = useState<SpaceLayoutPickerState | null>(null);
  const panRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const issueCardHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const slashCanvasRef = useRef<HTMLCanvasElement>(null);
  const slashPointerRef = useRef<SpacePatternPointer>({ x: 0, y: 0, active: false });
  const slashFrameRef = useRef<number | null>(null);
  const notePreset = ARTBOARD_PRESETS.find((p) => p.kind === "note")!;
  const facebookPresets = ARTBOARD_PRESETS.filter((p) => p.platform === "facebook");
  const linkedinPresets = ARTBOARD_PRESETS.filter((p) => p.platform === "linkedin");
  const setArtboardLayout = useQAStore((s) => s.setArtboardLayout);

  const queueSlashPatternDraw = useCallback(() => {
    if (slashFrameRef.current !== null) return;
    slashFrameRef.current = window.requestAnimationFrame(() => {
      slashFrameRef.current = null;
      const canvas = slashCanvasRef.current;
      if (canvas) drawSpaceSlashPattern(canvas, slashPointerRef.current);
    });
  }, []);

  useEffect(() => {
    queueSlashPatternDraw();
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(queueSlashPatternDraw);
    observer.observe(container);
    window.addEventListener("resize", queueSlashPatternDraw);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", queueSlashPatternDraw);
      if (slashFrameRef.current !== null) {
        window.cancelAnimationFrame(slashFrameRef.current);
        slashFrameRef.current = null;
      }
    };
  }, [queueSlashPatternDraw]);

  const keepIssueCard = useCallback(() => {
    if (issueCardHideTimer.current) clearTimeout(issueCardHideTimer.current);
    issueCardHideTimer.current = null;
  }, []);

  const scheduleHideIssueCard = useCallback(() => {
    if (issueCardHideTimer.current) clearTimeout(issueCardHideTimer.current);
    issueCardHideTimer.current = setTimeout(() => setSpaceIssueCard(null), 240);
  }, []);

  const showIssueCard = useCallback((issue: Issue, target: HTMLElement) => {
    keepIssueCard();
    setSpaceLayoutPicker(null);
    const canvasRect = containerRef.current?.getBoundingClientRect();
    if (!canvasRect) return;
    const targetRect = target.getBoundingClientRect();
    const margin = 12;
    const cardWidth = 380;
    const cardHeight = 230;
    let x = targetRect.left - canvasRect.left;
    let y = targetRect.bottom - canvasRect.top + 12;
    if (x + cardWidth > canvasRect.width - margin) {
      x = canvasRect.width - cardWidth - margin;
    }
    if (y + cardHeight > canvasRect.height - margin) {
      y = targetRect.top - canvasRect.top - cardHeight - 12;
    }
    setSpaceIssueCard({
      issue,
      x: Math.max(margin, x),
      y: Math.max(margin, Math.min(y, canvasRect.height - cardHeight - margin)),
    });
  }, [keepIssueCard]);

  const toggleArtboardIssues = useCallback((ab: Artboard, artboardIssues: Issue[], target: HTMLElement) => {
    setSpaceIssueCard(null);
    setSpaceLayoutPicker(null);
    setSpaceArtboardIssues((current) => {
      if (current?.artboardId === ab.id) return null;
      const canvasRect = containerRef.current?.getBoundingClientRect();
      if (!canvasRect) return null;
      const targetRect = target.getBoundingClientRect();
      const margin = 12;
      const popoverWidth = 404;
      const popoverHeight = Math.min(460, 42 + artboardIssues.length * 126);
      let x = targetRect.left - canvasRect.left;
      let y = targetRect.bottom - canvasRect.top + 8;
      if (x + popoverWidth > canvasRect.width - margin) {
        x = canvasRect.width - popoverWidth - margin;
      }
      if (y + popoverHeight > canvasRect.height - margin) {
        y = targetRect.top - canvasRect.top - popoverHeight - 8;
      }
      return {
        artboardId: ab.id,
        label: ab.label,
        issues: artboardIssues,
        x: Math.max(margin, x),
        y: Math.max(margin, Math.min(y, canvasRect.height - popoverHeight - margin)),
      };
    });
  }, []);

  const toggleLayoutPicker = useCallback((ab: Artboard, currentLayout: PostLayoutPreset, target: HTMLElement) => {
    setSpaceIssueCard(null);
    setSpaceArtboardIssues(null);
    setSpaceLayoutPicker((current) => {
      if (current?.artboardId === ab.id) return null;
      const canvasRect = containerRef.current?.getBoundingClientRect();
      if (!canvasRect) return null;
      const targetRect = target.getBoundingClientRect();
      const margin = 12;
      let x = targetRect.left - canvasRect.left;
      let y = targetRect.bottom - canvasRect.top + 8;
      if (x + LAYOUT_PICKER_WIDTH > canvasRect.width - margin) {
        x = canvasRect.width - LAYOUT_PICKER_WIDTH - margin;
      }
      if (y + LAYOUT_PICKER_HEIGHT > canvasRect.height - margin) {
        y = targetRect.top - canvasRect.top - LAYOUT_PICKER_HEIGHT - 8;
      }
      return {
        artboardId: ab.id,
        label: ab.label,
        platform: ab.platform,
        currentLayoutId: currentLayout.id,
        x: Math.max(margin, x),
        y: Math.max(margin, Math.min(y, canvasRect.height - LAYOUT_PICKER_HEIGHT - margin)),
      };
    });
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (shouldLetNestedElementHandleWheel(e.target)) {
      return;
    }
    e.preventDefault();
    const rect = containerRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    setView((v) => {
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const scale = Math.min(2, Math.max(0.04, v.scale * factor));
      // zoom toward the cursor
      const wx = (mx - v.x) / v.scale;
      const wy = (my - v.y) / v.scale;
      return { scale, x: mx - wx * scale, y: my - wy * scale };
    });
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-context-menu]")) return;
    if (!(e.target as HTMLElement).closest("[data-space-issue-card]")) setSpaceIssueCard(null);
    if (!(e.target as HTMLElement).closest("[data-space-artboard-issues]")) setSpaceArtboardIssues(null);
    if (!(e.target as HTMLElement).closest("[data-space-layout-picker]")) setSpaceLayoutPicker(null);
    if (contextMenu) setContextMenu(null);
    if (e.button !== 0) return;
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.canvasBg) return;
    panRef.current = { startX: e.clientX, startY: e.clientY, origX: view.x, origY: view.y };
    const onMove = (ev: PointerEvent) => {
      const p = panRef.current;
      if (!p) return;
      setView((v) => ({ ...v, x: p.origX + ev.clientX - p.startX, y: p.origY + ev.clientY - p.startY }));
    };
    const onUp = () => {
      panRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onSpacePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    slashPointerRef.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      active: true,
    };
    queueSlashPatternDraw();
  }, [queueSlashPatternDraw]);

  const onSpacePointerLeave = useCallback(() => {
    slashPointerRef.current = { ...slashPointerRef.current, active: false };
    queueSlashPatternDraw();
  }, [queueSlashPatternDraw]);

  const openContextMenu = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-artboard-root]") || target.closest("[data-context-menu]")) return;
    e.preventDefault();
    const rect = containerRef.current!.getBoundingClientRect();
    const rawX = e.clientX - rect.left;
    const rawY = e.clientY - rect.top;
    setContextMenu({
      screenX: Math.max(
        CONTEXT_MENU_MARGIN,
        Math.min(rawX, rect.width - CONTEXT_MENU_WIDTH - CONTEXT_MENU_MARGIN)
      ),
      screenY: Math.max(
        CONTEXT_MENU_MARGIN,
        Math.min(rawY, rect.height - CONTEXT_MENU_HEIGHT - CONTEXT_MENU_MARGIN)
      ),
      worldX: (rawX - view.x) / view.scale,
      worldY: (rawY - view.y) / view.scale,
    });
    setSpaceIssueCard(null);
    setSpaceArtboardIssues(null);
    setSpaceLayoutPicker(null);
  };

  const addPresetFromMenu = (preset: ArtboardPreset) => {
    if (!contextMenu) return;
    const position = { x: Math.round(contextMenu.worldX), y: Math.round(contextMenu.worldY) };
    addArtboard(preset, position);
    setContextMenu(null);
  };

  const addFromMenu = (type: "caption" | "note") => {
    if (!contextMenu) return;
    const position = { x: Math.round(contextMenu.worldX), y: Math.round(contextMenu.worldY) };
    if (type === "caption") {
      ensureCaptionArtboardAt(position.x, position.y);
    } else {
      addArtboard(notePreset, position);
    }
    setContextMenu(null);
  };

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden" style={{ backgroundColor: "var(--space-shell-bg)" }}>
      {/* zoom indicator */}
      <div className="absolute bottom-3 right-3 z-10 flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/85 px-2.5 py-1 text-[11px] text-zinc-500 shadow-lg shadow-black/30 backdrop-blur">
        <span className="font-semibold tabular-nums text-zinc-200">{Math.round(view.scale * 100)}%</span>
        <span className="text-zinc-700">·</span>
        <span>scroll zoom · drag pan</span>
      </div>

      {deepQaRunning && (
        <div
          data-space-deep-scan-notice="1"
          className="pointer-events-none absolute left-1/2 top-3 z-[130] w-[min(520px,calc(100%-32px))] -translate-x-1/2 rounded-lg border border-amber-400/25 bg-zinc-950/90 px-3 py-2 text-[11px] leading-4 text-amber-100 shadow-2xl shadow-black/35 backdrop-blur"
        >
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-300" />
            <span className="font-semibold">Deep scan in progress...</span>
            <span className="ml-auto rounded-full bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-200">
              Fast check preview loaded
            </span>
          </div>
          <p className="mt-0.5 text-amber-200/70">
            Additional issues may be found. Please wait until completed before finalizing the content.
          </p>
        </div>
      )}

      <div
        ref={containerRef}
        data-canvas-bg="1"
        className="relative h-full w-full overflow-hidden cursor-grab bg-[#0c0c0f] active:cursor-grabbing"
        style={SPACE_BACKGROUND_STYLE}
        onWheel={onWheel}
        onPointerMove={onSpacePointerMove}
        onPointerLeave={onSpacePointerLeave}
        onPointerDown={onPointerDown}
        onContextMenu={openContextMenu}
      >
        <canvas
          ref={slashCanvasRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-0 h-full w-full"
        />
        <div
          className="relative z-10 origin-top-left"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          {artboards.map((ab) => (
            <div key={ab.id} data-artboard-root="1">
              <ArtboardView
                ab={ab}
                scale={view.scale}
                artboards={artboards}
                setSnapGuides={setSnapGuides}
                showIssueCard={showIssueCard}
                scheduleHideIssueCard={scheduleHideIssueCard}
                toggleArtboardIssues={toggleArtboardIssues}
                toggleLayoutPicker={toggleLayoutPicker}
              />
            </div>
          ))}
          {snapGuides.vertical.map((x) => (
            <div
              key={`v-${x}`}
              className="pointer-events-none absolute z-50 border-l-2 border-fuchsia-400"
              style={{ left: x, top: -10000, height: 50000 }}
            />
          ))}
          {snapGuides.horizontal.map((y) => (
            <div
              key={`h-${y}`}
              className="pointer-events-none absolute z-50 border-t-2 border-fuchsia-400"
              style={{ top: y, left: -10000, width: 50000 }}
            />
          ))}
          {artboards.length === 0 && (
            <div className="absolute left-0 top-0 w-[2400px] select-none pt-40 text-center text-zinc-700" style={{ fontSize: 64 }}>
              Chuột phải trên space để thêm artboard
            </div>
          )}
        </div>
      </div>

      {spaceIssueCard && (
        <div
          data-space-issue-card="1"
          className="absolute z-[220]"
          style={{ left: spaceIssueCard.x, top: spaceIssueCard.y }}
          onMouseEnter={keepIssueCard}
          onMouseLeave={scheduleHideIssueCard}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <CanvasIssueCard issue={spaceIssueCard.issue} />
        </div>
      )}

      {spaceArtboardIssues && (
        <div
          data-space-artboard-issues="1"
          data-artboard-issues-popover="1"
          className="absolute z-[210] max-h-[460px] w-[404px] overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-950 p-2 shadow-2xl"
          style={{ left: spaceArtboardIssues.x, top: spaceArtboardIssues.y }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-1 flex items-center gap-2 px-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
              {spaceArtboardIssues.label} issues
            </span>
            <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
              {spaceArtboardIssues.issues.length}
            </span>
            <button
              onClick={() => setSpaceArtboardIssues(null)}
              className="cp-button cp-button-secondary cp-button-xs ml-auto"
            >
              Close
            </button>
          </div>
          <div className="space-y-1.5">
            {spaceArtboardIssues.issues.map((issue) => (
              <CanvasIssueCard key={issue.issue_id} issue={issue} />
            ))}
          </div>
        </div>
      )}

      {spaceLayoutPicker && (
        <div
          data-space-layout-picker="1"
          data-layout-picker-menu="1"
          className="absolute z-[215] w-[340px] rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-xs text-zinc-200 shadow-2xl"
          style={{ left: spaceLayoutPicker.x, top: spaceLayoutPicker.y }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-1.5 flex items-center gap-2 px-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
              {spaceLayoutPicker.label} layouts
            </span>
            <button
              onClick={() => setSpaceLayoutPicker(null)}
              className="cp-button cp-button-secondary cp-button-xs ml-auto"
            >
              Close
            </button>
          </div>
          <div className="max-h-[380px] space-y-1 overflow-y-auto pr-1">
            {getAvailablePostLayouts(spaceLayoutPicker.platform).map((layout) => {
              const active = layout.id === spaceLayoutPicker.currentLayoutId;
              return (
                <button
                  key={layout.id}
                  data-layout-option={layout.id}
                  onClick={() => {
                    setArtboardLayout(spaceLayoutPicker.artboardId, layout.id);
                    setSpaceLayoutPicker(null);
                  }}
                  className={`flex w-full items-center gap-2 rounded-md border p-1.5 text-left transition-colors ${
                    active
                      ? "border-[#f05a22]/65 bg-[#f05a22]/15 text-[#ffb18f]"
                      : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-[#f05a22]/50 hover:bg-[#f05a22]/10 hover:text-[#ffb18f]"
                  }`}
                >
                  <LayoutMini layout={layout} platform={spaceLayoutPicker.platform} />
                  <span className="min-w-0">
                    <span className="block text-[11px] font-medium">{layout.label}</span>
                    <span className="block truncate text-[10px] text-zinc-500">{layout.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {contextMenu && (
        <div
          data-context-menu="1"
          className="cp-space-context-menu absolute z-[230] max-h-[min(360px,calc(100vh-32px))] w-60 overflow-y-auto rounded-lg p-1.5 text-xs backdrop-blur"
          style={{ left: contextMenu.screenX, top: contextMenu.screenY }}
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="cp-space-context-heading px-1 pb-1 text-[9px] font-semibold uppercase tracking-wide">
            Add to space
          </div>
          <div className="grid grid-cols-2 gap-1">
            <button
              onClick={() => addFromMenu("caption")}
              className="cp-button cp-button-secondary cp-button-xs w-full"
            >
              + Caption
            </button>
            <button
              onClick={() => addFromMenu("note")}
              className="cp-button cp-button-secondary cp-button-xs w-full"
            >
              + Note
            </button>
          </div>
          <div className="cp-space-context-heading mt-2 px-1 pb-1 text-[9px] font-semibold uppercase tracking-wide">
            Facebook
          </div>
          <div className="grid grid-cols-2 gap-1">
            {facebookPresets.map((preset) => (
              <button
                key={preset.id}
                onClick={() => addPresetFromMenu(preset)}
                className="cp-space-context-preset min-h-11 rounded-md px-2 py-1.5 text-left transition-colors"
                title={`${preset.label} · ${preset.width}×${preset.height}`}
              >
                <span className="block truncate text-[10.5px] font-semibold leading-tight">+ {compactPresetLabel(preset)}</span>
                <span className="cp-space-context-size mt-0.5 block truncate text-[9px] leading-none">{preset.width}×{preset.height}</span>
              </button>
            ))}
          </div>
          <div className="cp-space-context-heading mt-2 px-1 pb-1 text-[9px] font-semibold uppercase tracking-wide">
            LinkedIn
          </div>
          <div className="grid grid-cols-2 gap-1">
            {linkedinPresets.map((preset) => (
              <button
                key={preset.id}
                onClick={() => addPresetFromMenu(preset)}
                className="cp-space-context-preset min-h-11 rounded-md px-2 py-1.5 text-left transition-colors"
                title={`${preset.label} · ${preset.width}×${preset.height}`}
              >
                <span className="block truncate text-[10.5px] font-semibold leading-tight">+ {compactPresetLabel(preset)}</span>
                <span className="cp-space-context-size mt-0.5 block truncate text-[9px] leading-none">{preset.width}×{preset.height}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
