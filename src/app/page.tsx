"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { useCypher } from "@/state/store";
import { Transport } from "@/components/Transport";
import { Timeline } from "@/components/Timeline";
import { TrackRow } from "@/components/TrackRow";
import { SamplerRow } from "@/components/SamplerRow";
import { MainMenu } from "@/components/MainMenu";
import { RecordingShield } from "@/components/RecordingShield";
import { MixerView } from "@/components/MixerView";
import { AddTrackButton } from "@/components/AddTrackButton";
import { SongEditor } from "@/components/SongEditor";

type ViewMode = "track" | "mixer";

export default function Home() {
  const tracks = useCypher((s) => s.tracks);
  const projectName = useCypher((s) => s.currentProjectName);
  const isLoaded = useCypher((s) => s.isLoaded);
  const initProject = useCypher((s) => s.initProject);
  const createProject = useCypher((s) => s.createProject);
  const startDemo = useCypher((s) => s.startDemo);
  const reorderTracks = useCypher((s) => s.reorderTracks);

  const [splashDone, setSplashDone] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("track");
  const [showResume, setShowResume] = useState(false);
  const [showSongEditor, setShowSongEditor] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [draggingTrack, setDraggingTrack] = useState<(typeof tracks)[number] | null>(null);
  const [insertBefore, setInsertBefore] = useState<number | null>(null);
  // Guard so the dialog only fires once per page load.
  const resumeChecked = useRef(false);
  const insertBeforeRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const ghostOffsetY = useRef(0);
  const ghostRectRef = useRef<{ left: number; top: number; width: number } | null>(null);

  function handleDragStart(trackId: string, pointerX: number, pointerY: number) {
    const fromIdx = tracks.findIndex((t) => t.id === trackId);
    if (fromIdx === -1) return;

    const cardEl = containerRef.current?.querySelector<HTMLElement>(
      `[data-track-id="${trackId}"]`,
    );
    const rect = cardEl?.getBoundingClientRect();
    if (rect) {
      ghostRectRef.current = { left: rect.left, top: rect.top, width: rect.width };
      ghostOffsetY.current = pointerY - rect.top;
    }

    setDraggingId(trackId);
    setDraggingTrack(tracks[fromIdx]);
    insertBeforeRef.current = null;

    const onMove = (ev: PointerEvent) => {
      // Direct DOM update — bypasses React for butter-smooth 60fps ghost movement.
      if (ghostRef.current && ghostRectRef.current) {
        const dy = ev.clientY - ghostOffsetY.current - ghostRectRef.current.top;
        ghostRef.current.style.transform = `translateY(${dy}px) scale(1.025)`;
      }

      const container = containerRef.current;
      if (!container) return;
      const cards = Array.from(
        container.querySelectorAll<HTMLElement>("[data-track-id]"),
      );
      let newInsertBefore = cards.length;
      for (let i = 0; i < cards.length; i++) {
        const r = cards[i].getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) {
          newInsertBefore = i;
          break;
        }
      }
      if (newInsertBefore !== insertBeforeRef.current) {
        insertBeforeRef.current = newInsertBefore;
        setInsertBefore(newInsertBefore);
      }
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      const ib = insertBeforeRef.current;
      if (ib !== null && ib !== fromIdx && ib !== fromIdx + 1) {
        reorderTracks(fromIdx, ib > fromIdx ? ib - 1 : ib);
      }
      setDraggingId(null);
      setDraggingTrack(null);
      setInsertBefore(null);
      insertBeforeRef.current = null;
      ghostRectRef.current = null;
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  }

  useEffect(() => {
    initProject();
    const t = setTimeout(() => setSplashDone(true), 2500);
    return () => clearTimeout(t);
  }, [initProject]);

  // After the splash clears and the project is loaded, show the resume dialog
  // if there is an existing session with tracks.
  useEffect(() => {
    if (!splashDone || !isLoaded || resumeChecked.current) return;
    resumeChecked.current = true;
    if (tracks.length > 0) setShowResume(true);
  }, [splashDone, isLoaded, tracks.length]);

  // Persist view choice locally so it survives reloads.
  useEffect(() => {
    const saved = localStorage.getItem("cypher.viewMode");
    if (saved === "mixer" || saved === "track") setViewMode(saved);
  }, []);
  useEffect(() => {
    localStorage.setItem("cypher.viewMode", viewMode);
  }, [viewMode]);

  if (!splashDone) {
    const letters = "CYPHER".split("");
    return (
      <main className="flex-1 flex items-center justify-center text-[var(--text-primary)] overflow-hidden">
        <h1
          aria-label="CYPHER"
          className="font-[family-name:var(--font-bebas)] text-6xl sm:text-7xl tracking-[0.12em] leading-none flex cypher-splash"
        >
          {letters.map((ch, i) => (
            <span
              key={i}
              className="cypher-letter inline-block"
              style={{ animationDelay: `${i * 70}ms` }}
            >
              {ch}
            </span>
          ))}
        </h1>
        <style jsx>{`
          .cypher-splash {
            animation: cypher-exit 700ms cubic-bezier(0.4, 0, 0.2, 1) 1800ms forwards;
          }
          .cypher-letter {
            opacity: 0;
            transform: translateY(12px);
            filter: blur(8px);
            animation: cypher-in 900ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
          }
          @keyframes cypher-in {
            to {
              opacity: 1;
              transform: translateY(0);
              filter: blur(0);
            }
          }
          @keyframes cypher-exit {
            to {
              opacity: 0;
              transform: scale(1.08);
              filter: blur(6px);
            }
          }
        `}</style>
      </main>
    );
  }

  return (
    <main className="flex-1 flex flex-col text-[var(--text-primary)] overflow-hidden">
      {showResume && (
        <ResumeDialog
          projectName={projectName}
          trackCount={tracks.length}
          onResume={() => setShowResume(false)}
          onNew={async () => {
            setShowResume(false);
            await createProject();
          }}
        />
      )}
      <div className="sticky top-0 z-20 px-2 sm:px-3 pt-[max(env(safe-area-inset-top),0.5rem)] pb-2 bg-gradient-to-b from-[var(--bg-base)] via-[var(--bg-base)]/85 to-transparent">
        <div className="flex items-center justify-between px-1 pt-3 pb-2">
          <h1 className="font-[family-name:var(--font-bebas)] text-[2.25rem] sm:text-[2.4rem] tracking-[0.18em] leading-none bg-gradient-to-b from-white to-[#9bb6e6] bg-clip-text text-transparent">
            CYPHER
          </h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={demoLoading}
              onClick={async () => {
                setDemoLoading(true);
                try { await startDemo(); } finally { setDemoLoading(false); }
              }}
              className="h-9 px-3 rounded-md glass border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)] text-[10px] uppercase tracking-[0.16em] font-semibold active:scale-95 transition-colors disabled:opacity-50 disabled:pointer-events-none"
            >
              {demoLoading ? "Loading…" : "Start Demo"}
            </button>
            <MainMenu />
          </div>
        </div>
        <div className="glass-raised rounded-2xl overflow-hidden">
          <header className="px-3 sm:px-4 pt-2 pb-2 flex items-center gap-2">
            <div className="flex items-baseline gap-1.5 min-w-0 flex-1">
              <span aria-hidden="true" className="text-[var(--text-faint)] text-[13px] leading-none">/</span>
              <p className="text-[13px] text-[var(--text-muted)] truncate min-w-0 leading-none">
                {projectName}
              </p>
            </div>
            <ViewToggle mode={viewMode} onChange={setViewMode} />
          </header>
          <Transport />
          <Timeline onOpenSongEditor={() => setShowSongEditor(true)} />
        </div>
      </div>
      {viewMode === "track" ? (
        <div
          ref={containerRef}
          className="flex-1 overflow-y-auto px-3 pt-2 pb-[max(env(safe-area-inset-bottom),0.75rem)] flex flex-col gap-1.5"
        >
          {tracks.map((t, i) => (
            <Fragment key={t.id}>
              {/* Insertion indicator — always rendered when dragging, fades in/out */}
              {draggingId && (
                <div
                  className={`h-0.5 rounded-full mx-2 shrink-0 transition-all duration-150 ${
                    insertBefore === i
                      ? "bg-[var(--accent)] opacity-100 scale-x-100"
                      : "opacity-0 scale-x-75"
                  }`}
                />
              )}
              <div
                className={`shrink-0 transition-opacity duration-150 ${
                  draggingId === t.id ? "opacity-0 pointer-events-none" : ""
                }`}
              >
                {t.kind === "sampler" ? (
                  <SamplerRow track={t} onDragStart={handleDragStart} />
                ) : (
                  <TrackRow track={t} onDragStart={handleDragStart} />
                )}
              </div>
            </Fragment>
          ))}
          {draggingId && (
            <div
              className={`h-0.5 rounded-full mx-2 shrink-0 transition-all duration-150 ${
                insertBefore === tracks.length
                  ? "bg-[var(--accent)] opacity-100 scale-x-100"
                  : "opacity-0 scale-x-75"
              }`}
            />
          )}
          <AddTrackButton variant="wide" />
        </div>
      ) : (
        <MixerView />
      )}
      <RecordingShield />
      {showSongEditor && (
        <SongEditor onClose={() => setShowSongEditor(false)} />
      )}

      {/* Drag ghost — fixed overlay, updated via direct DOM for 60fps smoothness */}
      {draggingTrack && ghostRectRef.current && (
        <div
          ref={ghostRef}
          className="fixed pointer-events-none z-[300]"
          style={{
            left: ghostRectRef.current.left,
            top: ghostRectRef.current.top,
            width: ghostRectRef.current.width,
            transform: "scale(1.025)",
            transformOrigin: "center top",
            willChange: "transform",
          }}
        >
          <article className="glass-raised rounded-xl border border-[var(--border-strong)] shadow-[0_28px_64px_-12px_rgba(0,0,0,0.8),0_0_0_1px_rgba(96,165,250,0.18)]">
            <div className="flex items-center gap-2 px-3 py-2.5">
              <svg
                width="10"
                height="14"
                viewBox="0 0 10 14"
                fill="rgba(96,165,250,0.55)"
                aria-hidden="true"
                className="shrink-0"
              >
                <circle cx="3" cy="2.5" r="1.2" />
                <circle cx="7" cy="2.5" r="1.2" />
                <circle cx="3" cy="7" r="1.2" />
                <circle cx="7" cy="7" r="1.2" />
                <circle cx="3" cy="11.5" r="1.2" />
                <circle cx="7" cy="11.5" r="1.2" />
              </svg>
              <span className="font-[family-name:var(--font-bebas)] tracking-[0.08em] text-sm text-[var(--text-primary)] truncate">
                {draggingTrack.name}
              </span>
              <span className="text-[10px] text-[var(--text-faint)] truncate">
                {draggingTrack.kind === "sampler"
                  ? "sampler"
                  : (draggingTrack as { fileName?: string }).fileName ?? "audio"}
              </span>
            </div>
          </article>
        </div>
      )}
    </main>
  );
}

