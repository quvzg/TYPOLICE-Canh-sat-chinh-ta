"use client";

import { useEffect, useMemo, useState } from "react";
import { useQAStore, type AppMode } from "@/lib/store";

type ThemeMode = "dark" | "light";

function PoliceStarIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`${className} fill-none stroke-current stroke-[1.65]`} aria-hidden="true">
      <path
        d="m12 2.4 2.2 4.1 4.6.7-3.2 3.4.7 4.6-4.3-2-4.3 2 .7-4.6-3.2-3.4 4.6-.7L12 2.4Z"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="9.6" r="2.05" />
      <path d="M8.35 18.8h7.3M9.55 16.65h4.9" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.7]" aria-hidden="true">
      <circle cx="7" cy="7" r="3.8" />
      <path d="m10 10 3 3" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.7]" aria-hidden="true">
      <path d="M8 3.4v9.2M3.4 8h9.2" strokeLinecap="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current stroke-[1.55]" aria-hidden="true">
      <path d="M2.5 5.1c0-.7.5-1.2 1.2-1.2h3l1.2 1.4h4.4c.7 0 1.2.5 1.2 1.2v5.4c0 .7-.5 1.2-1.2 1.2H3.7c-.7 0-1.2-.5-1.2-1.2V5.1Z" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.7]" aria-hidden="true">
      <path d="m4.4 6.3 3.6 3.6 3.6-3.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current" aria-hidden="true">
      <circle cx="4" cy="8" r="1" />
      <circle cx="8" cy="8" r="1" />
      <circle cx="12" cy="8" r="1" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.6]">
      <circle cx="8" cy="8" r="2.8" />
      <path d="M8 1.8v1.3M8 12.9v1.3M3.6 3.6l.9.9M11.5 11.5l.9.9M1.8 8h1.3M12.9 8h1.3M3.6 12.4l.9-.9M11.5 4.5l.9-.9" strokeLinecap="round" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="cp-theme-moon-icon h-4 w-4 fill-none stroke-current stroke-[1.6]">
      <path d="M12.7 10.2A5.5 5.5 0 0 1 5.8 3.3 5.7 5.7 0 1 0 12.7 10.2Z" strokeLinejoin="round" />
    </svg>
  );
}

