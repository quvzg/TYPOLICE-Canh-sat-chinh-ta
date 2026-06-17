import { NextRequest, NextResponse } from "next/server";
import { deviceScopeFromRequest, getWorkspace, saveWorkspace } from "@/lib/server/db";
import { loadBrandKit } from "@/lib/brand/brandGuidelineLoader";
import { listGuidelineUploads } from "@/lib/brand/guidelineUploads";
import { projectGuidelinesDir } from "@/lib/server/db";
import { getModelConfig, isModelConfigured } from "@/lib/models/gateway";

export async function GET(req: NextRequest) {
  const scope = deviceScopeFromRequest(req);
  const projectId = req.nextUrl.searchParams.get("project_id")?.trim() || undefined;
  const workspace = getWorkspace(projectId, scope);
  workspace.assets = workspace.assets.map((asset) => asset.url.includes("project_id=")
    ? asset
    : { ...asset, url: `${asset.url}${asset.url.includes("?") ? "&" : "?"}project_id=${encodeURIComponent(workspace.id)}` }
  );
  const guidelineDir = projectGuidelinesDir(workspace.id, scope);
  const guidelineFiles = listGuidelineUploads(guidelineDir).map((file) => ({
    ...file,
    url: `${file.url}${file.url.includes("?") ? "&" : "?"}project_id=${encodeURIComponent(workspace.id)}`,
  }));
  return NextResponse.json({
    workspace,
    brand_kit: loadBrandKit(workspace.id, scope),
    guideline_files: guidelineFiles,
    llm_configured: isModelConfigured(),
    model_config: getModelConfig(),
    agent_trace: workspace.last_agent_trace ?? null,
  });
}

export async function PATCH(req: NextRequest) {
  const scope = deviceScopeFromRequest(req);
  const body = await req.json();
  const projectId = typeof body.project_id === "string" && body.project_id.trim() ? body.project_id.trim() : undefined;
  const ws = getWorkspace(projectId, scope);
  if (typeof body.name === "string") ws.name = body.name;
  if (typeof body.image_check_label === "string") ws.image_check_label = body.image_check_label;
  if (body.caption) ws.caption = { ...ws.caption, ...body.caption };
  if (Array.isArray(body.artboards)) ws.artboards = body.artboards;
  if (Array.isArray(body.assets)) ws.assets = body.assets;
  if (Array.isArray(body.issues)) ws.issues = body.issues;
  if ("last_agent_trace" in body) ws.last_agent_trace = body.last_agent_trace ?? null;
  saveWorkspace(ws, projectId, scope);
  return NextResponse.json({ workspace: ws });
}
