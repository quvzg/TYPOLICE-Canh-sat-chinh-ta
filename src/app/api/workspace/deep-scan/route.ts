import { NextRequest, NextResponse } from "next/server";
import {
  completeDeepScanJob,
  createDeepScanJob,
  failDeepScanJob,
  getDeepScanJob,
} from "@/lib/qa/deepScanJobs";
import { deviceScopeFromRequest } from "@/lib/server/db";
import type { AgentRunTrace, Issue } from "@/types";

export async function POST(req: NextRequest) {
  const scope = deviceScopeFromRequest(req);
  const body = await req.json().catch(() => ({}));
  const projectId = typeof body.project_id === "string" && body.project_id.trim()
    ? body.project_id.trim()
    : null;
  const targetArtboardId = typeof body.target_artboard_id === "string" && body.target_artboard_id.trim()
    ? body.target_artboard_id.trim()
    : null;
  const contentFingerprint = typeof body.content_fingerprint === "string" && body.content_fingerprint.trim()
    ? body.content_fingerprint.trim()
    : null;
  if (!contentFingerprint) {
    return NextResponse.json({ error: "content_fingerprint required" }, { status: 400 });
  }

  const job = createDeepScanJob({
    project_id: projectId,
    scope,
    target_artboard_id: targetArtboardId,
    content_fingerprint: contentFingerprint,
  });

  const origin = req.nextUrl.origin;
  const runBody = {
    project_id: projectId,
    visual_qa: true,
    caption_llm: true,
    deep_job_id: job.job_id,
    defer_save: true,
    content_fingerprint: contentFingerprint,
    target_artboard_id: targetArtboardId,
  };

  void (async () => {
    try {
      const res = await fetch(`${origin}/api/workspace/run-qa`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-typolice-device-id": scope,
        },
        body: JSON.stringify(runBody),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Deep scan failed with HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!data || typeof data !== "object") {
        throw new Error("Deep scan failed.");
      }
      const result = data as { workspace?: { issues?: Issue[]; assets?: unknown[] }; agent_trace?: AgentRunTrace | null };
      completeDeepScanJob(job.job_id, {
        issues: result.workspace?.issues ?? [],
        assets: result.workspace?.assets ?? [],
        agent_trace: result.agent_trace ?? null,
      });
    } catch (err) {
      failDeepScanJob(job.job_id, err instanceof Error ? err.message : "Deep scan failed.");
    }
  })();

  return NextResponse.json({ job });
}

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("job_id") ?? "";
  if (!jobId) return NextResponse.json({ error: "job_id required" }, { status: 400 });
  const job = getDeepScanJob(jobId);
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
  return NextResponse.json({ job });
}
