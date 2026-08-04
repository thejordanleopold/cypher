"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
  const loadError = useCypher((s) => s.loadError);
  const initProject = useCypher((s) => s.initProject);
  const createProject = useCypher((s) => s.createProject);
  const startDemo = useCypher((s) => s.startDemo);
  const isDemoMode = useCypher((s) => s.isDemoMode);
  const isApplyingHistory = useCypher((s) => s.isApplyingHistory);
  const reorderTracks = useCypher((s) => s.reorderTracks);

  const [splashDone, setSplashDone] = useState(false);
  const [viewMode, setViewMode] = useStoredViewMode();
  const [showResume, setShowResume] = useState(false);
  const [showSongEditor, setShowSongEditor] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [draggingTrack, setDraggingTrack] = useState<(typeof tracks)[number] | null>(null);
  const [insertBefore, setInsertBefore] = useState<number | null>(null);
  const insertBeforeRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const ghostOffsetY = useRef(0);
  const [ghostRect, setGhostRect] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);
  const closeSongEditor = useCallback(() => setShowSongEditor(false), []);

  const handleDragStart = useCallback((
    trackId: string,
    _pointerX: number,
    pointerY: number,
  ) => {
    const currentTracks = useCypher.getState().tracks;
    const fromIdx = currentTracks.findIndex((track) => track.id === trackId);
    if (fromIdx === -1) return;

    const cardEl = containerRef.current?.querySelector<HTMLElement>(
      `[data-track-id="${trackId}"]`,
    );
    const rect = cardEl?.getBoundingClientRect();
    if (rect) {
      setGhostRect({ left: rect.left, top: rect.top, width: rect.width });
      ghostOffsetY.current = pointerY - rect.top;
    }

    setDraggingId(trackId);
    setDraggingTrack(currentTracks[fromIdx]);
    insertBeforeRef.current = null;

    const onMove = (ev: PointerEvent) => {
      const container = containerRef.current;
      if (!container) return;
      // Read layout before mutating the drag ghost's style. Keeping DOM reads
      // together avoids a forced style/layout flush on every pointer move.
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

      // Direct DOM update keeps the drag ghost responsive without a React
      // render for every pointer coordinate.
      if (ghostRef.current && rect) {
        const dy = ev.clientY - ghostOffsetY.current - rect.top;
        ghostRef.current.style.transform = `translateY(${dy}px) scale(1.025)`;
      }
    };

    const finishDrag = (commit: boolean) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      const ib = insertBeforeRef.current;
      if (commit && ib !== null && ib !== fromIdx && ib !== fromIdx + 1) {
        reorderTracks(fromIdx, ib > fromIdx ? ib - 1 : ib);
      }
      setDraggingId(null);
      setDraggingTrack(null);
      setInsertBefore(null);
      insertBeforeRef.current = null;
      setGhostRect(null);
    };
    const onUp = () => finishDrag(true);
    const onCancel = () => finishDrag(false);

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
  }, [reorderTracks]);

  const handleMoveTrack = useCallback(
    (trackId: string, direction: -1 | 1) => {
      const currentTracks = useCypher.getState().tracks;
      const fromIdx = currentTracks.findIndex((track) => track.id === trackId);
      const toIdx = fromIdx + direction;
      if (fromIdx < 0 || toIdx < 0 || toIdx >= currentTracks.length) return;
      reorderTracks(fromIdx, toIdx);
    },
    [reorderTracks],
  );

  useEffect(() => {
    let cancelled = false;
    void initProject()
      .then(() => {
        if (!cancelled && useCypher.getState().tracks.length > 0) {
          setShowResume(true);
        }
      })
      .catch(() => {
        // The store exposes the actionable failure through loadError.
      });
    const t = setTimeout(() => setSplashDone(true), 2500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [initProject]);

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

  if (!isLoaded) {
    return (
      <ProjectLoadState
        error={loadError}
        onRetry={() => {
          void initProject().catch(() => {
            // The store exposes the actionable failure through loadError.
          });
        }}
      />
    );
  }

  return (
    <main
      inert={isApplyingHistory}
      aria-busy={isApplyingHistory}
      className="flex-1 flex flex-col text-[var(--text-primary)] overflow-hidden"
    >
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
      <div className="sticky top-0 z-20 px-2 sm:px-3 lg:px-6 pt-[max(env(safe-area-inset-top),0.5rem)] lg:pt-4 pb-2 lg:pb-3 bg-gradient-to-b from-[var(--bg-base)] via-[var(--bg-base)]/85 to-transparent">
        <div className="w-full max-w-[1280px] mx-auto flex items-center justify-between px-1 lg:px-2 pt-3 lg:pt-1 pb-2 lg:pb-3">
          <h1 className="font-[family-name:var(--font-bebas)] text-[2.25rem] sm:text-[2.4rem] lg:text-[2.7rem] tracking-[0.18em] leading-none bg-gradient-to-b from-white to-[#9bb6e6] bg-clip-text text-transparent">
            CYPHER
          </h1>
          <div className="flex items-center gap-2">
            <div className="hidden lg:block">
              <DesktopViewToggle mode={viewMode} onChange={setViewMode} />
            </div>
            <button
              type="button"
              disabled={demoLoading}
              onClick={async () => {
                if (isDemoMode) {
                  await createProject();
                } else {
                  setDemoLoading(true);
                  try { await startDemo(); } finally { setDemoLoading(false); }
                }
              }}
              className="h-9 lg:h-10 px-3 lg:px-4 rounded-md glass border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)] text-[10px] uppercase tracking-[0.16em] font-semibold active:scale-95 transition-colors disabled:opacity-50 disabled:pointer-events-none"
            >
              {demoLoading ? "Loading…" : isDemoMode ? "Exit Demo" : "Start Demo"}
            </button>
            <MainMenu />
          </div>
        </div>
        <div className="w-full max-w-[1280px] mx-auto glass-raised rounded-2xl lg:rounded-[1.25rem] overflow-hidden">
          <header className="px-3 sm:px-4 lg:px-5 pt-2 lg:pt-3 pb-2 flex items-center gap-2">
            <div className="flex items-baseline gap-1.5 min-w-0 flex-1">
              <span aria-hidden="true" className="text-[var(--text-faint)] text-[13px] leading-none">/</span>
              <p className="text-[13px] text-[var(--text-muted)] truncate min-w-0 leading-none">
                {projectName}
              </p>
              <span className="hidden lg:inline text-[10px] uppercase tracking-[0.16em] text-[var(--text-faint)] leading-none">
                {tracks.length} {tracks.length === 1 ? "track" : "tracks"}
              </span>
            </div>
            <div className="lg:hidden">
              <ViewToggle mode={viewMode} onChange={setViewMode} />
            </div>
          </header>
          <Transport />
          <Timeline onOpenSongEditor={() => setShowSongEditor(true)} />
        </div>
      </div>
      {viewMode === "track" ? (
        <div
          ref={containerRef}
          className="desktop-workspace-scroll flex-1 overflow-y-auto px-3 lg:px-6 pt-2 lg:pt-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] lg:pb-6 flex flex-col items-center gap-1.5 lg:gap-2.5"
        >
          <div className="hidden lg:flex w-full max-w-[1280px] items-center justify-between px-1 pb-1">
            <div>
              <h2 className="font-[family-name:var(--font-bebas)] text-lg tracking-[0.14em] text-[var(--text-primary)] leading-none">
                Arrangement
              </h2>
              <p className="mt-1 text-[11px] text-[var(--text-faint)]">
                Record, layer, and shape your session
              </p>
            </div>
            <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-faint)]">
              {tracks.length} {tracks.length === 1 ? "channel" : "channels"}
            </span>
          </div>
          {tracks.map((t, i) => (
            <Fragment key={t.id}>
              {/* Insertion indicator — always rendered when dragging, fades in/out */}
              {draggingId && (
                <div
                  className={`w-full max-w-[1280px] h-0.5 rounded-full mx-2 shrink-0 transition-[opacity,transform,background-color] duration-150 ${
                    insertBefore === i
                      ? "bg-[var(--accent)] opacity-100 scale-x-100"
                      : "opacity-0 scale-x-75"
                  }`}
                />
              )}
              <div
                className={`w-full max-w-[1280px] shrink-0 transition-opacity duration-150 ${
                  draggingId === t.id ? "opacity-0 pointer-events-none" : ""
                }`}
              >
                {t.kind === "sampler" ? (
                  <SamplerRow
                    track={t}
                    onDragStart={handleDragStart}
                    onMove={handleMoveTrack}
                  />
                ) : (
                  <TrackRow
                    track={t}
                    onDragStart={handleDragStart}
                    onMove={handleMoveTrack}
                  />
                )}
              </div>
            </Fragment>
          ))}
          {draggingId && (
            <div
              className={`w-full max-w-[1280px] h-0.5 rounded-full mx-2 shrink-0 transition-[opacity,transform,background-color] duration-150 ${
                insertBefore === tracks.length
                  ? "bg-[var(--accent)] opacity-100 scale-x-100"
                  : "opacity-0 scale-x-75"
              }`}
            />
          )}
          <div className="w-full max-w-[1280px]">
            <AddTrackButton variant="wide" />
          </div>
        </div>
      ) : (
        <MixerView />
      )}
      <RecordingShield />
      {showSongEditor && (
        <SongEditor onClose={closeSongEditor} />
      )}

      {/* Drag ghost — fixed overlay, updated via direct DOM for 60fps smoothness */}
      {draggingTrack && ghostRect && (
        <div
          ref={ghostRef}
          className="fixed pointer-events-none z-[300]"
          style={{
            left: ghostRect.left,
            top: ghostRect.top,
            width: ghostRect.width,
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

const VIEW_MODE_KEY = "cypher.viewMode";
const VIEW_MODE_EVENT = "cypher:view-mode-change";

function readViewMode(): ViewMode {
  if (typeof window === "undefined") return "track";
  return localStorage.getItem(VIEW_MODE_KEY) === "mixer" ? "mixer" : "track";
}

function subscribeViewMode(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(VIEW_MODE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(VIEW_MODE_EVENT, onStoreChange);
  };
}

function useStoredViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const mode = useSyncExternalStore(
    subscribeViewMode,
    readViewMode,
    (): ViewMode => "track",
  );
  const setMode = useCallback((nextMode: ViewMode) => {
    localStorage.setItem(VIEW_MODE_KEY, nextMode);
    window.dispatchEvent(new Event(VIEW_MODE_EVENT));
  }, []);
  return [mode, setMode];
}

function ProjectLoadState({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <main
      className="flex-1 flex items-center justify-center px-6 text-[var(--text-primary)]"
      aria-busy={error ? undefined : true}
    >
      <div className="glass-raised rounded-2xl border border-[var(--border-subtle)] w-full max-w-sm p-6 text-center space-y-4">
        <h1 className="font-[family-name:var(--font-bebas)] text-3xl tracking-[0.16em]">
          {error ? "PROJECT UNAVAILABLE" : "RESTORING PROJECT"}
        </h1>
        {error ? (
          <>
            <p role="alert" className="text-sm text-[var(--text-muted)]">
              {error}
            </p>
            <button
              type="button"
              onClick={onRetry}
              className="h-10 px-5 rounded-xl bg-[var(--accent)] text-[#031024] text-sm font-bold active:scale-95 transition-transform"
            >
              Retry
            </button>
          </>
        ) : (
          <p className="text-sm text-[var(--text-muted)]">
            Loading saved tracks and samples…
          </p>
        )}
      </div>
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const resumeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const changed: Array<{
      node: HTMLElement;
      inert: boolean;
      ariaHidden: string | null;
    }> = [];
    let current: HTMLElement | null = dialog;
    while (current && current !== document.body) {
      const container: HTMLElement | null = current.parentElement;
      if (!container) break;
      for (const sibling of Array.from(container.children)) {
        if (sibling === current || !(sibling instanceof HTMLElement)) continue;
        changed.push({
          node: sibling,
          inert: sibling.inert,
          ariaHidden: sibling.getAttribute("aria-hidden"),
        });
        sibling.inert = true;
        sibling.setAttribute("aria-hidden", "true");
      }
      current = container;
    }
    const frame = requestAnimationFrame(() => resumeButtonRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      for (const { node, inert, ariaHidden } of changed.reverse()) {
        node.inert = inert;
        if (ariaHidden === null) node.removeAttribute("aria-hidden");
        else node.setAttribute("aria-hidden", ariaHidden);
      }
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="resume-title"
      aria-describedby="resume-description"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onResume();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = Array.from(
          dialogRef.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) ?? [],
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      className="fixed inset-0 z-50 flex items-center justify-center px-5"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onResume}
      />
      {/* Card */}
      <div className="relative glass-raised rounded-2xl px-6 py-6 w-full max-w-xs flex flex-col items-center gap-4 shadow-2xl animate-[fade-up_220ms_cubic-bezier(0.22,1,0.36,1)_both]">
        <h1
          id="resume-title"
          className="font-[family-name:var(--font-bebas)] text-4xl tracking-[0.18em] leading-none bg-gradient-to-b from-white to-[#9bb6e6] bg-clip-text text-transparent"
        >
          CYPHER
        </h1>
        <div className="text-center space-y-1">
          <p className="text-[var(--text-primary)] text-sm font-semibold">
            Welcome back
          </p>
          <p
            id="resume-description"
            className="text-[var(--text-faint)] text-xs truncate max-w-full"
          >
            {projectName} · {trackCount} {trackCount === 1 ? "track" : "tracks"}
          </p>
        </div>
        <div className="flex flex-col gap-2 w-full">
          <button
            ref={resumeButtonRef}
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

function DesktopViewToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Workspace view"
      className="glass flex items-center gap-1 rounded-lg p-1"
    >
      {(["track", "mixer"] as const).map((option) => {
        const active = mode === option;
        const label = option === "track" ? "Tracks" : "Mixer";
        return (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            aria-pressed={active}
            className={`h-8 min-w-20 rounded-md px-3 text-[10px] font-semibold uppercase tracking-[0.16em] transition-[background-color,color,box-shadow] active:scale-[0.98] ${
              active
                ? "bg-[var(--accent)] text-[#031024] shadow-[0_4px_14px_-6px_rgba(96,165,250,0.8)]"
                : "text-[var(--text-muted)] hover:bg-white/[0.07] hover:text-[var(--text-primary)]"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
