import fs from "fs";
import path from "path";
import type { AgentRunTrace, Issue } from "@/types";

export type DeepScanPhase =
  | "queued"
  | "ocr"
  | "caption_ai"
  | "image_ai"
  | "self_check"
  | "merge"
  | "completed"
  | "failed";

export interface DeepScanCheckpoint {
  phase: DeepScanPhase;
  status: "pending" | "running" | "completed" | "failed";
  started_at?: string;
  completed_at?: string;
  detail?: string;
  count?: number;
}

export interface DeepScanJob {
  job_id: string;
  project_id: string | null;
  scope: string;
  target_artboard_id: string | null;
  content_fingerprint: string;
  phase: DeepScanPhase;
  status: "queued" | "running" | "completed" | "failed";
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  error?: string;
  checkpoints: DeepScanCheckpoint[];
  issues?: Issue[];
  assets?: unknown[];
  agent_trace?: AgentRunTrace | null;
}

const storageDir = () => path.join(/* turbopackIgnore: true */ process.cwd(), "storage");
const jobsDir = () => path.join(storageDir(), "deep-scan-jobs");

function safe(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function jobFile(jobId: string) {
  return path.join(jobsDir(), `${safe(jobId)}.json`);
}

export function createDeepScanJob(input: {
  project_id: string | null;
  scope: string;
  target_artboard_id?: string | null;
  content_fingerprint: string;
}): DeepScanJob {
  fs.mkdirSync(/* turbopackIgnore: true */ jobsDir(), { recursive: true });
  const now = new Date().toISOString();
  const job: DeepScanJob = {
    job_id: `deep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    project_id: input.project_id,
    scope: input.scope,
    target_artboard_id: input.target_artboard_id ?? null,
    content_fingerprint: input.content_fingerprint,
    phase: "queued",
    status: "queued",
    created_at: now,
    updated_at: now,
    completed_at: null,
    checkpoints: ["ocr", "caption_ai", "image_ai", "self_check", "merge"].map((phase) => ({
      phase: phase as DeepScanPhase,
      status: "pending",
    })),
  };
  saveDeepScanJob(job);
  return job;
}

export function getDeepScanJob(jobId: string): DeepScanJob | null {
  try {
    return JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ jobFile(jobId), "utf-8")) as DeepScanJob;
  } catch {
    return null;
  }
}

export function saveDeepScanJob(job: DeepScanJob): DeepScanJob {
  fs.mkdirSync(/* turbopackIgnore: true */ jobsDir(), { recursive: true });
  job.updated_at = new Date().toISOString();
  fs.writeFileSync(/* turbopackIgnore: true */ jobFile(job.job_id), JSON.stringify(job, null, 2));
  return job;
}

export function updateDeepScanCheckpoint(
  jobId: string | null | undefined,
  phase: DeepScanPhase,
  patch: Partial<DeepScanCheckpoint> & { detail?: string; count?: number }
) {
  if (!jobId) return;
  const job = getDeepScanJob(jobId);
  if (!job) return;
  job.phase = phase;
  job.status = patch.status === "failed" ? "failed" : "running";
  const next = [...job.checkpoints];
  const index = next.findIndex((checkpoint) => checkpoint.phase === phase);
  const existing = index >= 0 ? next[index] : { phase, status: "pending" as const };
  const updated: DeepScanCheckpoint = {
    ...existing,
    ...patch,
    started_at: patch.status === "running" ? (existing.started_at ?? new Date().toISOString()) : existing.started_at,
    completed_at: patch.status === "completed" || patch.status === "failed" ? new Date().toISOString() : existing.completed_at,
  };
  if (index >= 0) next[index] = updated;
  else next.push(updated);
  job.checkpoints = next;
  saveDeepScanJob(job);
}

export function completeDeepScanJob(
  jobId: string,
  patch: Pick<DeepScanJob, "issues" | "assets" | "agent_trace">
) {
  const job = getDeepScanJob(jobId);
  if (!job) return null;
  job.status = "completed";
  job.phase = "completed";
  job.completed_at = new Date().toISOString();
  job.issues = patch.issues;
  job.assets = patch.assets;
  job.agent_trace = patch.agent_trace;
  return saveDeepScanJob(job);
}

export function failDeepScanJob(jobId: string, error: string) {
  const job = getDeepScanJob(jobId);
  if (!job) return null;
  job.status = "failed";
  job.phase = "failed";
  job.error = error;
  job.completed_at = new Date().toISOString();
  return saveDeepScanJob(job);
}
