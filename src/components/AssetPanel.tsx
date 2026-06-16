"use client";

import { useRef } from "react";
import { useQAStore } from "@/lib/store";
import type { Asset, OcrStatus } from "@/types";

const OCR_BADGE: Record<OcrStatus, { label: string; cls: string }> = {
  pending: { label: "Chưa đọc chữ", cls: "bg-zinc-700 text-zinc-300" },
  processing: { label: "Đang đọc chữ…", cls: "bg-blue-500/20 text-blue-400 animate-pulse" },
  done: { label: "Đã đọc chữ", cls: "bg-emerald-500/20 text-emerald-400" },
  low_confidence: { label: "Cần xem lại", cls: "bg-yellow-500/20 text-yellow-400" },
  failed: { label: "Chưa đọc được", cls: "bg-red-500/20 text-red-400" },
};

function ratioLabel(a: Asset): string {
  if (!a.width || !a.height) return "?";
  const r = a.width / a.height;
  if (Math.abs(r - 1) < 0.02) return "1:1";
  if (Math.abs(r - 4 / 5) < 0.03) return "4:5";
  if (Math.abs(r - 9 / 16) < 0.03) return "9:16";
  if (Math.abs(r - 1200 / 627) < 0.05) return "1.91:1";
  return r > 1 ? `${r.toFixed(2)}:1` : `1:${(1 / r).toFixed(2)}`;
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.8]">
      <path d="M4.5 6h11" strokeLinecap="round" />
      <path d="M8 6V4.7c0-.6.4-1 1-1h2c.6 0 1 .4 1 1V6" />
      <path d="m6.3 8 .5 7.2c.1.7.6 1.1 1.3 1.1h3.8c.7 0 1.2-.4 1.3-1.1l.5-7.2" strokeLinecap="round" />
      <path d="M8.8 9.8v4M11.2 9.8v4" strokeLinecap="round" />
    </svg>
  );
}

export default function AssetPanel() {
  const assets = useQAStore((s) => s.assets);
  const issues = useQAStore((s) => s.issues);
  const uploadFiles = useQAStore((s) => s.uploadFiles);
  const runOcr = useQAStore((s) => s.runOcr);
  const removeAsset = useQAStore((s) => s.removeAsset);
  const fileRef = useRef<HTMLInputElement>(null);

  const issueCount = (assetId: string) =>
    issues.filter((i) => i.source_id === assetId && i.status === "open").length;

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Assets</span>
          {assets.length > 0 && (
            <span className="rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-zinc-400">
              {assets.length}
            </span>
          )}
        </div>
        <button
          onClick={() => fileRef.current?.click()}
          className="cp-button cp-button-xs"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.7]">
            <path d="M8 3.4v9.2M3.4 8h9.2" strokeLinecap="round" />
          </svg>
          Upload
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) {
              void uploadFiles(e.target.files).catch((err) => {
                window.alert(err instanceof Error ? err.message : "Chưa upload được ảnh. Hãy thử lại với file PNG, JPG, JPEG hoặc WebP.");
              });
            }
            e.target.value = "";
          }}
        />
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {assets.length === 0 && (
          <div className="mt-6 flex flex-col items-center gap-3 px-3 text-center">
            <span className="grid h-11 w-11 place-items-center rounded-lg border border-dashed border-zinc-700 text-zinc-600">
              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-none stroke-current stroke-[1.6]">
                <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
                <circle cx="9" cy="9.5" r="1.6" />
                <path d="m4.5 17 4.6-4.4 3 2.6 3.4-3.2 4 4.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <p className="text-xs leading-relaxed text-zinc-500">
              Drop or upload your posters/banners here to check for text errors.
              <br />
              Drag images into an artboard on the canvas.
            </p>
          </div>
        )}
        {assets.map((a) => {
          const count = issueCount(a.id);
          const badge = OCR_BADGE[a.ocr_status];
          return (
            <div
              key={a.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-asset-id", a.id);
                e.dataTransfer.effectAllowed = "copy";
              }}
              className="group cursor-grab rounded-lg border border-zinc-800 bg-zinc-900 p-2 transition-colors hover:border-zinc-600 hover:bg-zinc-800/60 active:cursor-grabbing"
            >
              <div className="relative mb-1.5 overflow-hidden rounded">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={a.url}
                  alt={a.filename}
                  className="h-24 w-full object-cover"
                  draggable={false}
                />
                <span className="absolute bottom-1 right-1 rounded bg-zinc-950/80 px-1 py-0.5 text-[9px] font-medium tabular-nums text-zinc-300 backdrop-blur">
                  {ratioLabel(a)}
                </span>
              </div>
              <p className="truncate text-[11px] font-medium text-zinc-300" title={a.filename}>
                {a.filename}
              </p>
              <p className="text-[10px] tabular-nums text-zinc-500">
                {a.width}×{a.height}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                <button
                  onClick={() => a.ocr_status !== "processing" && void runOcr(a.id)}
                  className="cp-button cp-button-secondary cp-button-xs"
                  title="Đọc lại chữ trên ảnh"
                >
                  {badge.label}
                </button>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    const ok = window.confirm(`Delete "${a.filename}" from this check? Related image issues and artboard placements will also be removed.`);
                    if (ok) removeAsset(a.id);
                  }}
                  className="cp-button cp-button-secondary cp-button-xs"
                  title="Delete image"
                  aria-label={`Delete ${a.filename}`}
                >
                  <TrashIcon />
                </button>
                {count > 0 && (
                  <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-400 ring-1 ring-inset ring-red-500/20">
                    {count} issue{count > 1 ? "s" : ""}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
