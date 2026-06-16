"use client";

import { useEffect, useState } from "react";
import { useQAStore } from "@/lib/store";
import ReportDownloadButton from "@/components/ReportDownloadButton";

type ThemeMode = "dark" | "light";

export default function TopBar() {
  const workspaceName = useQAStore((s) => s.workspaceName);
  const llmConfigured = useQAStore((s) => s.llmConfigured);
  const resetSpace = useQAStore((s) => s.resetSpace);
  const [resetting, setResetting] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>("light");

  useEffect(() => {
    const saved = window.localStorage.getItem("typolice-theme");
    const initial: ThemeMode = saved === "dark" ? "dark" : "light";
    setTheme(initial);
    document.documentElement.dataset.theme = initial;
  }, []);

  const toggleTheme = () => {
    setTheme((current) => {
      const next: ThemeMode = current === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      window.localStorage.setItem("typolice-theme", next);
      return next;
    });
  };

  const handleReset = async () => {
    const ok = window.confirm("Reset space hiện tại? Caption, assets, artboards, issues và agent trace sẽ được xoá. Brand Kit/guidelines vẫn được giữ lại.");
    if (!ok) return;
    setResetting(true);
    try {
      await resetSpace();
    } catch {
      window.alert("Reset space chưa thành công. Hãy thử lại.");
    } finally {
      setResetting(false);
    }
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-950 px-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="cp-brand-lockup min-w-0 shrink-0" aria-label="Typolice">
          <span className="cp-brand-mark grid shrink-0 place-items-center" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] fill-none stroke-current stroke-[1.65]">
              <path
                d="m12 2.4 2.2 4.1 4.6.7-3.2 3.4.7 4.6-4.3-2-4.3 2 .7-4.6-3.2-3.4 4.6-.7L12 2.4Z"
                strokeLinejoin="round"
              />
              <circle cx="12" cy="9.6" r="2.05" />
              <path d="M8.35 18.8h7.3M9.55 16.65h4.9" strokeLinecap="round" />
            </svg>
          </span>
          <h1 className="truncate text-sm font-semibold tracking-tight text-current">Typolice</h1>
        </div>
        <span className="hidden min-w-0 truncate text-xs text-zinc-500 sm:inline">{workspaceName}</span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <span
          className="cp-status-pill"
          data-ready={llmConfigured ? "true" : "false"}
          title={
            llmConfigured
              ? "Gateway đã cấu hình — QA dùng rules + LLM"
              : "Chưa cấu hình AI_GATEWAY_* — chỉ chạy rule-based checks"
          }
        >
          <span className={`cp-button-dot ${llmConfigured ? "" : "bg-zinc-500 shadow-none"}`} />
          {llmConfigured ? "AI agent ready" : "Rules only"}
        </span>

        <button
          type="button"
          onClick={toggleTheme}
          aria-pressed={theme === "light"}
          className="cp-button cp-button-secondary cp-button-sm"
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {theme === "dark" ? (
            <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.6]">
              <circle cx="8" cy="8" r="2.8" />
              <path d="M8 1.8v1.3M8 12.9v1.3M3.6 3.6l.9.9M11.5 11.5l.9.9M1.8 8h1.3M12.9 8h1.3M3.6 12.4l.9-.9M11.5 4.5l.9-.9" strokeLinecap="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.6]">
              <path d="M12.7 10.2A5.5 5.5 0 0 1 5.8 3.3 5.7 5.7 0 1 0 12.7 10.2Z" strokeLinejoin="round" />
            </svg>
          )}
          {theme === "dark" ? "Light" : "Dark"}
        </button>

        <button
          type="button"
          onClick={() => void handleReset()}
          disabled={resetting}
          className="cp-button cp-button-secondary cp-button-sm"
          title="Reset caption, assets, artboards, issues và agent trace"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" className={`h-3.5 w-3.5 fill-none stroke-current stroke-[1.6] ${resetting ? "animate-spin" : ""}`}>
            <path d="M12.7 5.1A5.1 5.1 0 1 0 13 8" strokeLinecap="round" />
            <path d="M12.9 2.8v2.5h-2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {resetting ? "Resetting" : "Reset"}
        </button>

        <ReportDownloadButton
          format="pdf"
          filename="monthly-content-qc-report.pdf"
          className="cp-button cp-button-secondary cp-button-sm"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.6]">
            <path d="M8 2.6v7.4M5.1 7.1 8 10l2.9-2.9" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M3 10.8v1.7c0 .5.4.9.9.9h8.2c.5 0 .9-.4.9-.9v-1.7" strokeLinecap="round" />
          </svg>
          Export
        </ReportDownloadButton>
      </div>
    </header>
  );
}
