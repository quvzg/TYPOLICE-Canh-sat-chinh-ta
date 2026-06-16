"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQAStore, type AppMode, type ProjectSummary } from "@/lib/store";
import BasicCheckMain from "@/components/BasicCheckMain";
import QAPanel from "@/components/QAPanel";
import ReportDownloadButton from "@/components/ReportDownloadButton";

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

function MenuIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current stroke-[1.7]" aria-hidden="true">
      <path d="M2.8 4.2h10.4M2.8 8h10.4M2.8 11.8h10.4" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current stroke-[1.7]" aria-hidden="true">
      <path d="m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6" strokeLinecap="round" />
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
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.6]">
      <path d="M12.7 10.2A5.5 5.5 0 0 1 5.8 3.3 5.7 5.7 0 1 0 12.7 10.2Z" strokeLinejoin="round" />
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

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current stroke-[1.7]" aria-hidden="true">
      <path d="m3.4 8.2 3.1 3.1 6.1-6.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.6]">
      <path d="M8 2.6v7.4M5.1 7.1 8 10l2.9-2.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 10.8v1.7c0 .5.4.9.9.9h8.2c.5 0 .9-.4.9-.9v-1.7" strokeLinecap="round" />
    </svg>
  );
}

function ResetIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={`h-3.5 w-3.5 fill-none stroke-current stroke-[1.6] ${spinning ? "animate-spin" : ""}`}>
      <path d="M12.7 5.1A5.1 5.1 0 1 0 13 8" strokeLinecap="round" />
      <path d="M12.9 2.8v2.5h-2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function historyLabel(project: ProjectSummary) {
  return new Date(project.updated_at).toLocaleDateString("vi-VN");
}

function projectModeLabel(mode: AppMode) {
  return mode === "project" ? "Project" : "Checker";
}

function MobileHistoryButton({
  active,
  busy,
  icon,
  project,
  onClick,
}: {
  active: boolean;
  busy: boolean;
  icon: ReactNode;
  project: ProjectSummary;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cp-mobile-history-item"
      data-active={active ? "true" : "false"}
    >
      <span className="cp-mobile-history-icon">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-zinc-100">
          {busy ? "Loading..." : project.name}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-zinc-500">
          {historyLabel(project)}
        </span>
      </span>
    </button>
  );
}

