import fs from "fs";
import path from "path";
import type { NextRequest } from "next/server";
import type { Workspace } from "@/types";

/**
 * Hackathon-grade persistence stored as JSON under STORAGE_DIR.
 * The public API keeps using the active project so existing QA routes stay small.
 */

const storageDir = () => path.join(/* turbopackIgnore: true */ process.cwd(), "storage");
const legacyDbFile = () => path.join(storageDir(), "workspace.json");
const SHARED_SCOPE = "shared";
const DEFAULT_PROJECT_ID = "project_default";
export type ProjectKind = "check" | "project";

export interface ProjectSummary {
  id: string;
  name: string;
  kind: ProjectKind;
  created_at: string;
  updated_at: string;
}

interface ProjectIndex {
  active_project_id: string;
  projects: ProjectSummary[];
}

function inferProjectKind(name: string, id = ""): ProjectKind {
  return /^check\b/i.test(name.trim()) || /^check_/i.test(id) ? "check" : "project";
}

function defaultWorkspace(id = DEFAULT_PROJECT_ID, name = "Typolice Default Project", kind: ProjectKind = "project"): Workspace {
  return {
    id,
    name,
    kind,
    image_check_label: "Visual Text Scanner",
    created_at: new Date().toISOString(),
    assets: [],
    artboards: [],
    caption: { id: `caption_${id}`, platform: "all", text: "" },
    issues: [],
  };
}

// Survive Next.js dev hot-reload via globalThis
const g = globalThis as unknown as {
  __qa_ws_by_project?: Record<string, Workspace>;
  __qa_project_index_by_scope?: Record<string, ProjectIndex>;
};

function safeProjectId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function safeScope(scope?: string | null): string {
  const clean = (scope ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return clean || SHARED_SCOPE;
}

export function deviceScopeFromRequest(req: NextRequest): string {
  return safeScope(
    req.headers.get("x-typolice-device-id") ||
      req.cookies.get("typolice_device_id")?.value ||
      SHARED_SCOPE
  );
}

function scopedStorageDir(scope?: string | null): string {
  const safe = safeScope(scope);
  return safe === SHARED_SCOPE ? storageDir() : path.join(storageDir(), "devices", safe);
}

function projectsDir(scope?: string | null): string {
  return path.join(scopedStorageDir(scope), "projects");
}

function projectIndexFile(scope?: string | null): string {
  return path.join(projectsDir(scope), "index.json");
}

function scopedCacheKey(scope: string | undefined | null, projectId: string): string {
  return `${safeScope(scope)}:${safeProjectId(projectId)}`;
}

function projectDir(projectId: string, scope?: string | null): string {
  return path.join(projectsDir(scope), safeProjectId(projectId));
}

function workspaceFile(projectId: string, scope?: string | null): string {
  return path.join(projectDir(projectId, scope), "workspace.json");
}

function makeSummary(ws: Workspace): ProjectSummary {
  return {
    id: ws.id,
    name: ws.name,
    kind: ws.kind ?? inferProjectKind(ws.name, ws.id),
    created_at: ws.created_at,
    updated_at: new Date().toISOString(),
  };
}

function readWorkspaceFile(projectId: string, scope?: string | null): Workspace {
  try {
    const ws = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ workspaceFile(projectId, scope), "utf-8")) as Workspace;
    return { ...ws, kind: ws.kind ?? inferProjectKind(ws.name, ws.id || projectId) };
  } catch {
    if (safeScope(scope) === SHARED_SCOPE && projectId === DEFAULT_PROJECT_ID) {
      try {
        const legacy = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ legacyDbFile(), "utf-8")) as Workspace;
        return { ...legacy, id: legacy.id || DEFAULT_PROJECT_ID, kind: legacy.kind ?? inferProjectKind(legacy.name, legacy.id || DEFAULT_PROJECT_ID) };
      } catch {
        // fall through
      }
    }
    return defaultWorkspace(projectId, projectId === DEFAULT_PROJECT_ID ? "Typolice Default Project" : "Untitled Project", inferProjectKind("", projectId));
  }
}

function writeWorkspaceFile(projectId: string, ws: Workspace, scope?: string | null): void {
  fs.mkdirSync(/* turbopackIgnore: true */ projectDir(projectId, scope), { recursive: true });
  fs.writeFileSync(/* turbopackIgnore: true */ workspaceFile(projectId, scope), JSON.stringify(ws, null, 2));
}

function ensureProjectIndex(scope?: string | null): ProjectIndex {
  const scopeKey = safeScope(scope);
  g.__qa_project_index_by_scope ??= {};
  if (g.__qa_project_index_by_scope[scopeKey]) return g.__qa_project_index_by_scope[scopeKey];
  fs.mkdirSync(/* turbopackIgnore: true */ projectsDir(scopeKey), { recursive: true });

  try {
    const index = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ projectIndexFile(scopeKey), "utf-8")) as ProjectIndex;
    if (index.projects.length > 0) {
      const normalized: ProjectIndex = {
        active_project_id: index.active_project_id,
        projects: index.projects.map((project) => ({
          ...project,
          kind: project.kind ?? inferProjectKind(project.name, project.id),
        })),
      };
      g.__qa_project_index_by_scope[scopeKey] = normalized;
      if (JSON.stringify(index) !== JSON.stringify(normalized)) {
        fs.writeFileSync(/* turbopackIgnore: true */ projectIndexFile(scopeKey), JSON.stringify(normalized, null, 2));
      }
      return normalized;
    }
  } catch {
    // migrate/create below
  }

  const ws = readWorkspaceFile(DEFAULT_PROJECT_ID, scopeKey);
  const migrated: Workspace = {
    ...ws,
    id: ws.id && ws.id !== "workspace_default" ? ws.id : DEFAULT_PROJECT_ID,
  };
  writeWorkspaceFile(migrated.id, migrated, scopeKey);
  const index: ProjectIndex = {
    active_project_id: migrated.id,
    projects: [makeSummary(migrated)],
  };
  fs.writeFileSync(/* turbopackIgnore: true */ projectIndexFile(scopeKey), JSON.stringify(index, null, 2));
  g.__qa_project_index_by_scope[scopeKey] = index;
  return index;
}

