import { NextRequest, NextResponse } from "next/server";
import { createProject, deleteProject, deviceScopeFromRequest, getActiveProjectId, getWorkspace, listProjects, renameProject, setActiveProject } from "@/lib/server/db";

export async function GET(req: NextRequest) {
  const scope = deviceScopeFromRequest(req);
  return NextResponse.json({
    active_project_id: getActiveProjectId(scope),
    projects: listProjects(scope),
  });
}

export async function POST(req: NextRequest) {
  const scope = deviceScopeFromRequest(req);
  const body = await req.json().catch(() => ({}));
  const action = typeof body.action === "string" ? body.action : "create";

  if (action === "switch") {
    const projectId = typeof body.project_id === "string" ? body.project_id : "";
    if (!projectId) {
      return NextResponse.json({ error: "project_id required" }, { status: 400 });
    }
    try {
      setActiveProject(projectId, scope);
    } catch {
      return NextResponse.json({ error: "project not found" }, { status: 404 });
    }
    return NextResponse.json({
      active_project_id: getActiveProjectId(scope),
      projects: listProjects(scope),
      workspace: getWorkspace(undefined, scope),
    });
  }

  if (action === "create") {
    const name = typeof body.name === "string" ? body.name : "Untitled Project";
    const kind = body.kind === "check" ? "check" : "project";
    const workspace = createProject(name, kind, scope);
    return NextResponse.json({
      active_project_id: getActiveProjectId(scope),
      projects: listProjects(scope),
      workspace,
    });
  }

  if (action === "delete") {
    const projectId = typeof body.project_id === "string" ? body.project_id : "";
    if (!projectId) {
      return NextResponse.json({ error: "project_id required" }, { status: 400 });
    }
    try {
      deleteProject(projectId, scope);
    } catch {
      return NextResponse.json({ error: "project not found" }, { status: 404 });
    }
    return NextResponse.json({
      active_project_id: getActiveProjectId(scope),
      projects: listProjects(scope),
      workspace: getWorkspace(undefined, scope),
    });
  }

  if (action === "rename") {
    const projectId = typeof body.project_id === "string" ? body.project_id : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!projectId) {
      return NextResponse.json({ error: "project_id required" }, { status: 400 });
    }
    if (!name) {
      return NextResponse.json({ error: "name required" }, { status: 400 });
    }
    try {
      const workspace = renameProject(projectId, name, scope);
      return NextResponse.json({
        active_project_id: getActiveProjectId(scope),
        projects: listProjects(scope),
        workspace,
      });
    } catch {
      return NextResponse.json({ error: "project not found" }, { status: 404 });
    }
  }

  return NextResponse.json({ error: "invalid action" }, { status: 400 });
}
