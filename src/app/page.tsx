"use client";

import { useEffect, useState } from "react";
import { useCypher } from "@/state/store";
import { Transport } from "@/components/Transport";
import { Timeline } from "@/components/Timeline";
import { TrackRow } from "@/components/TrackRow";
import { MainMenu } from "@/components/MainMenu";
import { RecordingShield } from "@/components/RecordingShield";

export default function Home() {
  const tracks = useCypher((s) => s.tracks);
  const projectName = useCypher((s) => s.currentProjectName);
  const initProject = useCypher((s) => s.initProject);
  const addTrack = useCypher((s) => s.addTrack);

  const [splashDone, setSplashDone] = useState(false);

  useEffect(() => {
    initProject();
    const t = setTimeout(() => setSplashDone(true), 2500);
    return () => clearTimeout(t);
  }, [initProject]);

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
      <header className="px-3 sm:px-4 pt-[max(env(safe-area-inset-top),0.75rem)] pb-2 shrink-0 flex items-center gap-2">
        <div className="flex items-baseline gap-2 min-w-0 flex-1">
          <h1 className="font-[family-name:var(--font-bebas)] text-2xl tracking-[0.14em] leading-none bg-gradient-to-b from-white to-[#9bb6e6] bg-clip-text text-transparent">
            CYPHER
          </h1>
          <span aria-hidden="true" className="text-[var(--text-faint)]">/</span>
          <p className="text-sm text-[var(--text-muted)] truncate min-w-0">
            {projectName}
          </p>
        </div>
        <MainMenu />
      </header>
      <Transport />
      <Timeline />
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
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
      <RecordingShield />
    </main>
  );
}