export default function MobileWorkspaceShell() {
  const appMode = useQAStore((s) => s.appMode);
  const projects = useQAStore((s) => s.projects);
  const activeProjectId = useQAStore((s) => s.activeProjectId);
  const workspaceName = useQAStore((s) => s.workspaceName);
  const issues = useQAStore((s) => s.issues);
  const llmConfigured = useQAStore((s) => s.llmConfigured);
  const createCheck = useQAStore((s) => s.createCheck);
  const createProject = useQAStore((s) => s.createProject);
  const switchProject = useQAStore((s) => s.switchProject);
  const resetSpace = useQAStore((s) => s.resetSpace);
  const setTab = useQAStore((s) => s.setTab);
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>("light");
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [creatingCheck, setCreatingCheck] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [resetting, setResetting] = useState(false);
  const openCount = issues.filter((issue) => issue.status === "open").length;
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const title = activeProject?.name || workspaceName || "Typolice";
  const projectHistory = useMemo(() => projects.filter((project) => project.kind !== "check"), [projects]);
  const checkHistory = useMemo(() => projects.filter((project) => project.kind === "check"), [projects]);

  useEffect(() => {
    const saved = window.localStorage.getItem("typolice-theme");
    const initial: ThemeMode = saved === "dark" ? "dark" : "light";
    setTheme(initial);
    document.documentElement.dataset.theme = initial;
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  const toggleTheme = () => {
    setTheme((current) => {
      const next: ThemeMode = current === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      window.localStorage.setItem("typolice-theme", next);
      return next;
    });
  };

  const scrollContentTop = () => {
    document.querySelector<HTMLElement>(".cp-mobile-scroll")?.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  };

  const openReview = () => {
    setTab("issues");
    window.requestAnimationFrame(() => {
      document.getElementById("typolice-mobile-review")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  };

  const openHistoryItem = async (projectId: string, mode: AppMode) => {
    setBusyProjectId(projectId);
    try {
      await switchProject(projectId, mode);
      setTab("issues");
      setMenuOpen(false);
      scrollContentTop();
    } finally {
      setBusyProjectId(null);
    }
  };

  const handleNewCheck = async () => {
    if (creatingCheck) return;
    setCreatingCheck(true);
    try {
      await createCheck();
      setTab("issues");
      setMenuOpen(false);
      scrollContentTop();
    } catch {
      window.alert("Cannot create a new check. Please try again.");
    } finally {
      setCreatingCheck(false);
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
      setMenuOpen(false);
      scrollContentTop();
    } catch {
      window.alert("Cannot create a new project. Please try again.");
    } finally {
      setCreatingProject(false);
    }
  };

  const handleReset = async () => {
    const ok = window.confirm("Reset current space? Captions, assets, artboards, issues, and agent trace will be cleared. Brand Kit stays.");
    if (!ok) return;
    setResetting(true);
    try {
      await resetSpace();
      setMenuOpen(false);
    } catch {
      window.alert("Reset did not finish. Please try again.");
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="cp-mobile-shell">
      <header className="cp-mobile-header">
        <button
          type="button"
          className="cp-mobile-icon-button"
          aria-label="Open history"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(true)}
        >
          <MenuIcon />
        </button>

        <div className="min-w-0 flex-1">
          <div className="cp-brand-lockup cp-mobile-brand" aria-label="Typolice">
            <span className="cp-brand-mark grid shrink-0 place-items-center" aria-hidden="true">
              <PoliceStarIcon className="h-[18px] w-[18px]" />
            </span>
            <span className="truncate text-sm font-semibold tracking-tight">Typolice</span>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2">
            <span className="cp-mobile-mode-pill">{projectModeLabel(appMode)}</span>
            <span className="min-w-0 truncate text-[12px] font-medium text-zinc-400">{title}</span>
          </div>
        </div>

        <button
          type="button"
          className="cp-mobile-review-button"
          data-has-issues={openCount > 0 ? "true" : "false"}
          onClick={openReview}
          aria-label="Open issues"
        >
          {openCount > 99 ? "99+" : openCount}
        </button>
      </header>

      <div className="cp-mobile-scroll">
        <BasicCheckMain />
        <section id="typolice-mobile-review" className="cp-mobile-review">
          <QAPanel showBrandKit={appMode === "project"} />
        </section>
      </div>

      {menuOpen && (
        <div className="cp-mobile-menu-layer" role="presentation">
          <button
            type="button"
            className="cp-mobile-menu-scrim"
            aria-label="Close history"
            onClick={() => setMenuOpen(false)}
          />
          <aside className="cp-mobile-drawer" aria-label="Mobile workspace history">
            <div className="cp-mobile-drawer-head">
              <div className="min-w-0">
                <div className="cp-brand-lockup cp-sidebar-brand justify-start" aria-label="Typolice">
                  <span className="cp-brand-mark grid shrink-0 place-items-center" aria-hidden="true">
                    <PoliceStarIcon className="h-[18px] w-[18px]" />
                  </span>
                  <span className="truncate text-sm font-semibold tracking-tight">Typolice</span>
                </div>
              </div>
              <button
                type="button"
                className="cp-mobile-icon-button"
                aria-label="Close history"
                onClick={() => setMenuOpen(false)}
              >
                <CloseIcon />
              </button>
            </div>

            <div className="cp-mobile-actions">
              <button type="button" className="cp-button cp-button-sm" onClick={() => void handleNewCheck()}>
                <CheckIcon />
                {creatingCheck ? "Creating" : "New Check"}
              </button>
              <button type="button" className="cp-button cp-button-secondary cp-button-sm" onClick={() => void handleCreateProject()}>
                <FolderIcon />
                {creatingProject ? "Creating" : "New Project"}
              </button>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <span
                className="cp-status-pill min-w-0 flex-1 justify-center"
                data-ready={llmConfigured ? "true" : "false"}
              >
                <span className={`cp-button-dot ${llmConfigured ? "" : "bg-zinc-500 shadow-none"}`} />
                {llmConfigured ? "AI ready" : "Rules only"}
              </span>
              <button
                type="button"
                onClick={toggleTheme}
                aria-pressed={theme === "light"}
                className="cp-mobile-icon-button"
                title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              >
                {theme === "dark" ? <MoonIcon /> : <SunIcon />}
              </button>
            </div>

            <div className="cp-mobile-history-scroll">
              <section className="space-y-1.5">
                <h2 className="cp-mobile-section-label">Projects</h2>
                {projectHistory.length === 0 ? (
                  <p className="cp-mobile-empty">No projects yet.</p>
                ) : (
                  projectHistory.map((project) => (
                    <MobileHistoryButton
                      key={project.id}
                      active={appMode === "project" && project.id === activeProjectId}
                      busy={busyProjectId === project.id}
                      icon={<FolderIcon />}
                      project={project}
                      onClick={() => void openHistoryItem(project.id, "project")}
                    />
                  ))
                )}
              </section>

              <section className="space-y-1.5">
                <h2 className="cp-mobile-section-label">Checker</h2>
                {checkHistory.length === 0 ? (
                  <p className="cp-mobile-empty">No checks yet.</p>
                ) : (
                  checkHistory.map((project) => (
                    <MobileHistoryButton
                      key={project.id}
                      active={appMode === "check" && project.id === activeProjectId}
                      busy={busyProjectId === project.id}
                      icon={<CheckIcon />}
                      project={project}
                      onClick={() => void openHistoryItem(project.id, "check")}
                    />
                  ))
                )}
              </section>
            </div>

            <div className="cp-mobile-drawer-foot">
              <button
                type="button"
                onClick={() => void handleReset()}
                disabled={resetting}
                className="cp-button cp-button-secondary cp-button-sm"
              >
                <ResetIcon spinning={resetting} />
                Reset
              </button>
              <ReportDownloadButton
                format="pdf"
                filename="monthly-content-qc-report.pdf"
                className="cp-button cp-button-secondary cp-button-sm"
              >
                <DownloadIcon />
                Export PDF
              </ReportDownloadButton>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
