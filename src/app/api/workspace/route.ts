import { NextRequest, NextResponse } from "next/server";
import { deviceScopeFromRequest, getWorkspace, saveWorkspace } from "@/lib/server/db";
import { loadBrandKit } from "@/lib/brand/brandGuidelineLoader";
import { listGuidelineUploads } from "@/lib/brand/guidelineUploads";
import { projectGuidelinesDir } from "@/lib/server/db";
import { getModelConfig, isModelConfigured } from "@/lib/models/gateway";

export async function GET(req: NextRequest) {
  const scope = deviceScopeFromRequest(req);
  const workspace = getWorkspace(undefined, scope);
  const guidelineDir = projectGuidelinesDir(undefined, scope);
  return NextResponse.json({
    workspace,
    brand_kit: loadBrandKit(undefined, scope),
    guideline_files: listGuidelineUploads(guidelineDir),
    llm_configured: isModelConfigured(),
    model_config: getModelConfig(),
    agent_trace: workspace.last_agent_trace ?? null,
  });
}

export async function PATCH(req: NextRequest) {
  const scope = deviceScopeFromRequest(req);
  const body = await req.json();
  const ws = getWorkspace(undefined, scope);
  if (typeof body.name === "string") ws.name = body.name;
  if (typeof body.image_check_label === "string") ws.image_check_label = body.image_check_label;
  if (body.caption) ws.caption = { ...ws.caption, ...body.caption };
  if (Array.isArray(body.artboards)) ws.artboards = body.artboards;
  if (Array.isArray(body.assets)) ws.assets = body.assets;
  if (Array.isArray(body.issues)) ws.issues = body.issues;
  if ("last_agent_trace" in body) ws.last_agent_trace = body.last_agent_trace ?? null;
  saveWorkspace(ws, undefined, scope);
  return NextResponse.json({ workspace: ws });
}
