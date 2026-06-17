import { NextRequest, NextResponse } from "next/server";
import { getDeepScanJob } from "@/lib/qa/deepScanJobs";
import { workspaceTargetFingerprint } from "@/lib/qa/workspaceFingerprint";
import { deviceScopeFromRequest, getWorkspace, saveWorkspace } from "@/lib/server/db";
import type { Asset, Issue, Workspace } from "@/types";

function artboardKind(ab: Workspace["artboards"][number]) {
  return ab.kind ?? (ab.format === "caption" ? "caption" : ab.format === "note" ? "note" : "visual");
}

function issueBelongsToTarget(issue: Issue, ws: Workspace, targetArtboardId: string | null) {
  if (!targetArtboardId) return true;
  if (targetArtboardId === "artboard_caption") {
    return issue.source_type === "caption" && issue.artboard_id === null;
  }

  const target = ws.artboards.find((artboard) => artboard.id === targetArtboardId);
  if (!target) return false;
  const kind = artboardKind(target);
  if (kind === "caption") {
    return issue.source_type === "caption" && (
      issue.artboard_id === targetArtboardId ||
      issue.source_id === targetArtboardId
    );
  }
  if (kind === "visual") {
    const assetIds = new Set(target.layers.map((layer) => layer.asset_id));
    return issue.artboard_id === targetArtboardId || (
      issue.source_type === "image" &&
      assetIds.has(issue.source_id)
    );
  }
  return issue.artboard_id === targetArtboardId;
}

function mergeAssets(current: Asset[], next: Asset[], targetArtboardId: string | null, ws: Workspace) {
  if (!targetArtboardId) return next;
  const target = ws.artboards.find((artboard) => artboard.id === targetArtboardId);
  if (!target || artboardKind(target) !== "visual") return current;
  const targetAssetIds = new Set(target.layers.map((layer) => layer.asset_id));
  const nextById = new Map(next.map((asset) => [asset.id, asset]));
  return current.map((asset) => targetAssetIds.has(asset.id) && nextById.has(asset.id)
    ? (nextById.get(asset.id) as Asset)
    : asset
  );
}

export async function POST(req: NextRequest) {
  const scope = deviceScopeFromRequest(req);
  const body = await req.json().catch(() => ({}));
  const jobId = typeof body.job_id === "string" ? body.job_id.trim() : "";
  if (!jobId) return NextResponse.json({ error: "job_id required" }, { status: 400 });

  const job = getDeepScanJob(jobId);
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
  if (job.scope !== scope) return NextResponse.json({ error: "job scope mismatch" }, { status: 403 });
  if (job.status !== "completed") {
    return NextResponse.json({ error: "job_not_complete" }, { status: 409 });
  }

  const projectId = job.project_id ?? undefined;
  const current = getWorkspace(projectId, scope);
  const currentFingerprint = workspaceTargetFingerprint(current, job.target_artboard_id);
  if (currentFingerprint !== job.content_fingerprint) {
    return NextResponse.json({
      error: "stale_content",
      stale: true,
      message: "Nội dung đã đổi trong lúc rà kỹ; Typolice không ghi kết quả cũ vào workspace.",
    }, { status: 409 });
  }

  const jobIssues = (job.issues ?? []) as Issue[];
  const jobAssets = (job.assets ?? []) as Asset[];
  const targetArtboardId = job.target_artboard_id ?? null;
  const nextIssues = targetArtboardId
    ? [
        ...current.issues.filter((issue) => !issueBelongsToTarget(issue, current, targetArtboardId)),
        ...jobIssues.filter((issue) => issueBelongsToTarget(issue, current, targetArtboardId)),
      ]
    : jobIssues;
  const nextAssets = mergeAssets(current.assets, jobAssets, targetArtboardId, current);

  const next: Workspace = {
    ...current,
    assets: nextAssets,
    issues: nextIssues,
    last_agent_trace: job.agent_trace ?? current.last_agent_trace,
  };
  saveWorkspace(next, projectId, scope);

  return NextResponse.json({
    workspace: next,
    issues: nextIssues,
    assets: nextAssets,
    agent_trace: job.agent_trace ?? null,
    stale: false,
  });
}