function HistoryItem({
  active,
  busy,
  isRenaming,
  name,
  updatedAt,
  icon,
  onClick,
  menuOpen,
  onMenuToggle,
  onRename,
  onRenameSubmit,
  onRenameCancel,
  onDelete,
}: {
  active: boolean;
  busy: boolean;
  isRenaming: boolean;
  name: string;
  updatedAt: string;
  icon?: React.ReactNode;
  onClick: () => void;
  menuOpen: boolean;
  onMenuToggle: () => void;
  onRename: () => void;
  onRenameSubmit: (name: string) => void;
  onRenameCancel: () => void;
  onDelete: () => void;
}) {
  const [draftName, setDraftName] = useState(name);

  useEffect(() => {
    setDraftName(name);
  }, [name]);

  const commitRename = () => {
    const clean = draftName.trim();
    if (!clean || clean === name) {
      onRenameCancel();
      return;
    }
    onRenameSubmit(clean);
  };

  return (
    <div className={`cp-sidebar-history-item ${active ? "is-active" : ""} ${menuOpen ? "has-menu-open" : ""}`}>
      {isRenaming ? (
        <div className="cp-sidebar-history-main cp-sidebar-history-editing">
          {icon && <span className="cp-sidebar-history-icon">{icon}</span>}
          <span className="min-w-0 flex-1">
            <input
              autoFocus
              value={draftName}
              onChange={(event) => setDraftName(event.currentTarget.value)}
              onFocus={(event) => event.currentTarget.select()}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDraftName(name);
                  onRenameCancel();
                }
              }}
              className="cp-sidebar-history-name-input"
              aria-label={`Rename ${name}`}
            />
            <span className="mt-0.5 block truncate text-[11px] text-zinc-600">
              {new Date(updatedAt).toLocaleDateString("vi-VN")}
            </span>
          </span>
        </div>
      ) : (
        <button
          type="button"
          onClick={onClick}
          className="cp-sidebar-history-main"
        >
          {icon && <span className="cp-sidebar-history-icon">{icon}</span>}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">
              {busy ? "Loading..." : name}
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-zinc-600">
              {new Date(updatedAt).toLocaleDateString("vi-VN")}
            </span>
          </span>
        </button>
      )}
      {!isRenaming && (
        <button
          type="button"
          className="cp-sidebar-history-menu-trigger"
          title="More actions"
          aria-label={`More actions for ${name}`}
          aria-expanded={menuOpen}
          onClick={(event) => {
            event.stopPropagation();
            onMenuToggle();
          }}
        >
          <DotsIcon />
        </button>
      )}
      {menuOpen && !isRenaming && (
        <div className="cp-sidebar-history-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="cp-sidebar-history-menu-item"
            onClick={(event) => {
              event.stopPropagation();
              onRename();
            }}
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            className="cp-sidebar-history-delete"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

function SectionHeader({
  title,
  onTitleClick,
  onCreate,
  createTitle,
}: {
  title: string;
  onTitleClick: () => void;
  onCreate: () => void;
  createTitle: string;
}) {
  return (
    <div className="cp-sidebar-section-head">
      <button type="button" className="cp-sidebar-section-title" onClick={onTitleClick}>
        <span>{title}</span>
        <ChevronDownIcon />
      </button>
      <button type="button" className="cp-sidebar-icon-action" onClick={onCreate} title={createTitle} aria-label={createTitle}>
        <PlusIcon />
      </button>
    </div>
  );
}

export default function AppSidebar() {
  const appMode = useQAStore((s) => s.appMode);
  const setAppMode = useQAStore((s) => s.setAppMode);
  const setTab = useQAStore((s) => s.setTab);
  const projects = useQAStore((s) => s.projects);
  const activeProjectId = useQAStore((s) => s.activeProjectId);
  const switchProject = useQAStore((s) => s.switchProject);
  const createCheck = useQAStore((s) => s.createCheck);
  const createProject = useQAStore((s) => s.createProject);
  const renameProject = useQAStore((s) => s.renameProject);
  const deleteProject = useQAStore((s) => s.deleteProject);
  const llmConfigured = useQAStore((s) => s.llmConfigured);
  const [search, setSearch] = useState("");
  const [theme, setTheme] = useState<ThemeMode>("light");
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [creatingCheck, setCreatingCheck] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [openMenuProjectId, setOpenMenuProjectId] = useState<string | null>(null);
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem("typolice-theme");
    const initial: ThemeMode = saved === "dark" ? "dark" : "light";
    setTheme(initial);
    document.documentElement.dataset.theme = initial;
  }, []);

  const filteredProjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q ? projects.filter((project) => project.name.toLowerCase().includes(q)) : projects;
    return {
      projectHistory: filtered.filter((project) => project.kind !== "check"),
      checkHistory: filtered.filter((project) => project.kind === "check"),
    };
  }, [projects, search]);

  const handleNewCheck = async () => {
    if (creatingCheck) return;
    setCreatingCheck(true);
    try {
      await createCheck();
      setTab("issues");
    } catch {
      window.alert("Không tạo được check mới. Hãy thử lại.");
    } finally {
      setCreatingCheck(false);
    }
  };

  const openProject = async (projectId?: string) => {
    if (!projectId) {
      const firstProject = filteredProjects.projectHistory[0];
      if (firstProject) {
        await openProject(firstProject.id);
        return;
      }
      setAppMode("project");
      setTab("issues");
      return;
    }
    setBusyProjectId(projectId);
    try {
      await switchProject(projectId, "project");
      setTab("issues");
    } finally {
      setBusyProjectId(null);
    }
  };

  const openCheckHistory = async (projectId: string) => {
    setBusyProjectId(projectId);
    try {
      await switchProject(projectId, "check");
      setTab("issues");
    } finally {
      setBusyProjectId(null);
    }
  };

  const handleCreateProject = async () => {
    if (creatingProject) return;
    const stamp = new Intl.DateTimeFormat("vi-VN", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date());
    setCreatingProject(true);
    try {
      await createProject(`Project ${stamp}`);
      setTab("issues");
    } catch {
      window.alert("Không tạo được project mới. Hãy thử lại.");
    } finally {
      setCreatingProject(false);
    }
  };

  const handleDeleteProject = async (projectId: string, name: string) => {
    const ok = window.confirm(`Xoá "${name}" khỏi lịch sử? Nội dung và ảnh trong mục này sẽ bị xoá.`);
    if (!ok) return;
    setOpenMenuProjectId(null);
    setBusyProjectId(projectId);
    try {
      await deleteProject(projectId);
      setTab("issues");
    } catch {
      window.alert("Chưa xoá được mục này. Hãy thử lại.");
    } finally {
      setBusyProjectId(null);
    }
  };

  const handleStartRenameProject = (projectId: string) => {
    setOpenMenuProjectId(null);
    setRenamingProjectId(projectId);
  };

  const handleRenameProject = async (projectId: string, name: string) => {
    const clean = name.trim();
    if (!clean) {
      setRenamingProjectId(null);
      return;
    }
    setBusyProjectId(projectId);
    try {
      await renameProject(projectId, clean);
    } catch {
      window.alert("Chưa đổi tên được. Hãy thử lại.");
    } finally {
      setBusyProjectId(null);
      setRenamingProjectId(null);
    }
  };

  const toggleTheme = () => {
    setTheme((current) => {
      const next: ThemeMode = current === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      window.localStorage.setItem("typolice-theme", next);
      return next;
    });
  };

  return (
    <aside className="cp-sidebar flex w-[260px] shrink-0 flex-col border-r border-zinc-800 bg-zinc-950 px-3 py-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="cp-brand-lockup cp-sidebar-brand justify-start" aria-label="Typolice">
          <span className="cp-brand-mark grid shrink-0 place-items-center" aria-hidden="true">
            <PoliceStarIcon className="h-[18px] w-[18px]" />
          </span>
          <h1 className="truncate text-sm font-semibold tracking-tight text-current">Typolice</h1>
        </div>
        <button
          type="button"
          onClick={toggleTheme}
          aria-pressed={theme === "light"}
          className="cp-theme-toggle"
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          <span className="cp-theme-toggle-icon">
            {theme === "dark" ? <MoonIcon /> : <SunIcon />}
          </span>
          <span className="cp-theme-toggle-label">{theme === "dark" ? "Dark" : "Light"}</span>
        </button>
      </div>

      <label className="cp-sidebar-search mb-3">
        <SearchIcon />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search history"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-zinc-200 outline-none placeholder:text-zinc-600"
        />
      </label>

      <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
        <section className="space-y-1">
          <SectionHeader
            title="Projects"
            onTitleClick={() => void openProject()}
            onCreate={() => void handleCreateProject()}
            createTitle={creatingProject ? "Creating project" : "New project"}
          />
          {filteredProjects.projectHistory.length === 0 ? (
            <p className="cp-sidebar-empty">
              Chưa có project.
            </p>
          ) : (
            filteredProjects.projectHistory.map((project) => {
              const active = appMode === "project" && project.id === activeProjectId;
              return (
                <HistoryItem
                  key={project.id}
                  active={active}
                  busy={busyProjectId === project.id}
                  isRenaming={renamingProjectId === project.id}
                  name={project.name}
                  updatedAt={project.updated_at}
                  icon={<FolderIcon />}
                  onClick={() => void openProject(project.id)}
                  menuOpen={openMenuProjectId === project.id}
                  onMenuToggle={() => setOpenMenuProjectId((current) => current === project.id ? null : project.id)}
                  onRename={() => handleStartRenameProject(project.id)}
                  onRenameSubmit={(name) => void handleRenameProject(project.id, name)}
                  onRenameCancel={() => setRenamingProjectId(null)}
                  onDelete={() => void handleDeleteProject(project.id, project.name)}
                />
              );
            })
          )}
        </section>

        <section className="space-y-1">
          <SectionHeader
            title="Checker"
            onTitleClick={() => void handleNewCheck()}
            onCreate={() => void handleNewCheck()}
            createTitle={creatingCheck ? "Creating check" : "New check"}
          />
          <div className="space-y-1">
            {filteredProjects.checkHistory.map((project) => {
                const active = appMode === "check" && project.id === activeProjectId;
                return (
                  <HistoryItem
                    key={project.id}
                    active={active}
                    busy={busyProjectId === project.id}
                    isRenaming={renamingProjectId === project.id}
                    name={project.name}
                    updatedAt={project.updated_at}
                    onClick={() => void openCheckHistory(project.id)}
                    menuOpen={openMenuProjectId === project.id}
                    onMenuToggle={() => setOpenMenuProjectId((current) => current === project.id ? null : project.id)}
                    onRename={() => handleStartRenameProject(project.id)}
                    onRenameSubmit={(name) => void handleRenameProject(project.id, name)}
                    onRenameCancel={() => setRenamingProjectId(null)}
                    onDelete={() => void handleDeleteProject(project.id, project.name)}
                  />
                );
              })}
          </div>
        </section>
      </nav>

      <div className="mt-3 border-t border-zinc-800 pt-3">
        <span
          className="cp-status-pill w-full justify-center"
          data-ready={llmConfigured ? "true" : "false"}
          title={llmConfigured ? "Gateway đã cấu hình" : "Chưa cấu hình gateway — chỉ chạy rules"}
        >
          <span className={`cp-button-dot ${llmConfigured ? "" : "bg-zinc-500 shadow-none"}`} />
          {llmConfigured ? "AI agent ready" : "Rules only"}
        </span>
      </div>
    </aside>
  );
}
