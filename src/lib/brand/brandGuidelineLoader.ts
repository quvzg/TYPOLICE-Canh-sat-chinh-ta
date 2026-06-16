import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { BrandKit } from "@/types";
import { getActiveProjectId, projectGuidelinesDir } from "@/lib/server/db";
import { TEAM_SKILL_DEFAULTS } from "./teamSkillDefaults";

const DEFAULT_BRAND_KIT: BrandKit = {
  brand_terms: [
    "VNG",
    "VNG Group",
    "VNGGames",
    "GreenNode",
    "Starter",
    "AI Agent",
    "Life at VNG",
    "Life at VNGGames",
    "Life at Zalopay",
    "AI-native",
  ],
  protected_terms: [
    "Starter",
    "VNG",
    "VNG Group",
    "VNGGames",
    "GreenNode",
    "Life at VNG",
    "Life at VNGGames",
    "Life at Zalopay",
    "AI-native",
  ],
  allowed_hashtags: [],
  cta_rules: { preferred: [], avoid: {} },
  preferred_spellings: {
    ko: "không",
    k: "không",
    dc: "được",
    mik: "mình",
    bn: "bạn",
    hok: "không",
    thui: "thôi",
    vng: "VNG",
    Vng: "VNG",
    VNGG: "VNGGames",
    vinagame: "VNG",
    "vina game": "VNG",
    vinaGame: "VNG",
    VinaGame: "VNG",
    Vinagame: "VNG",
    "vng corp": "VNG Group",
    "VNG corp": "VNG Group",
    "vng corporation": "VNG Group",
    "VNG Corporation": "VNG Group",
    "green node": "GreenNode",
    "Green Node": "GreenNode",
    greennode: "GreenNode",
    zalo: "Zalo",
    ZALO: "Zalo",
    zing: "Zing",
    ZING: "Zing",
    "chỉnh chu": "chỉn chu",
  },
  ...TEAM_SKILL_DEFAULTS,
  do_not_change: [
    "Starter",
    "VNG",
    "VNG Group",
    "VNGGames",
    "GreenNode",
    "Life at VNG",
    "Life at VNGGames",
    "Life at Zalopay",
    "AI-native",
  ],
};

let cache: { hash: string; kit: BrandKit } | null = null;

export function guidelinesDir(): string {
  return path.join(/* turbopackIgnore: true */ process.cwd(), "brand_guidelines");
}

function guidelineFiles(dir: string): string[] {
  const files = [
    "style_guide.md",
    "tone_of_voice.md",
    "terminology.csv",
    "brand_kit.json",
  ].map((name) => path.join(dir, name));

  const campaignsDir = path.join(dir, "campaigns");
  try {
    for (const file of fs.readdirSync(campaignsDir).filter((name) => name.endsWith(".json")).sort()) {
      files.push(path.join(campaignsDir, file));
    }
  } catch {
    // no campaign overrides
  }

  return files;
}

function folderHash(dir: string): string {
  const h = crypto.createHash("sha1");
  for (const full of guidelineFiles(dir)) {
    try {
      const st = fs.statSync(full);
      if (st.isFile()) h.update(`${path.relative(dir, full)}:${st.mtimeMs}:${st.size};`);
    } catch { /* ignore */ }
  }
  return h.digest("hex");
}

function appendFolderHash(hash: crypto.Hash, label: string, dir: string) {
  hash.update(`${label}:${dir};`);
  hash.update(folderHash(dir));
}

function parseCsv(content: string): string[][] {
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(",").map((c) => c.trim()));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function applyStringMap(target: Record<string, string>, value: unknown) {
  if (!isStringRecord(value)) return;
  for (const [wrong, right] of Object.entries(value)) {
    if (typeof right === "string" && wrong.trim() && right.trim()) {
      target[wrong] = right;
    }
  }
}

function applyRiskyWords(
  target: BrandKit["risky_words"],
  value: unknown
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [phrase, info] of Object.entries(value)) {
    if (!phrase.trim() || !info || typeof info !== "object" || Array.isArray(info)) continue;
    const raw = info as Record<string, unknown>;
    const priority = raw.priority === "high" || raw.priority === "low" ? raw.priority : "medium";
    if (typeof raw.suggestion === "string" && raw.suggestion.trim()) {
      target[phrase] = { priority, suggestion: raw.suggestion };
    }
  }
}

