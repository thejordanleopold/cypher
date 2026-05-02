"use client";

import { useEffect, useState } from "react";
import { useCypher } from "@/state/store";
import { Transport } from "@/components/Transport";
import { Timeline } from "@/components/Timeline";
import { TrackRow } from "@/components/TrackRow";
import { MainMenu } from "@/components/MainMenu";
import { RecordingShield } from "@/components/RecordingShield";
import { MixerView } from "@/components/MixerView";

type ViewMode = "track" | "mixer";

export default function Home() {
  const tracks = useCypher((s) => s.tracks);
  const projectName = useCypher((s) => s.currentProjectName);
  const initProject = useCypher((s) => s.initProject);
  const addTrack = useCypher((s) => s.addTrack);

  const [splashDone, setSplashDone] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("track");

  useEffect(() => {
    initProject();
    const t = setTimeout(() => setSplashDone(true), 2500);
    return () => clearTimeout(t);
  }, [initProject]);

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
      <main className="flex-1 flex items-center justify-center text-[var(--text-primary)] min-h-[100dvh] overflow-hidden">
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
    <main className="flex-1 flex flex-col text-[var(--text-primary)] min-h-[100dvh]">
      <div className="sticky top-0 z-20 px-2 sm:px-3 pt-[max(env(safe-area-inset-top),0.5rem)] pb-2 bg-gradient-to-b from-[var(--bg-base)] via-[var(--bg-base)]/85 to-transparent">
        <div className="glass-raised rounded-2xl overflow-hidden">
          <header className="px-3 sm:px-4 pt-3 pb-2 flex items-center gap-2">
            <div className="flex items-baseline gap-1.5 min-w-0 flex-1">
              <h1 className="font-[family-name:var(--font-bebas)] text-3xl sm:text-[2rem] tracking-[0.18em] leading-none bg-gradient-to-b from-white to-[#9bb6e6] bg-clip-text text-transparent">
                CYPHER
              </h1>
              <span aria-hidden="true" className="text-[var(--text-faint)] text-[11px] leading-none">/</span>
              <p className="text-[11px] text-[var(--text-muted)] truncate min-w-0 leading-none">
                {projectName}
              </p>
            </div>
            <ViewToggle mode={viewMode} onChange={setViewMode} />
            <MainMenu />
          </header>
          <Transport />
          <Timeline />
        </div>
      </div>
      {viewMode === "track" ? (
        <div className="flex-1 overflow-y-auto px-3 pt-2 space-y-1.5 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
          {tracks.map((t) => (
            <TrackRow key={t.id} track={t} />
          ))}
          <button
            onClick={() => addTrack()}
            className="glass block w-full rounded-xl text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] px-4 py-2.5 text-sm font-medium active:scale-[0.99] transition-colors flex items-center justify-center gap-2"
            aria-label="Add new track"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            {tracks.length === 0 ? "Add your first track" : "Add track"}
          </button>
        </div>
      ) : (
        <MixerView />
      )}
      <RecordingShield />
    </main>
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
