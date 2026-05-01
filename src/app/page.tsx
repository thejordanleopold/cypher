"use client";

import { useEffect } from "react";
import { useCypher } from "@/state/store";
import { Transport } from "@/components/Transport";
import { Timeline } from "@/components/Timeline";
import { TrackRow } from "@/components/TrackRow";
import { MainMenu } from "@/components/MainMenu";

export default function Home() {
  const tracks = useCypher((s) => s.tracks);
  const isLoaded = useCypher((s) => s.isLoaded);
  const projectName = useCypher((s) => s.currentProjectName);
  const initProject = useCypher((s) => s.initProject);
  const addTrack = useCypher((s) => s.addTrack);

  useEffect(() => {
    initProject();
  }, [initProject]);

  return (
    <main className="flex-1 flex flex-col bg-neutral-950 text-neutral-100 min-h-[100dvh]">
      <header className="px-3 sm:px-4 pt-[max(env(safe-area-inset-top),0.75rem)] pb-2 shrink-0 flex items-center gap-2">
        <div className="flex items-baseline gap-2 min-w-0 flex-1">
          <h1 className="font-[family-name:var(--font-bebas)] text-2xl tracking-[0.08em] leading-none">
            CYPHER
          </h1>
          <span aria-hidden="true" className="text-neutral-700">/</span>
          <p className="text-sm text-neutral-400 truncate min-w-0">
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
        {tracks.length === 0 && !isLoaded && (
          <div className="p-8 text-center text-neutral-500 text-sm">
            Loading project…
          </div>
        )}
        {isLoaded && (
          <button
            onClick={() => addTrack()}
            className="block w-full rounded-lg border border-neutral-800 bg-neutral-900/40 hover:bg-neutral-900 hover:border-neutral-700 text-neutral-400 hover:text-neutral-100 px-4 py-2.5 text-sm font-medium active:scale-[0.99] transition-colors flex items-center justify-center gap-2"
            aria-label="Add new track"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            {tracks.length === 0 ? "Add your first track" : "Add track"}
          </button>
        )}
      </div>
    </main>
  );
}
