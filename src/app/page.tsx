"use client";

import { useEffect, useState } from "react";
import { useQAStore } from "@/lib/store";
import AppSidebar from "@/components/AppSidebar";
import BasicCheckMain from "@/components/BasicCheckMain";
import CanvasArea from "@/components/CanvasArea";
import InstructionCenter from "@/components/InstructionCenter";
import MobileWorkspaceShell from "@/components/MobileWorkspaceShell";
import QAPanel from "@/components/QAPanel";

function LoadingScreen() {
  return (
    <div className="flex h-screen items-center justify-center bg-zinc-950 text-zinc-100">
      <div className="flex flex-col items-center gap-3">
        <div className="cp-brand-lockup cp-loading-brand" aria-label="Typolice">
          <span className="cp-brand-mark grid shrink-0 place-items-center" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="h-[22px] w-[22px] fill-none stroke-current stroke-[1.65]">
              <path
                d="m12 2.4 2.2 4.1 4.6.7-3.2 3.4.7 4.6-4.3-2-4.3 2 .7-4.6-3.2-3.4 4.6-.7L12 2.4Z"
                strokeLinejoin="round"
              />
              <circle cx="12" cy="9.6" r="2.05" />
              <path d="M8.35 18.8h7.3M9.55 16.65h4.9" strokeLinecap="round" />
            </svg>
          </span>
          <h1 className="truncate text-base font-semibold tracking-tight text-current">Typolice</h1>
        </div>
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-500">
          <span>Loading</span>
          <span className="cp-loading-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </div>
      </div>
    </div>
  );
}

export default function WorkspacePage() {
  const load = useQAStore((s) => s.load);
  const loaded = useQAStore((s) => s.loaded);
  const appMode = useQAStore((s) => s.appMode);
  const [isPhoneViewport, setIsPhoneViewport] = useState<boolean | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const syncViewport = () => setIsPhoneViewport(query.matches);
    syncViewport();
    query.addEventListener("change", syncViewport);
    return () => query.removeEventListener("change", syncViewport);
  }, []);

  if (!loaded || isPhoneViewport === null) {
    return <LoadingScreen />;
  }

  if (isPhoneViewport) {
    return (
      <>
        <MobileWorkspaceShell />
        <InstructionCenter />
      </>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-950 text-zinc-100">
      <AppSidebar />
      {appMode === "project" ? (
        <div className="flex min-w-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col">
            <CanvasArea />
          </main>
        </div>
      ) : (
        <BasicCheckMain />
      )}
      <QAPanel showBrandKit={appMode === "project"} />
      <InstructionCenter />
    </div>
  );
}
