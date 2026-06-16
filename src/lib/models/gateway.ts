/**
 * OpenAI-compatible gateway client. The spec only defined AI_GATEWAY_API_KEY;
 * we additionally need AI_GATEWAY_BASE_URL and per-model IDs to actually call
 * a provider. All env reads happen server-side only.
 */

import type { AgentModelConfig } from "@/types";

export type ModelRole = keyof AgentModelConfig;

interface ChatMessage {
  role: "system" | "user";
  content:
    | string
    | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
}

function redact(key: string): string {
  return key.length > 6 ? `${key.slice(0, 5)}...REDACTED` : "REDACTED";
}

const ROLE_DEFAULT_FAMILY: Record<ModelRole, string> = {
  caption_qa: "qwen",
  verify: "minimax",
  image_qa: "gemma",
  report: "minimax",
};

const ROLE_ENV_KEY: Record<ModelRole, string> = {
  caption_qa: "MODEL_CAPTION_QA",
  verify: "MODEL_VERIFY",
  image_qa: "MODEL_IMAGE_QA",
  report: "MODEL_REPORT",
};

function familyFor(role: ModelRole): string {
  return process.env[ROLE_ENV_KEY[role]] ?? ROLE_DEFAULT_FAMILY[role];
}

function modelIdFor(family: string): string {
  const byFamily: Record<string, string | undefined> = {
    qwen: process.env.MODEL_ID_QWEN,
    minimax: process.env.MODEL_ID_MINIMAX,
    gemma: process.env.MODEL_ID_GEMMA,
    gemini: process.env.MODEL_ID_GEMINI ?? process.env.GEMINI_MODEL_ID ?? "gemini-2.5-flash-lite",
  };
  return byFamily[family] ?? family;
}

function baseUrlFor(family: string): string | undefined {
  const byFamily: Record<string, string | undefined> = {
    qwen: process.env.QWEN_BASE_URL,
    minimax: process.env.MINIMAX_BASE_URL,
    gemma: process.env.GEMMA_BASE_URL,
    gemini: process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai",
  };
  return byFamily[family] ?? process.env.AI_GATEWAY_BASE_URL;
}

function apiKeyFor(family: string): string | undefined {
  const byFamily: Record<string, string | undefined> = {
    qwen: process.env.QWEN_API_KEY,
    minimax: process.env.MINIMAX_API_KEY,
    gemma: process.env.GEMMA_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
  };
  return byFamily[family] ?? process.env.AI_GATEWAY_API_KEY;
}

export function isRoleConfigured(role: ModelRole): boolean {
  const family = familyFor(role);
  return Boolean(baseUrlFor(family) && apiKeyFor(family));
}

export function isModelConfigured(): boolean {
  return (Object.keys(ROLE_DEFAULT_FAMILY) as ModelRole[]).some((role) => isRoleConfigured(role));
}

export function modelLabelFor(role: ModelRole): string {
  const family = familyFor(role);
  const model = modelIdFor(family);
  return model ? `${family}: ${model}` : family;
}

export function getModelConfig(): AgentModelConfig {
  return {
    caption_qa: modelLabelFor("caption_qa"),
    verify: modelLabelFor("verify"),
    image_qa: modelLabelFor("image_qa"),
    report: modelLabelFor("report"),
  };
}

function contentToText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("\n")
      .trim();
    return text || null;
  }
  return null;
}

export async function chat(
  role: ModelRole,
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number } = {}
): Promise<string | null> {
  const family = familyFor(role);
  const base = baseUrlFor(family);
  const key = apiKeyFor(family);
  if (!base || !key) return null; // not configured → caller falls back to rules-only

  const url = `${base.replace(/\/$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: modelIdFor(family),
        messages,
        temperature: opts.temperature ?? 0.1,
        max_tokens: opts.maxTokens ?? 2048,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[gateway] ${role}/${family} HTTP ${res.status} (key=${redact(key)}): ${body.slice(0, 300)}`);
      return null;
    }
    const data = await res.json();
    const message = data?.choices?.[0]?.message;
    return (
      contentToText(message?.content) ??
      contentToText(message?.reasoning_content) ??
      contentToText(message?.reasoning) ??
      null
    );
  } catch (err) {
    console.error(`[gateway] ${role}/${family} failed (key=${redact(key)}):`, err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Extract the first JSON object/array from an LLM reply (handles ```json fences). */
export function extractJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const starts: number[] = [];
  for (let i = 0; i < candidate.length; i += 1) {
    if (candidate[i] === "{" || candidate[i] === "[") starts.push(i);
  }
  for (const start of starts) {
    // Try progressively shrinking from the last bracket. If an earlier JSON-like
    // fragment is malformed, continue to later starts instead of giving up.
    for (let end = candidate.length; end > start; end -= 1) {
      const ch = candidate[end - 1];
      if (ch !== "}" && ch !== "]") continue;
      try {
        return JSON.parse(candidate.slice(start, end)) as T;
      } catch { /* keep shrinking */ }
    }
  }
  return null;
}
