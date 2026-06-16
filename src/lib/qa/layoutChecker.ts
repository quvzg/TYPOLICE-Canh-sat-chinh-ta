import type { Artboard, Asset, Issue } from "@/types";

let n = 0;
const nextId = () => `issue_layout_${Date.now().toString(36)}_${++n}`;

function makeIssue(partial: Omit<Issue, "issue_id" | "source_type" | "range" | "bbox" | "status" | "created_by" | "is_definite_error">): Issue {
  return {
    issue_id: nextId(),
    source_type: "layout",
    range: null,
    bbox: null,
    status: "open",
    created_by: "layout_checker",
    is_definite_error: false,
    ...partial,
  };
}

/** Deterministic layout risk checks across artboards. */
export function runLayoutChecks(artboards: Artboard[], assets: Asset[]): Issue[] {
  const issues: Issue[] = [];
  const assetById = new Map(assets.map((a) => [a.id, a]));

  for (const ab of artboards) {
    for (const layer of ab.layers) {
      const asset = assetById.get(layer.asset_id);
      if (!asset) continue;

      // 1. Low-resolution image on a large artboard
      const scaleX = layer.width / asset.width;
      const scaleY = layer.height / asset.height;
      if (Math.max(scaleX, scaleY) > 1.5) {
        issues.push(makeIssue({
          source_id: ab.id,
          artboard_id: ab.id,
          box_id: null,
          type: "layout_risk",
          severity: "medium",
          original: `${asset.filename} (${asset.width}×${asset.height})`,
          suggestion: `Dùng ảnh độ phân giải cao hơn cho artboard ${ab.width}×${ab.height}.`,
          reason: `Ảnh bị phóng to ${Math.round(Math.max(scaleX, scaleY) * 100)}%, có thể vỡ nét khi publish.`,
          confidence: 0.9,
        }));
      }

      // 2. Aspect ratio mismatch with cover fit → content sẽ bị crop
      const assetRatio = asset.width / asset.height;
      const layerRatio = layer.width / layer.height;
      if (layer.fit_mode === "cover" && Math.abs(assetRatio - layerRatio) / layerRatio > 0.25) {
        issues.push(makeIssue({
          source_id: ab.id,
          artboard_id: ab.id,
          box_id: null,
          type: "platform_format",
          severity: "low",
          original: `${asset.filename} ratio ${assetRatio.toFixed(2)} vs artboard ${layerRatio.toFixed(2)}`,
          suggestion: "Kiểm tra vùng bị crop hoặc đổi sang ảnh đúng ratio.",
          reason: "Tỷ lệ ảnh lệch nhiều so với artboard, chế độ cover sẽ crop đáng kể.",
          confidence: 0.85,
        }));
      }

      // 3. OCR text quá sát mép artboard (safe zone 48px theo tỉ lệ artboard)
      if (asset.ocr_boxes.length > 0) {
        const safeZone = 48;
        for (const box of asset.ocr_boxes) {
          if (box.confidence < 0.5 || !box.text.trim()) continue;
          // map bbox từ toạ độ ảnh sang toạ độ artboard, tính cả slot trong multi-image layout
          const scale =
            layer.fit_mode === "cover"
              ? Math.max(layer.width / asset.width, layer.height / asset.height)
              : Math.min(layer.width / asset.width, layer.height / asset.height);
          const offsetX = (asset.width * scale - layer.width) / 2;
          const offsetY = (asset.height * scale - layer.height) / 2;
          const x0 = layer.x + box.bbox[0] * scale - offsetX;
          const y0 = layer.y + box.bbox[1] * scale - offsetY;
          const x1 = layer.x + box.bbox[2] * scale - offsetX;
          const y1 = layer.y + box.bbox[3] * scale - offsetY;
          const cropped = x0 < layer.x || y0 < layer.y || x1 > layer.x + layer.width || y1 > layer.y + layer.height;
          const nearEdge = !cropped && (
            x0 < safeZone ||
            y0 < safeZone ||
            ab.width - x1 < safeZone ||
            ab.height - y1 < safeZone
          );
          if (cropped || nearEdge) {
            issues.push(makeIssue({
              source_id: ab.id,
              artboard_id: ab.id,
              box_id: box.box_id,
              type: "layout_risk",
              severity: cropped ? "high" : "medium",
              original: box.text.slice(0, 60),
              suggestion: cropped
                ? "Chữ bị crop khỏi artboard. Đổi fit mode sang contain hoặc chỉnh layout."
                : "Dời chữ vào trong safe zone tối thiểu 48px.",
              reason: cropped
                ? "Text trên ảnh nằm ngoài vùng hiển thị của artboard."
                : "Text quá sát mép, dễ bị crop hoặc khó đọc trên mobile.",
              confidence: 0.8,
            }));
            break; // 1 cảnh báo / layer là đủ, tránh spam
          }
        }
      }
    }
  }

  // 4. Cùng một ảnh dùng lặp trong nhiều carousel slide
  const carousel = artboards.filter((a) => a.format === "carousel_slide");
  const seen = new Map<string, string>();
  for (const ab of carousel) {
    for (const layer of ab.layers) {
      const prev = seen.get(layer.asset_id);
      if (prev && prev !== ab.id) {
        issues.push(makeIssue({
          source_id: ab.id,
          artboard_id: ab.id,
          box_id: null,
          type: "layout_risk",
          severity: "needs_review",
          original: assetById.get(layer.asset_id)?.filename ?? layer.asset_id,
          suggestion: "Kiểm tra xem có cố ý dùng lặp ảnh giữa các slide không.",
          reason: "Cùng một ảnh xuất hiện trong nhiều carousel slide.",
          confidence: 0.75,
        }));
      }
      seen.set(layer.asset_id, ab.id);
    }
  }

  return issues;
}
