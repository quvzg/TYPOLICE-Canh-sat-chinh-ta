import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { loadBrandKit } from "@/lib/brand/brandGuidelineLoader";
import { parseGuidelineUpload } from "@/lib/brand/guidelineUploadParser";
import {
  guidelineUploadContentType,
  listGuidelineUploads,
  resolveGuidelineUpload,
  saveGuidelineUpload,
} from "@/lib/brand/guidelineUploads";
import { deviceScopeFromRequest, listProjects, projectGuidelinesDir } from "@/lib/server/db";

function requireProjectId(req: NextRequest, bodyProjectId?: unknown): string | undefined | NextResponse {
  const scope = deviceScopeFromRequest(req);
  const fromQuery = req.nextUrl.searchParams.get("project_id")?.trim();
  const fromBody = typeof bodyProjectId === "string" && bodyProjectId.trim() ? bodyProjectId.trim() : undefined;
  const projectId = fromBody ?? fromQuery ?? undefined;
  if (!projectId && listProjects(scope).length > 1) {
    return NextResponse.json({ error: "project_id required" }, { status: 400 });
  }
  return projectId;
}

function withProjectUrls<T extends { url: string }>(files: T[], projectId?: string): T[] {
  if (!projectId) return files;
  return files.map((file) => ({
    ...file,
    url: `${file.url}${file.url.includes("?") ? "&" : "?"}project_id=${encodeURIComponent(projectId)}`,
  }));
}

export async function GET(req: NextRequest) {
  const scope = deviceScopeFromRequest(req);
  const projectIdResult = requireProjectId(req);
  if (projectIdResult instanceof NextResponse) return projectIdResult;
  const projectId = projectIdResult;
  const dir = projectGuidelinesDir(projectId, scope);
  const fileName = req.nextUrl.searchParams.get("file");
  if (fileName) {
    const resolved = resolveGuidelineUpload(dir, fileName);
    if (!resolved) return NextResponse.json({ error: "file not found" }, { status: 404 });
    const bytes = fs.readFileSync(/* turbopackIgnore: true */ resolved.path);
    const encodedName = encodeURIComponent(resolved.file.original_name);
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": guidelineUploadContentType(resolved.file.original_name),
        "Content-Disposition": `inline; filename="${resolved.file.name.replace(/"/g, "")}"; filename*=UTF-8''${encodedName}`,
        "Content-Length": String(bytes.byteLength),
      },
    });
  }

  return NextResponse.json({
    brand_kit: loadBrandKit(projectId, scope),
    guideline_files: withProjectUrls(listGuidelineUploads(dir), projectId),
  });
}

export async function POST(req: NextRequest) {
  const scope = deviceScopeFromRequest(req);
  const form = await req.formData();
  const projectIdValue = form.get("project_id");
  const projectIdResult = requireProjectId(req, projectIdValue);
  if (projectIdResult instanceof NextResponse) return projectIdResult;
  const projectId = projectIdResult;
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }

  if (file.size > 8 * 1024 * 1024) {
    return NextResponse.json({ error: "file too large" }, { status: 400 });
  }

  const dir = projectGuidelinesDir(projectId, scope);
  fs.mkdirSync(dir, { recursive: true });

  const originalBuffer = Buffer.from(await file.arrayBuffer());
  let parsed;
  try {
    parsed = await parseGuidelineUpload(file);
  } catch (err) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : "unsupported file type",
    }, { status: 400 });
  }

  for (const output of parsed.files) {
    fs.writeFileSync(path.join(dir, output.targetName), output.content);
  }
  const uploadedFile = saveGuidelineUpload(dir, file, originalBuffer);

  return NextResponse.json({
    brand_kit: loadBrandKit(projectId, scope),
    saved_as: parsed.savedAs,
    uploaded_file: withProjectUrls([uploadedFile], projectId)[0],
    guideline_files: withProjectUrls(listGuidelineUploads(dir), projectId),
  });
}

/**
 * "Add to dictionary" — append a term to the active project's brand kit.
 * Global brand_guidelines/ remains a base kit; project overrides live in storage.
 */
export async function PATCH(req: NextRequest) {
  const scope = deviceScopeFromRequest(req);
  const body = await req.json();
  const { add_term, list = "do_not_change", wrong, correct, note, project_id } = body;
  const projectIdResult = requireProjectId(req, project_id);
  if (projectIdResult instanceof NextResponse) return projectIdResult;
  const projectId = projectIdResult;
  const allowedLists = [
    "do_not_change",
    "brand_terms",
    "preferred_spellings",
    "product_terms",
    "preferred_wording",
    "missing_tone_map",
    "wrong_tone_map",
    "risky_words",
    "style_guideline",
  ];
  if (!allowedLists.includes(list)) {
    return NextResponse.json({ error: "invalid list" }, { status: 400 });
  }

  const dir = projectGuidelinesDir(projectId, scope);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "brand_kit.json");
  const styleFile = path.join(dir, "style_guide.md");

  if (list === "style_guideline") {
    if (typeof note !== "string" || !note.trim()) {
      return NextResponse.json({ error: "note required" }, { status: 400 });
    }
    const existing = fs.existsSync(styleFile) ? fs.readFileSync(styleFile, "utf-8") : "# Style Guide\n";
    const trimmed = note.trim();
    if (!existing.includes(trimmed)) {
      const prefix = existing.endsWith("\n") ? "" : "\n";
      fs.writeFileSync(styleFile, `${existing}${prefix}- ${trimmed}\n`);
    }
    return NextResponse.json({ brand_kit: loadBrandKit(projectId, scope) });
  }

  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch { /* start fresh */ }

  const setFlatMap = (key: string) => {
    if (typeof wrong !== "string" || !wrong.trim() || typeof correct !== "string" || !correct.trim()) {
      return NextResponse.json({ error: "wrong and correct required" }, { status: 400 });
    }
    const map = data[key] && typeof data[key] === "object" && !Array.isArray(data[key])
      ? (data[key] as Record<string, string>)
      : {};
    map[wrong.trim()] = correct.trim();
    data[key] = map;
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return NextResponse.json({ brand_kit: loadBrandKit(projectId, scope) });
  };

  if ([
    "preferred_spellings",
    "product_terms",
    "preferred_wording",
    "missing_tone_map",
    "wrong_tone_map",
  ].includes(list)) {
    return setFlatMap(list);
  }

  if (list === "risky_words") {
    if (typeof wrong !== "string" || !wrong.trim() || typeof correct !== "string" || !correct.trim()) {
      return NextResponse.json({ error: "wrong and correct required" }, { status: 400 });
    }
    const map =
      data.risky_words && typeof data.risky_words === "object" && !Array.isArray(data.risky_words)
        ? (data.risky_words as Record<string, { priority?: string; suggestion?: string }>)
        : {};
    map[wrong.trim()] = { priority: "medium", suggestion: correct.trim() };
    data.risky_words = map;
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return NextResponse.json({ brand_kit: loadBrandKit(projectId, scope) });
  }

  if (typeof add_term !== "string" || !add_term.trim()) {
    return NextResponse.json({ error: "add_term required" }, { status: 400 });
  }

  const arr = Array.isArray(data[list]) ? (data[list] as string[]) : [];
  if (!arr.includes(add_term.trim())) arr.push(add_term.trim());
  data[list] = arr;
  fs.writeFileSync(file, JSON.stringify(data, null, 2));

  return NextResponse.json({ brand_kit: loadBrandKit(projectId, scope) });
}
