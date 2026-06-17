import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { deviceScopeFromRequest, getWorkspace, saveWorkspace, uploadsDir } from "@/lib/server/db";
import { MAX_IMAGE_FILE_SIZE_BYTES, MAX_IMAGE_UPLOAD_BATCH_BYTES, formatFileSize } from "@/lib/uploadLimits";
import type { Asset } from "@/types";

function readUInt24LE(buffer: Buffer, offset: number): number {
  return buffer[offset] + (buffer[offset + 1] << 8) + (buffer[offset + 2] << 16);
}

function detectImageSize(buffer: Buffer): { width: number; height: number } {
  // PNG: signature + IHDR width/height.
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer.toString("ascii", 1, 4) === "PNG" &&
    buffer.toString("ascii", 12, 16) === "IHDR"
  ) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // JPEG: walk segments until a Start Of Frame marker.
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      const isSof = (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      );
      if (isSof) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  }

  // WebP: VP8X extended header.
  if (
    buffer.length >= 30 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP" &&
    buffer.toString("ascii", 12, 16) === "VP8X"
  ) {
    return { width: readUInt24LE(buffer, 24) + 1, height: readUInt24LE(buffer, 27) + 1 };
  }

  return { width: 0, height: 0 };
}

export async function POST(req: NextRequest) {
  const scope = deviceScopeFromRequest(req);
  const form = await req.formData();
  const projectIdValue = form.get("project_id");
  const projectId = typeof projectIdValue === "string" && projectIdValue.trim() ? projectIdValue.trim() : undefined;
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "no files" }, { status: 400 });
  }

  const unsupported = files.find((file) =>
    !(file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(file.name))
  );
  if (unsupported) {
    return NextResponse.json({ error: "Typolice chỉ nhận file ảnh PNG, JPG, JPEG hoặc WebP." }, { status: 400 });
  }

  const tooLarge = files.find((file) => file.size > MAX_IMAGE_FILE_SIZE_BYTES);
  if (tooLarge) {
    return NextResponse.json({
      error: `"${tooLarge.name}" quá nặng (${formatFileSize(tooLarge.size)}). Mỗi ảnh tối đa ${formatFileSize(MAX_IMAGE_FILE_SIZE_BYTES)}.`,
    }, { status: 413 });
  }

  const batchSize = files.reduce((sum, file) => sum + file.size, 0);
  if (batchSize > MAX_IMAGE_UPLOAD_BATCH_BYTES) {
    return NextResponse.json({
      error: `Một lần upload tối đa ${formatFileSize(MAX_IMAGE_UPLOAD_BATCH_BYTES)}. Lần này đang là ${formatFileSize(batchSize)}.`,
    }, { status: 413 });
  }

  const ws = getWorkspace(projectId, scope);
  const added: Asset[] = [];

  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");

    // dedupe by content hash
    const existing = ws.assets.find((a) => a.hash === hash);
    if (existing) {
      if (!existing.url.includes("project_id=")) {
        existing.url = `${existing.url}${existing.url.includes("?") ? "&" : "?"}project_id=${encodeURIComponent(ws.id)}`;
      }
      added.push(existing);
      continue;
    }

    const { width, height } = detectImageSize(buffer);

    const ext = path.extname(file.name) || ".png";
    const storedName = `${hash.slice(0, 16)}${ext}`;
    fs.writeFileSync(/* turbopackIgnore: true */ path.join(uploadsDir(projectId, scope), storedName), buffer);

    const asset: Asset = {
      id: `asset_${hash.slice(0, 12)}`,
      type: "image",
      filename: file.name,
      width,
      height,
      hash,
      url: `/api/files/${storedName}?project_id=${encodeURIComponent(ws.id)}`,
      ocr_status: "pending",
      ocr_boxes: [],
    };
    ws.assets.push(asset);
    added.push(asset);
  }

  saveWorkspace(ws, projectId, scope);
  return NextResponse.json({ assets: added, workspace: ws });
}
