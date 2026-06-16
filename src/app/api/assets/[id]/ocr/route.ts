import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { loadBrandKit } from "@/lib/brand/brandGuidelineLoader";
import { deviceScopeFromRequest, getWorkspace, saveWorkspace, uploadsDir } from "@/lib/server/db";
import { runOcr } from "@/lib/ocr/ocrService";
import { correctOcrWithVision } from "@/lib/ocr/ocrVisionCorrection";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const scope = deviceScopeFromRequest(req);
  const { id } = await params;
  const { vision_correction = false } = await req.json().catch(() => ({}));
  const ws = getWorkspace(undefined, scope);
  const asset = ws.assets.find((a) => a.id === id);
  if (!asset) return NextResponse.json({ error: "asset not found" }, { status: 404 });

  asset.ocr_status = "processing";
  saveWorkspace(ws, undefined, scope);

  try {
    const storedName = path.basename(asset.url);
    const filePath = path.join(uploadsDir(undefined, scope), storedName);
    const rawBoxes = await runOcr(filePath, asset.id, asset.hash);
    const boxes = vision_correction
      ? await correctOcrWithVision(filePath, rawBoxes, loadBrandKit(undefined, scope))
      : rawBoxes;
    asset.ocr_boxes = boxes;
    const avgConf = boxes.length
      ? boxes.reduce((s, b) => s + b.confidence, 0) / boxes.length
      : 1;
    asset.ocr_status = avgConf < 0.6 && boxes.length > 0 ? "low_confidence" : "done";
  } catch (err) {
    console.error("[ocr] failed:", err instanceof Error ? err.message : err);
    asset.ocr_status = "failed";
  }

  saveWorkspace(ws, undefined, scope);
  return NextResponse.json({ asset });
}
