import type { Workspace } from "@/types";

export const PRIMARY_CAPTION_ARTBOARD_ID = "artboard_caption";

function artboardKind(ab: Workspace["artboards"][number]) {
  return ab.kind ?? (ab.format === "caption" ? "caption" : ab.format === "note" ? "note" : "visual");
}

export function workspaceTargetFingerprint(ws: Workspace, targetArtboardId?: string | null): string {
  const targetKey = targetArtboardId?.trim() || "__workspace__";
  if (targetKey === "__workspace__") {
    return JSON.stringify(
      ws.assets
        .map((asset) => [asset.id, asset.hash, asset.url])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    );
  }
  if (targetKey === PRIMARY_CAPTION_ARTBOARD_ID) {
    return `caption:${ws.caption.text}`;
  }
  const artboard = ws.artboards.find((item) => item.id === targetKey);
  if (!artboard) return `missing:${targetKey}`;
  if (artboardKind(artboard) === "caption") {
    return `caption:${targetKey}:${artboard.text ?? ""}`;
  }
  return JSON.stringify({
    id: artboard.id,
    kind: artboardKind(artboard),
    layout_id: artboard.layout_id,
    width: artboard.width,
    height: artboard.height,
    layers: artboard.layers.map((layer) => ({
      asset_id: layer.asset_id,
      slot_id: layer.slot_id,
      fit_mode: layer.fit_mode,
    })),
  });
}
