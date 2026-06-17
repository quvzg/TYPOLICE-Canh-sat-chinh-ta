import fs from "fs";
import path from "path";
import sharp from "sharp";

const storageDir = () => path.join(/* turbopackIgnore: true */ process.cwd(), "storage");
const payloadDir = () => path.join(storageDir(), "image-model-payloads");
const PAYLOAD_VERSION = "image-payload-v1";
const MAX_LONG_EDGE = 1800;
const JPEG_QUALITY = 78;

export interface ImageModelPayload {
  dataUrl: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  scaleX: number;
  scaleY: number;
  cacheHit: boolean;
}

function cacheFile(assetHash: string) {
  return path.join(payloadDir(), `${assetHash}.${PAYLOAD_VERSION}.jpg`);
}

function metaFile(assetHash: string) {
  return path.join(payloadDir(), `${assetHash}.${PAYLOAD_VERSION}.json`);
}

export async function imageModelPayload(filePath: string, assetHash: string): Promise<ImageModelPayload> {
  fs.mkdirSync(/* turbopackIgnore: true */ payloadDir(), { recursive: true });
  const imageFile = cacheFile(assetHash);
  const metadataFile = metaFile(assetHash);
  if (fs.existsSync(/* turbopackIgnore: true */ imageFile) && fs.existsSync(/* turbopackIgnore: true */ metadataFile)) {
    try {
      const meta = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ metadataFile, "utf-8")) as Omit<ImageModelPayload, "dataUrl" | "cacheHit" | "mimeType">;
      const bytes = fs.readFileSync(/* turbopackIgnore: true */ imageFile);
      return {
        ...meta,
        mimeType: "image/jpeg",
        dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
        cacheHit: true,
      };
    } catch {
      // Regenerate broken payloads.
    }
  }

  const input = sharp(filePath, { limitInputPixels: false }).rotate();
  const sourceMeta = await input.metadata();
  const originalWidth = sourceMeta.width ?? 1;
  const originalHeight = sourceMeta.height ?? 1;
  const longEdge = Math.max(originalWidth, originalHeight);
  const scale = longEdge > MAX_LONG_EDGE ? MAX_LONG_EDGE / longEdge : 1;
  const width = Math.max(1, Math.round(originalWidth * scale));
  const height = Math.max(1, Math.round(originalHeight * scale));
  const bytes = await input
    .resize({ width, height, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
  fs.writeFileSync(/* turbopackIgnore: true */ imageFile, bytes);
  const meta = {
    width,
    height,
    originalWidth,
    originalHeight,
    scaleX: width / originalWidth,
    scaleY: height / originalHeight,
  };
  fs.writeFileSync(/* turbopackIgnore: true */ metadataFile, JSON.stringify(meta, null, 2));
  return {
    ...meta,
    mimeType: "image/jpeg",
    dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
    cacheHit: false,
  };
}

export function payloadBboxToOriginal(
  bbox: [number, number, number, number],
  payload: Pick<ImageModelPayload, "scaleX" | "scaleY" | "originalWidth" | "originalHeight">
): [number, number, number, number] {
  const [x0, y0, x1, y1] = bbox;
  return [
    Math.max(0, Math.min(payload.originalWidth, Math.round(x0 / payload.scaleX))),
    Math.max(0, Math.min(payload.originalHeight, Math.round(y0 / payload.scaleY))),
    Math.max(0, Math.min(payload.originalWidth, Math.round(x1 / payload.scaleX))),
    Math.max(0, Math.min(payload.originalHeight, Math.round(y1 / payload.scaleY))),
  ];
}
