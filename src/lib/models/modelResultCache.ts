import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { AgentModelConfig } from "@/types";

export type CacheableModelRole = keyof AgentModelConfig;

const CACHE_VERSION = "model-cache-v1";
const storageDir = () => path.join(/* turbopackIgnore: true */ process.cwd(), "storage");
const cacheDir = () => path.join(storageDir(), "model-cache");

export function stableHash(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function cachePath(key: string) {
  return path.join(cacheDir(), `${key}.json`);
}

export function modelCacheKey(input: {
  modelRole: CacheableModelRole;
  promptVersion: string;
  contentHash: string;
  brandKitHash: string;
}) {
  return stableHash({
    version: CACHE_VERSION,
    modelRole: input.modelRole,
    promptVersion: input.promptVersion,
    contentHash: input.contentHash,
    brandKitHash: input.brandKitHash,
  });
}

export async function cachedModelResult<T>(
  input: {
    modelRole: CacheableModelRole;
    promptVersion: string;
    contentHash: string;
    brandKitHash: string;
  },
  run: () => Promise<T | null>
): Promise<{ value: T | null; cacheHit: boolean }> {
  fs.mkdirSync(/* turbopackIgnore: true */ cacheDir(), { recursive: true });
  const key = modelCacheKey(input);
  const file = cachePath(key);
  try {
    if (fs.existsSync(/* turbopackIgnore: true */ file)) {
      return {
        value: JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf-8")) as T,
        cacheHit: true,
      };
    }
  } catch {
    // Ignore broken cache entries and regenerate.
  }

  const value = await run();
  if (value !== null) {
    try {
      fs.writeFileSync(/* turbopackIgnore: true */ file, JSON.stringify(value));
    } catch {
      // Cache write failures must not block QA.
    }
  }
  return { value, cacheHit: false };
}
