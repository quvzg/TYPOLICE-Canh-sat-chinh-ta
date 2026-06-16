import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { loadBrandKit } from "@/lib/brand/brandGuidelineLoader";
import { deviceScopeFromRequest } from "@/lib/server/db";
import { runRuleChecker } from "@/lib/qa/ruleChecker";
import { mergeIssues, summarize, validateLLMIssues } from "@/lib/qa/issueMerger";
import { protectedTermsFromBrandKit } from "@/lib/qa/protectedText";
import { llmCaptionQA, llmVerify } from "@/lib/models/adapters";
import { isRoleConfigured } from "@/lib/models/gateway";
import type { Issue } from "@/types";

// cache by caption hash + brand kit hash
const cache = new Map<string, { issues: Issue[]; llm_used: boolean }>();

export async function POST(req: NextRequest) {
  const scope = deviceScopeFromRequest(req);
  const { text, caption_id = "caption_default", use_llm = true, verify = false } = await req.json();
  if (typeof text !== "string") {
    return NextResponse.json({ error: "text required" }, { status: 400 });
  }

  const brandKit = loadBrandKit(undefined, scope);
  const protectedTerms = protectedTermsFromBrandKit(brandKit);
  const cacheKey = crypto
    .createHash("sha1")
    .update(text + JSON.stringify(brandKit) + String(use_llm) + String(verify))
    .digest("hex");
  const hit = cache.get(cacheKey);
  if (hit) {
    return NextResponse.json({ ...hit, summary: summarize(hit.issues), cached: true });
  }

  const source = { source_type: "caption" as const, source_id: caption_id };

  // Fast path: rules always run
  const ruleIssues = runRuleChecker(text, brandKit, source);

  // Standard path: one LLM call (Qwen/MiniMax per env routing)
  let llmIssues: Issue[] = [];
  let llmUsed = false;
  if (use_llm && isRoleConfigured("caption_qa")) {
    const candidates = await llmCaptionQA(text, brandKit);
    if (candidates) {
      llmUsed = true;
      llmIssues = validateLLMIssues(
        text,
        candidates.map((c) => ({ ...c, source_type: "caption", source_id: caption_id, created_by: "llm_caption_qa" } as Partial<Issue>)),
        protectedTerms
      );
    }
  }

  let issues = mergeIssues(ruleIssues, llmIssues);

  // Critical path: verifier pass over LLM-found issues only (rules are deterministic)
  if (verify && llmUsed && llmIssues.length > 0) {
    const verdict = await llmVerify(text, brandKit, llmIssues);
    if (verdict) {
      issues = issues.filter(
        (i) => i.created_by === "rule_checker" || verdict.kept.has(i.issue_id)
      );
    }
  }

  const result = { issues, llm_used: llmUsed };
  cache.set(cacheKey, result);
  return NextResponse.json({ ...result, summary: summarize(issues), cached: false });
}
