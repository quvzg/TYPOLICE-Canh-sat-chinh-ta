/**
 * OpenAI-compatible gateway client. The spec only defined AI_GATEWAY_API_KEY;
 * we additionally need AI_GATEWAY_BASE_URL and per-model IDs to actually call
 * a provider. All env reads happen server-side only.
 */

import type { AgentModelConfig } from "@/types";
import {
  canUseGreenNodeAipFallback,
  getGreenNodeLlmApiKey,
  getGreenNodeModelPath,
  GREENNODE_MAAS_BASE_URL,
} from "./greennodeAip";

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

function envValue(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
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
  return envValue(ROLE_ENV_KEY[role]) ?? ROLE_DEFAULT_FAMILY[role];
}

function modelIdFor(family: string): string {
  const byFamily: Record<string, string | undefined> = {
    qwen: envValue("MODEL_ID_QWEN"),
    minimax: envValue("MODEL_ID_MINIMAX"),
    gemma: envValue("MODEL_ID_GEMMA"),
    gemini: envValue("MODEL_ID_GEMINI") ?? envValue("GEMINI_MODEL_ID") ?? "gemini-2.5-flash-lite",
  };
  return byFamily[family] ?? family;
}

function baseUrlFor(family: string): string | undefined {
  const byFamily: Record<string, string | undefined> = {
    qwen: envValue("QWEN_BASE_URL"),
    minimax: envValue("MINIMAX_BASE_URL"),
    gemma: envValue("GEMMA_BASE_URL"),
    gemini: envValue("GEMINI_BASE_URL") ?? "https://generativelanguage.googleapis.com/v1beta/openai",
  };
  return byFamily[family] ?? envValue("AI_GATEWAY_BASE_URL");
}

function apiKeyFor(family: string): string | undefined {
  const byFamily: Record<string, string | undefined> = {
    qwen: envValue("QWEN_API_KEY"),
    minimax: envValue("MINIMAX_API_KEY"),
    gemma: envValue("GEMMA_API_KEY"),
    gemini: envValue("GEMINI_API_KEY"),
  };
  return byFamily[family] ?? envValue("AI_GATEWAY_API_KEY");
}

function providerSupportsChatTemplateKwargs(active: { base: string; fromGreenNodeFallback?: boolean }): boolean {
  if (active.fromGreenNodeFallback) return true;
  return !/generativelanguage\.googleapis\.com\/v1beta\/openai/i.test(active.base);
}

export function isRoleConfigured(role: ModelRole): boolean {
  const family = familyFor(role);
  return Boolean(baseUrlFor(family) && apiKeyFor(family)) || canUseGreenNodeAipFallback(family);
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

async function runtimeConfigFor(
  family: string,
  opts: { forceGreenNodeFallback?: boolean } = {}
): Promise<{ base?: string; key?: string; model?: string; fromGreenNodeFallback?: boolean }> {
  const directBase = baseUrlFor(family);
  const directKey = apiKeyFor(family);
  const directModel = modelIdFor(family);
  if (!opts.forceGreenNodeFallback && directBase && directKey) {
    return { base: directBase, key: directKey, model: directModel, fromGreenNodeFallback: false };
  }

  if (!canUseGreenNodeAipFallback(family)) return { base: directBase, key: directKey, model: directModel };
  const key = await getGreenNodeLlmApiKey();
  const model = await getGreenNodeModelPath(family);
  if (!key || !model) return { base: directBase, key: directKey, model: directModel };
  return {
    base: GREENNODE_MAAS_BASE_URL,
    key,
    model,
    fromGreenNodeFallback: true,
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
  const config = await runtimeConfigFor(family);
  if (!config.base || !config.key || !config.model) return null; // not configured → caller falls back to rules-only

  const request = async (active: { base: string; key: string; model: string; fromGreenNodeFallback?: boolean }) => {
    const url = `${active.base.replace(/\/$/, "")}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${active.key}`,
        },
        body: JSON.stringify({
          model: active.model,
          messages,
          temperature: opts.temperature ?? 0.1,
          max_tokens: opts.maxTokens ?? 2048,
          ...(providerSupportsChatTemplateKwargs(active)
            ? { chat_template_kwargs: { enable_thinking: false } }
            : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.error(`[gateway] ${role}/${family} HTTP ${res.status} (key=${redact(active.key)}): ${body.slice(0, 300)}`);
        return { ok: false as const, text: null };
      }
      const data = await res.json();
      const message = data?.choices?.[0]?.message;
      return {
        ok: true as const,
        text:
          contentToText(message?.content) ??
          contentToText(message?.reasoning_content) ??
          contentToText(message?.reasoning) ??
          null,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const first = await request({ base: config.base, key: config.key, model: config.model, fromGreenNodeFallback: config.fromGreenNodeFallback });
    if (first.ok) return first.text;

    if (!config.fromGreenNodeFallback && canUseGreenNodeAipFallback(family)) {
      const fallback = await runtimeConfigFor(family, { forceGreenNodeFallback: true });
      if (fallback.base && fallback.key && fallback.model) {
        const retried = await request({ base: fallback.base, key: fallback.key, model: fallback.model, fromGreenNodeFallback: true });
        return retried.ok ? retried.text : null;
      }
    }
    return null;
  } catch (err) {
    console.error(`[gateway] ${role}/${family} failed (key=${redact(config.key)}):`, err instanceof Error ? err.message : err);
    if (!config.fromGreenNodeFallback && canUseGreenNodeAipFallback(family)) {
      try {
        const fallback = await runtimeConfigFor(family, { forceGreenNodeFallback: true });
        if (fallback.base && fallback.key && fallback.model) {
          const retried = await request({ base: fallback.base, key: fallback.key, model: fallback.model, fromGreenNodeFallback: true });
          return retried.ok ? retried.text : null;
        }
      } catch (fallbackErr) {
        console.error(`[gateway] ${role}/${family} GreenNode fallback failed:`, fallbackErr instanceof Error ? fallbackErr.message : fallbackErr);
      }
    }
    return null;
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
