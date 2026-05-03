"use client";

import { useRef, useState } from "react";
import { type TrackState, type SamplerPad } from "@/state/store";
import { getEngine } from "@/audio/engine";

const PAD_COLORS: Array<{ idle: string; hover: string; active: string }> = [
  { idle: "bg-blue-500/20 border-blue-500/40", hover: "hover:bg-blue-500/30", active: "bg-blue-500/50 border-blue-400" },
  { idle: "bg-violet-500/20 border-violet-500/40", hover: "hover:bg-violet-500/30", active: "bg-violet-500/50 border-violet-400" },
  { idle: "bg-pink-500/20 border-pink-500/40", hover: "hover:bg-pink-500/30", active: "bg-pink-500/50 border-pink-400" },
  { idle: "bg-amber-500/20 border-amber-500/40", hover: "hover:bg-amber-500/30", active: "bg-amber-500/50 border-amber-400" },
  { idle: "bg-emerald-500/20 border-emerald-500/40", hover: "hover:bg-emerald-500/30", active: "bg-emerald-500/50 border-emerald-400" },
  { idle: "bg-cyan-500/20 border-cyan-500/40", hover: "hover:bg-cyan-500/30", active: "bg-cyan-500/50 border-cyan-400" },
  { idle: "bg-orange-500/20 border-orange-500/40", hover: "hover:bg-orange-500/30", active: "bg-orange-500/50 border-orange-400" },
  { idle: "bg-red-500/20 border-red-500/40", hover: "hover:bg-red-500/30", active: "bg-red-500/50 border-red-400" },
];

export function SamplerPads({ track }: { track: TrackState }) {
  const [activePads, setActivePads] = useState<Set<string>>(new Set());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  function triggerPad(pad: SamplerPad) {
    getEngine().playPad(
      track.id,
      pad.startSec,
      pad.endSec,
      track.volume,
      track.normalizationGain,
      track.pan,
    );

    const existing = timers.current.get(pad.id);
    if (existing) clearTimeout(existing);

    setActivePads((prev) => new Set(prev).add(pad.id));
    const durMs = Math.max(80, (pad.endSec - pad.startSec) * 1000);
    const timer = setTimeout(() => {
      setActivePads((prev) => {
        const next = new Set(prev);
        next.delete(pad.id);
        return next;
      });
      timers.current.delete(pad.id);
    }, durMs);
    timers.current.set(pad.id, timer);
  }

  return (
    <div className="grid grid-cols-4 gap-1.5">
      {track.samplerPads.map((pad, i) => {
        const isActive = activePads.has(pad.id);
        const c = PAD_COLORS[i % PAD_COLORS.length];
        return (
          <button
            key={pad.id}
            onPointerDown={(e) => {
              e.preventDefault();
              triggerPad(pad);
            }}
            className={`h-14 rounded-lg border transition-all duration-75 flex flex-col items-center justify-center gap-0.5 active:scale-95 select-none ${
              isActive ? c.active : `${c.idle} ${c.hover}`
            }`}
          >
            <span className="text-sm font-bold tabular-nums text-white/80 leading-none">
              {pad.label}
            </span>
            <span className="text-[9px] text-white/40 leading-none tabular-nums">
              {(pad.endSec - pad.startSec).toFixed(2)}s
            </span>
          </button>
        );
      })}
    </div>
  );
}
