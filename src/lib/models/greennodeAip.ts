const IAM_TOKEN_URL = "https://iam.api.vngcloud.vn/accounts-api/v2/auth/token";
const AIP_MANAGEMENT_URL = process.env.GREENNODE_AIP_MANAGEMENT_URL ?? "https://aiplatform-hcm.api.vngcloud.vn";
export const GREENNODE_MAAS_BASE_URL =
  process.env.GREENNODE_MAAS_BASE_URL ?? "https://maas-llm-aiplatform-hcm.api.vngcloud.vn/v1";

type JsonObject = Record<string, unknown>;

interface TokenCache {
  token: string;
  expiresAt: number;
}

interface KeyCache {
  key: string;
  expiresAt: number;
}

interface ModelCache {
  byFamily: Map<string, string>;
  expiresAt: number;
}

interface AipApiKey {
  name?: string;
  key?: string;
  status?: string;
  isDefault?: boolean;
}

interface AipModel {
  uuid?: string;
  name?: string;
  code?: string;
  path?: string;
  description?: string;
  modelStatus?: string;
  isFree?: boolean;
  provider?: string | { id?: number; name?: string; code?: string };
  types?: string[];
  createdAt?: string;
}

let tokenCache: TokenCache | null = null;
let keyCache: KeyCache | null = null;
let modelCache: ModelCache | null = null;

function hasGreenNodeIamCredentials(): boolean {
  return Boolean(process.env.GREENNODE_CLIENT_ID && process.env.GREENNODE_CLIENT_SECRET);
}

export function canUseGreenNodeAipFallback(family: string): boolean {
  return family !== "gemini" && hasGreenNodeIamCredentials() && process.env.GREENNODE_AIP_FALLBACK !== "false";
}

function decodeJwtExpiry(token: string): number {
  try {
    const payload = token.split(".")[1];
    if (!payload) return Date.now() + 50 * 60_000;
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
    const parsed = JSON.parse(Buffer.from(padded, "base64url").toString("utf8")) as { exp?: number };
    return parsed.exp ? parsed.exp * 1000 : Date.now() + 50 * 60_000;
  } catch {
    return Date.now() + 50 * 60_000;
  }
}

function extractList<T>(data: unknown): T[] {
  if (!data || typeof data !== "object") return [];
  const object = data as JsonObject;
  const list = object.listData ?? object.data ?? object.content;
  return Array.isArray(list) ? (list as T[]) : [];
}

