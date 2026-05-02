"use client";

import { useState } from "react";
import { useCypher } from "@/state/store";

export function ExportMenu() {
  const { exportMix, exportProgress } = useCypher();
  const [open, setOpen] = useState(false);
  const busy = exportProgress !== null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="h-9 px-4 rounded-md bg-[var(--accent)] text-black text-sm font-semibold active:scale-95 disabled:bg-neutral-700 disabled:text-neutral-500"
      >
        {busy ? `${Math.round((exportProgress ?? 0) * 100)}%` : "Export"}
      </button>
      {open && !busy && (
        <div className="absolute right-0 top-full mt-1 z-20 bg-neutral-900 border border-neutral-700 rounded-md shadow-xl overflow-hidden">
          <button
            className="block w-full text-left px-4 py-2 text-sm text-neutral-100 hover:bg-neutral-800"
            onClick={async () => {
              setOpen(false);
              await exportMix("wav");
            }}
          >
            WAV (16-bit)
          </button>
          <button
            className="block w-full text-left px-4 py-2 text-sm text-neutral-100 hover:bg-neutral-800"
            onClick={async () => {
              setOpen(false);
              await exportMix("mp3");
            }}
          >
            MP3 (192 kbps)
          </button>
        </div>
      )}
    </div>
  );
}