function saveProjectIndex(index: ProjectIndex, scope?: string | null): void {
  const scopeKey = safeScope(scope);
  fs.mkdirSync(/* turbopackIgnore: true */ projectsDir(scopeKey), { recursive: true });
  g.__qa_project_index_by_scope ??= {};
  g.__qa_project_index_by_scope[scopeKey] = index;
  fs.writeFileSync(/* turbopackIgnore: true */ projectIndexFile(scopeKey), JSON.stringify(index, null, 2));
}

export function listProjects(scope?: string | null): ProjectSummary[] {
  return ensureProjectIndex(scope).projects;
}

export function getActiveProjectId(scope?: string | null): string {
  return ensureProjectIndex(scope).active_project_id;
}

export function setActiveProject(projectId: string, scope?: string | null): void {
  const index = ensureProjectIndex(scope);
  if (!index.projects.some((project) => project.id === projectId)) {
    throw new Error("Project not found");
  }
  index.active_project_id = projectId;
  saveProjectIndex(index, scope);
}

export function createProject(name = "Untitled Project", kind: ProjectKind = "project", scope?: string | null): Workspace {
  const index = ensureProjectIndex(scope);
  const id = `${kind}_${Date.now().toString(36)}`;
  const safeName = name.trim() || (kind === "check" ? "Check" : "Untitled Project");
  const ws = defaultWorkspace(id, safeName, kind);
  writeWorkspaceFile(id, ws, scope);
  index.projects = [makeSummary(ws), ...index.projects];
  index.active_project_id = id;
  saveProjectIndex(index, scope);
  g.__qa_ws_by_project = { ...(g.__qa_ws_by_project ?? {}), [scopedCacheKey(scope, id)]: ws };
  return ws;
}

export function deleteProject(projectId: string, scope?: string | null): void {
  const id = safeProjectId(projectId);
  const index = ensureProjectIndex(scope);
  const existing = index.projects.find((project) => project.id === id);
  if (!existing) throw new Error("Project not found");

  index.projects = index.projects.filter((project) => project.id !== id);
  delete g.__qa_ws_by_project?.[scopedCacheKey(scope, id)];
  fs.rmSync(/* turbopackIgnore: true */ projectDir(id, scope), { recursive: true, force: true });

  if (index.projects.length === 0) {
    const ws = defaultWorkspace();
    writeWorkspaceFile(ws.id, ws, scope);
    index.projects = [makeSummary(ws)];
    index.active_project_id = ws.id;
    g.__qa_ws_by_project = { ...(g.__qa_ws_by_project ?? {}), [scopedCacheKey(scope, ws.id)]: ws };
  } else if (index.active_project_id === id) {
    index.active_project_id = index.projects[0].id;
  }

  saveProjectIndex(index, scope);
}

export function renameProject(projectId: string, name: string, scope?: string | null): Workspace {
  const id = safeProjectId(projectId);
  const nextName = name.trim();
  if (!nextName) throw new Error("Project name required");

  const index = ensureProjectIndex(scope);
  const existing = index.projects.find((project) => project.id === id);
  if (!existing) throw new Error("Project not found");

  const ws = { ...getWorkspace(id, scope), name: nextName };
  writeWorkspaceFile(id, ws, scope);
  g.__qa_ws_by_project = { ...(g.__qa_ws_by_project ?? {}), [scopedCacheKey(scope, id)]: ws };

  index.projects = index.projects.map((project) =>
    project.id === id
      ? { ...project, name: nextName, updated_at: new Date().toISOString() }
      : project
  );
  saveProjectIndex(index, scope);
  return ws;
}

export function getWorkspace(projectId?: string, scope?: string | null): Workspace {
  const id = safeProjectId(projectId ?? getActiveProjectId(scope));
  const cacheKey = scopedCacheKey(scope, id);
  g.__qa_ws_by_project ??= {};
  if (g.__qa_ws_by_project[cacheKey]) return g.__qa_ws_by_project[cacheKey];
  const ws = readWorkspaceFile(id, scope);
  g.__qa_ws_by_project[cacheKey] = ws;
  return ws;
}

export function saveWorkspace(ws: Workspace, projectId?: string, scope?: string | null): void {
  const id = safeProjectId(projectId ?? getActiveProjectId(scope));
  const persisted = { ...ws, id, kind: ws.kind ?? inferProjectKind(ws.name, id) };
  const cacheKey = scopedCacheKey(scope, id);
  g.__qa_ws_by_project ??= {};
  g.__qa_ws_by_project[cacheKey] = persisted;
  writeWorkspaceFile(id, persisted, scope);

  const index = ensureProjectIndex(scope);
  const summary = makeSummary(persisted);
  const existing = index.projects.findIndex((project) => project.id === id);
  if (existing >= 0) index.projects[existing] = summary;
  else index.projects.unshift(summary);
  saveProjectIndex(index, scope);
}

export function uploadsDir(projectId?: string, scope?: string | null): string {
  const dir = path.join(projectDir(projectId ?? getActiveProjectId(scope), scope), "uploads");
  fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true });
  return dir;
}

export function projectGuidelinesDir(projectId?: string, scope?: string | null): string {
  const dir = path.join(projectDir(projectId ?? getActiveProjectId(scope), scope), "brand_guidelines");
  fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true });
  return dir;
}
