import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { deviceScopeFromRequest, uploadsDir } from "@/lib/server/db";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const scope = deviceScopeFromRequest(req);
  const { name } = await params;
  const safe = path.basename(name); // prevent path traversal
  const filePath = path.join(uploadsDir(undefined, scope), safe);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const buffer = fs.readFileSync(filePath);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": MIME[path.extname(safe).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