async function getGreenNodeIamToken(): Promise<string | null> {
  if (!hasGreenNodeIamCredentials()) return null;
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) return tokenCache.token;

  const clientId = process.env.GREENNODE_CLIENT_ID!;
  const clientSecret = process.env.GREENNODE_CLIENT_SECRET!;
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  try {
    const res = await fetch(IAM_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[greennode-aip] IAM token HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as { access_token?: string };
    if (!data.access_token) return null;
    tokenCache = {
      token: data.access_token,
      expiresAt: decodeJwtExpiry(data.access_token),
    };
    return tokenCache.token;
  } catch (err) {
    console.error("[greennode-aip] IAM token failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function aipFetch(path: string, init: RequestInit = {}): Promise<unknown | null> {
  const token = await getGreenNodeIamToken();
  if (!token) return null;
  try {
    const res = await fetch(`${AIP_MANAGEMENT_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[greennode-aip] ${path} HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    return res.json();
  } catch (err) {
    console.error(`[greennode-aip] ${path} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

function chooseApiKey(keys: AipApiKey[]): AipApiKey | null {
  const active = keys.filter((item) => (item.status ?? "ACTIVE").toUpperCase() === "ACTIVE");
  return active.find((item) => item.isDefault) ?? active[0] ?? null;
}

async function getApiKeyByName(name: string): Promise<string | null> {
  const data = await aipFetch(`/v1/api-keys/${encodeURIComponent(name)}`);
  if (!data || typeof data !== "object") return null;
  const object = data as JsonObject;
  const key =
    typeof object.key === "string"
      ? object.key
      : object.data && typeof object.data === "object" && typeof (object.data as JsonObject).key === "string"
        ? ((object.data as JsonObject).key as string)
        : null;
  return key;
}

async function createApiKey(): Promise<string | null> {
  if (process.env.GREENNODE_AIP_AUTO_CREATE_KEY !== "true") return null;
  const name = process.env.GREENNODE_AIP_API_KEY_NAME ?? "typolice-runtime";
  const data = await aipFetch("/v2/api-keys", {
    method: "POST",
    body: JSON.stringify({ name, isDefault: true }),
  });
  if (!data || typeof data !== "object") return null;
  const object = data as JsonObject;
  const key =
    typeof object.key === "string"
      ? object.key
      : object.data && typeof object.data === "object" && typeof (object.data as JsonObject).key === "string"
        ? ((object.data as JsonObject).key as string)
        : null;
  return key;
}

export async function getGreenNodeLlmApiKey(): Promise<string | null> {
  const explicit = process.env.LLM_API_KEY ?? process.env.AIP_API_KEY ?? process.env.GREENNODE_LLM_API_KEY;
  if (explicit) return explicit;

  const now = Date.now();
  if (keyCache && keyCache.expiresAt > now) return keyCache.key;

  const preferredName = process.env.GREENNODE_AIP_API_KEY_NAME ?? process.env.AIP_API_KEY_NAME ?? process.env.LLM_API_KEY_NAME;
  let key = preferredName ? await getApiKeyByName(preferredName) : null;

  if (!key) {
    const data = await aipFetch("/v1/api-keys?page=1&size=100");
    const selected = chooseApiKey(extractList<AipApiKey>(data));
    key = selected?.key ?? (selected?.name ? await getApiKeyByName(selected.name) : null);
  }

  key = key ?? (await createApiKey());
  if (!key) return null;

  keyCache = {
    key,
    expiresAt: now + 10 * 60_000,
  };
  return key;
}

function modelText(model: AipModel): string {
  const provider =
    typeof model.provider === "string"
      ? model.provider
      : [model.provider?.name, model.provider?.code].filter(Boolean).join(" ");
  return [
    model.path,
    model.code,
    model.name,
    provider,
    model.description,
    ...(Array.isArray(model.types) ? model.types : []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function scoreModel(model: AipModel, family: string): number {
  const target = (
    process.env[`GREENNODE_MODEL_${family.toUpperCase()}_QUERY`] ??
    process.env[`AIP_MODEL_${family.toUpperCase()}_QUERY`] ??
    family
  ).toLowerCase();
  const text = modelText(model);
  let score = 0;
  if ((model.modelStatus ?? "").toUpperCase() === "ENABLED") score += 20;
  if (text.includes(target)) score += 12;
  if (model.path?.toLowerCase().includes(target)) score += 6;
  if (model.code?.toLowerCase().includes(target)) score += 4;
  if (family === "gemma" && /\b(vision|vl|image|multimodal)\b/.test(text)) score += 3;
  if (model.isFree) score += 1;
  return score;
}

async function loadModelPaths(): Promise<Map<string, string>> {
  const now = Date.now();
  if (modelCache && modelCache.expiresAt > now) return modelCache.byFamily;

  const data = await aipFetch("/v1/models?status=ENABLED&page=1&size=100");
  const models = extractList<AipModel>(data);
  const byFamily = new Map<string, string>();

  for (const family of ["qwen", "minimax", "gemma"]) {
    const ranked = models
      .map((model) => ({ model, score: scoreModel(model, family) }))
      .filter((item) => item.score > 0 && (item.model.path || item.model.code))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return Date.parse(b.model.createdAt ?? "") - Date.parse(a.model.createdAt ?? "");
      });
    const selected = ranked[0]?.model;
    const modelPath = selected?.path ?? selected?.code;
    if (modelPath) byFamily.set(family, modelPath);
  }

  modelCache = {
    byFamily,
    expiresAt: now + 10 * 60_000,
  };
  return byFamily;
}

export async function getGreenNodeModelPath(family: string): Promise<string | null> {
  const explicit = process.env[`MODEL_ID_${family.toUpperCase()}`];
  if (explicit) return explicit;
  const paths = await loadModelPaths();
  return paths.get(family) ?? null;
}
