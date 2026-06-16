"use client";

import { useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "typolice-instructions-v6-done";

interface InstructionSlide {
  eyebrow: string;
  title: string;
  body: string;
  visual: "welcome" | "audit" | "project" | "review" | "export";
}

const SLIDES: InstructionSlide[] = [
  {
    eyebrow: "Step 1",
    title: "Welcome to Typolice",
    body: "Your AI-powered agent for cleaner content and stronger brand compliance. Typolice helps you clean up drafts in just a few clicks.",
    visual: "welcome",
  },
  {
    eyebrow: "Step 2",
    title: "Instant Content Audit",
    body: "Have a single post ready? Paste your raw text into Caption Input or upload graphic assets into Visual Text Scanner. Typolice flags typos, spacing issues, and brand terms in one workflow.",
    visual: "audit",
  },
  {
    eyebrow: "Step 3",
    title: "Discover Project Workspace",
    body: "Managing a full campaign? Create a Project and use the interactive whiteboard to draft text and layout graphics side by side for Facebook and LinkedIn formats.",
    visual: "project",
  },
  {
    eyebrow: "Step 4",
    title: "Review and One-Click Fix",
    body: "Scan issues in the sidebar, accept fixes where available, ignore items that are already correct, or add trusted terms to your guideline.",
    visual: "review",
  },
  {
    eyebrow: "Step 5",
    title: "Download & Track Your Reports",
    body: "Export polished PDF reports or detailed Excel logs for tracking.",
    visual: "export",
  },
];

function PoliceStarIcon({ className = "h-5 w-5" }: { className?: string }) {
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

function InfoIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current stroke-[1.8]" aria-hidden="true">
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 7.2v3.4" strokeLinecap="round" />
      <path d="M8 5.1h.01" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current stroke-[1.7]" aria-hidden="true">
      <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" strokeLinecap="round" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.8]" aria-hidden="true">
      <path d="M3.5 8h8.2M8.6 4.8 11.8 8l-3.2 3.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SlideVisual({ type }: { type: InstructionSlide["visual"] }) {
  if (type === "welcome") {
    return (
      <div className="cp-instruction-visual cp-instruction-visual-welcome">
        <div className="cp-instruction-brand-card">
          <span className="cp-brand-mark grid place-items-center" aria-hidden="true">
            <PoliceStarIcon className="h-6 w-6" />
          </span>
          <span className="text-lg font-semibold tracking-tight">Typolice</span>
        </div>
        <div className="cp-instruction-orbit" />
      </div>
    );
  }

  if (type === "audit") {
    return (
      <div className="cp-instruction-visual">
        <div className="cp-instruction-mock-grid">
          <div className="cp-instruction-mock-card">
            <span>Caption Input</span>
            <div className="mt-3 space-y-2">
              <i />
              <i className="w-9/12" />
              <i className="w-7/12" />
            </div>
          </div>
          <div className="cp-instruction-mock-card">
            <span>Visual Text Scanner</span>
            <div className="cp-instruction-dropzone">
              <span>Upload Images</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (type === "project") {
    return (
      <div className="cp-instruction-visual">
        <div className="cp-instruction-board">
          <div className="cp-instruction-artboard is-facebook">Facebook</div>
          <div className="cp-instruction-artboard is-linkedin">LinkedIn</div>
          <div className="cp-instruction-caption-note">Caption</div>
        </div>
      </div>
    );
  }

  if (type === "review") {
    return (
      <div className="cp-instruction-visual">
        <div className="cp-instruction-review">
          <div className="cp-instruction-issue-card">
            <span className="cp-instruction-severity">HIGH</span>
            <p>Spacing issue</p>
            <div className="cp-instruction-issue-actions">
              <button type="button" className="cp-success-button cp-button-xs">Accept</button>
              <button type="button" className="cp-muted-button cp-button-xs">Ignore</button>
              <button type="button" className="cp-info-button cp-button-xs">+ Dict</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="cp-instruction-visual">
      <div className="cp-instruction-export-stack">
        <div className="cp-instruction-export-card">
          <span>PDF report</span>
          <strong>Monthly QC Summary</strong>
        </div>
        <div className="cp-instruction-export-card">
          <span>Excel log</span>
          <strong>Detailed Review Data</strong>
        </div>
      </div>
    </div>
  );
}

export default function InstructionCenter() {
  const [open, setOpen] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [slideIndex, setSlideIndex] = useState(0);
  const [visited, setVisited] = useState<boolean[]>(() => SLIDES.map((_, index) => index === 0));
  const [showTip, setShowTip] = useState(false);
  const current = SLIDES[slideIndex];
  const canFinish = useMemo(() => visited.every(Boolean), [visited]);
  const locked = !completed;

  useEffect(() => {
    let forcedOpen = false;
    let done = false;
    try {
      const params = new URLSearchParams(window.location.search);
      forcedOpen = params.has("instruction") || params.has("instructions") || params.get("guide") === "1";
      done = !forcedOpen && window.localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      forcedOpen = false;
      done = false;
    }
    setCompleted(done);
    setOpen(forcedOpen || !done);
  }, []);

  useEffect(() => {
    if (!showTip) return;
    const timer = window.setTimeout(() => setShowTip(false), 3200);
    return () => window.clearTimeout(timer);
  }, [showTip]);

  const goToSlide = (index: number) => {
    if (locked && index > slideIndex + 1) return;
    setSlideIndex(index);
    setVisited((items) => items.map((item, itemIndex) => item || itemIndex === index));
  };

  const openGuide = () => {
    setSlideIndex(0);
    setVisited(SLIDES.map((_, index) => index === 0));
    setOpen(true);
    setShowTip(false);
  };

  const finishGuide = () => {
    if (!canFinish) return;
    setCompleted(true);
    try {
      window.localStorage.setItem(STORAGE_KEY, "true");
    } catch {
      // If storage is unavailable, still let the user enter the app for this session.
    }
    setOpen(false);
    setShowTip(true);
  };

  const closeGuide = () => {
    if (locked) return;
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        className="cp-instruction-launcher"
        onClick={openGuide}
        aria-label="Open Typolice instructions"
        title="Open instructions"
      >
        <InfoIcon />
      </button>

      {showTip && (
        <div className="cp-instruction-tip" role="status">
          Need the guide again? Open it here anytime.
        </div>
      )}

      {open && (
        <div className="cp-instruction-layer" role="presentation">
          <div
            className="cp-instruction-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="typolice-instruction-title"
          >
            <header className="cp-instruction-header">
              <div className="cp-instruction-logo">
                <span className="cp-brand-mark grid place-items-center" aria-hidden="true">
                  <PoliceStarIcon className="h-[18px] w-[18px]" />
                </span>
                <span>Typolice</span>
              </div>
              <button
                type="button"
                className="cp-instruction-close"
                onClick={closeGuide}
                disabled={locked}
                title={locked ? "Read all steps and press Done first" : "Close instructions"}
                aria-label="Close instructions"
              >
                <CloseIcon />
              </button>
            </header>

            <div className="cp-instruction-content">
              <SlideVisual type={current.visual} />
              <section className="cp-instruction-copy">
                <span className="cp-instruction-eyebrow">{current.eyebrow}</span>
                <h2 id="typolice-instruction-title">{current.title}</h2>
                <p>{current.body}</p>
              </section>
            </div>

            <footer className="cp-instruction-footer">
              <div className="cp-instruction-dots" aria-label="Instruction progress">
                {SLIDES.map((slide, index) => (
                  <button
                    key={slide.title}
                    type="button"
                    onClick={() => goToSlide(index)}
                    disabled={locked && index > slideIndex + 1}
                    aria-label={`Go to instruction ${index + 1}`}
                    aria-current={index === slideIndex}
                  />
                ))}
              </div>

              <div className="cp-instruction-actions">
                {slideIndex > 0 && (
                  <button type="button" className="cp-button cp-button-secondary cp-button-sm" onClick={() => goToSlide(slideIndex - 1)}>
                    Back
                  </button>
                )}
                {slideIndex < SLIDES.length - 1 ? (
                  <button type="button" className="cp-button cp-button-sm" onClick={() => goToSlide(slideIndex + 1)}>
                    Next
                    <ArrowIcon />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="cp-button cp-button-sm"
                    onClick={finishGuide}
                    disabled={!canFinish}
                    title={!canFinish ? "Read every instruction first" : "Start using Typolice"}
                  >
                    Done
                  </button>
                )}
              </div>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