function applyAmbiguousWords(target: BrandKit["ambiguous_words"], value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [word, candidates] of Object.entries(value)) {
    if (!word.trim() || !Array.isArray(candidates)) continue;
    const clean = candidates.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    if (clean.length) target[word] = clean;
  }
}

/**
 * Scan BRAND_GUIDELINES_DIR, merge brand_kit.json + terminology.csv +
 * style/tone markdown into a single brand context.
 * Campaign files under campaigns/*.json override global rules.
 * Cached by folder content hash.
 */
export function loadBrandKit(projectId?: string, scope?: string): BrandKit {
  const dir = guidelinesDir();
  const activeProjectId = projectId ?? getActiveProjectId(scope);
  const projectDir = projectGuidelinesDir(activeProjectId, scope);
  const h = crypto.createHash("sha1");
  h.update(`scope:${scope ?? "shared"};project:${activeProjectId};`);
  appendFolderHash(h, "global", dir);
  appendFolderHash(h, "project", projectDir);
  const hash = h.digest("hex");
  if (cache && cache.hash === hash) return cache.kit;

  const kit: BrandKit = JSON.parse(JSON.stringify(DEFAULT_BRAND_KIT));

  const readJson = (p: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return null;
    }
  };

  const applyKitJson = (data: Record<string, unknown>) => {
    if (Array.isArray(data.brand_terms)) kit.brand_terms = [...new Set([...kit.brand_terms, ...(data.brand_terms as string[])])];
    if (Array.isArray(data.protected_terms)) kit.protected_terms = [...new Set([...kit.protected_terms, ...(data.protected_terms as string[])])];
    applyStringMap(kit.preferred_spellings, data.preferred_spellings);
    applyStringMap(kit.product_terms, data.product_terms);
    applyStringMap(kit.preferred_wording, data.preferred_wording);
    applyStringMap(kit.missing_tone_map, data.missing_tone_map);
    applyStringMap(kit.wrong_tone_map, data.wrong_tone_map);
    applyRiskyWords(kit.risky_words, data.risky_words);
    applyAmbiguousWords(kit.ambiguous_words, data.ambiguous_words);
    const dnc = (data.do_not_change ?? data.do_not_translate) as string[] | undefined;
    if (Array.isArray(dnc)) kit.do_not_change = [...new Set([...kit.do_not_change, ...dnc])];
  };

  const applyGuidelineFolder = (sourceDir: string) => {
    if (!fs.existsSync(sourceDir)) return;
    // 3-4. markdown style/tone (lowest priority, passed to LLM as notes)
    const notes: string[] = [];
    for (const f of ["style_guide.md", "tone_of_voice.md"]) {
      const p = path.join(sourceDir, f);
      if (fs.existsSync(p)) notes.push(fs.readFileSync(p, "utf-8").slice(0, 4000));
    }
    if (notes.length) kit.style_notes = [kit.style_notes, notes.join("\n\n---\n\n")].filter(Boolean).join("\n\n---\n\n");

    // 3. CSV files
    const termCsv = path.join(sourceDir, "terminology.csv");
    if (fs.existsSync(termCsv)) {
      for (const [wrong, right] of parseCsv(fs.readFileSync(termCsv, "utf-8"))) {
        if (wrong && right && wrong.toLowerCase() !== "wrong") kit.preferred_spellings[wrong] = right;
      }
    }
    // 2. brand_kit.json
    const kitJson = readJson(path.join(sourceDir, "brand_kit.json"));
    if (kitJson) applyKitJson(kitJson);

    // 1. campaign overrides (highest priority — applied last)
    const campaignsDir = path.join(sourceDir, "campaigns");
    if (fs.existsSync(campaignsDir)) {
      for (const f of fs.readdirSync(campaignsDir).filter((f) => f.endsWith(".json")).sort()) {
        const data = readJson(path.join(campaignsDir, f));
        if (data) applyKitJson(data);
      }
    }
  };

  applyGuidelineFolder(dir);
  applyGuidelineFolder(projectDir);

  cache = { hash, kit };
  return kit;
}