function ResumeDialog({
  projectName,
  trackCount,
  onResume,
  onNew,
}: {
  projectName: string;
  trackCount: number;
  onResume: () => void;
  onNew: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-5">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onResume}
      />
      {/* Card */}
      <div className="relative glass-raised rounded-2xl px-6 py-6 w-full max-w-xs flex flex-col items-center gap-4 shadow-2xl animate-[fade-up_220ms_cubic-bezier(0.22,1,0.36,1)_both]">
        <h1 className="font-[family-name:var(--font-bebas)] text-4xl tracking-[0.18em] leading-none bg-gradient-to-b from-white to-[#9bb6e6] bg-clip-text text-transparent">
          CYPHER
        </h1>
        <div className="text-center space-y-1">
          <p className="text-[var(--text-primary)] text-sm font-semibold">
            Welcome back
          </p>
          <p className="text-[var(--text-faint)] text-xs truncate max-w-full">
            {projectName} · {trackCount} {trackCount === 1 ? "track" : "tracks"}
          </p>
        </div>
        <div className="flex flex-col gap-2 w-full">
          <button
            onClick={onResume}
            className="w-full h-10 rounded-xl bg-[var(--accent)] text-[#031024] text-sm font-bold tracking-wide active:scale-95 transition-transform"
          >
            Resume Session
          </button>
          <button
            onClick={onNew}
            className="w-full h-10 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)] text-sm font-medium active:scale-95 transition-colors"
          >
            Start New
          </button>
        </div>
      </div>
    </div>
  );
}

function ViewToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
}) {
  const next: ViewMode = mode === "track" ? "mixer" : "track";
  return (
    <button
      type="button"
      onClick={() => onChange(next)}
      aria-label={`Switch to ${next} view`}
      title={`Switch to ${next} view`}
      className="h-9 px-2.5 rounded-md bg-white/[0.05] hover:bg-white/[0.09] border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1.5 active:scale-95 transition-colors shrink-0"
    >
      {mode === "track" ? (
        // Mixer icon: three vertical bars (channel strips)
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M6 4v16M12 4v16M18 4v16" />
          <circle cx="6" cy="9" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="12" cy="14" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="18" cy="7" r="1.6" fill="currentColor" stroke="none" />
        </svg>
      ) : (
        // Track icon: horizontal stacked rows
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      )}
      <span className="text-[10px] uppercase tracking-[0.16em] font-semibold">
        {mode === "track" ? "Mixer" : "Tracks"}
      </span>
    </button>
  );
}
