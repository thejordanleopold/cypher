"use client";

import { useEffect, useRef, useState } from "react";
import { type TrackState, type SamplerPad } from "@/state/store";
import { getEngine } from "@/audio/engine";

interface PadColor {
  idle: string;
  active: string;
}

// Pre-baked Tailwind classes per pad slot (Tailwind can't synthesize dynamic
// class names from variables — every class must appear literally).
const PAD_COLORS: PadColor[] = [
  {
    idle: "bg-gradient-to-b from-blue-400/20 to-blue-700/30 border-blue-500/50",
    active:
      "bg-gradient-to-b from-blue-300 to-blue-500 border-blue-200 shadow-[0_0_18px_rgba(59,130,246,0.75),inset_0_1px_0_rgba(255,255,255,0.4)]",
  },
  {
    idle: "bg-gradient-to-b from-violet-400/20 to-violet-700/30 border-violet-500/50",
    active:
      "bg-gradient-to-b from-violet-300 to-violet-500 border-violet-200 shadow-[0_0_18px_rgba(139,92,246,0.75),inset_0_1px_0_rgba(255,255,255,0.4)]",
  },
  {
    idle: "bg-gradient-to-b from-pink-400/20 to-pink-700/30 border-pink-500/50",
    active:
      "bg-gradient-to-b from-pink-300 to-pink-500 border-pink-200 shadow-[0_0_18px_rgba(236,72,153,0.75),inset_0_1px_0_rgba(255,255,255,0.4)]",
  },
  {
    idle: "bg-gradient-to-b from-amber-400/20 to-amber-700/30 border-amber-500/50",
    active:
      "bg-gradient-to-b from-amber-300 to-amber-500 border-amber-200 shadow-[0_0_18px_rgba(245,158,11,0.75),inset_0_1px_0_rgba(255,255,255,0.4)]",
  },
  {
    idle: "bg-gradient-to-b from-emerald-400/20 to-emerald-700/30 border-emerald-500/50",
    active:
      "bg-gradient-to-b from-emerald-300 to-emerald-500 border-emerald-200 shadow-[0_0_18px_rgba(16,185,129,0.75),inset_0_1px_0_rgba(255,255,255,0.4)]",
  },
  {
    idle: "bg-gradient-to-b from-cyan-400/20 to-cyan-700/30 border-cyan-500/50",
    active:
      "bg-gradient-to-b from-cyan-300 to-cyan-500 border-cyan-200 shadow-[0_0_18px_rgba(6,182,212,0.75),inset_0_1px_0_rgba(255,255,255,0.4)]",
  },
  {
    idle: "bg-gradient-to-b from-orange-400/20 to-orange-700/30 border-orange-500/50",
    active:
      "bg-gradient-to-b from-orange-300 to-orange-500 border-orange-200 shadow-[0_0_18px_rgba(249,115,22,0.75),inset_0_1px_0_rgba(255,255,255,0.4)]",
  },
  {
    idle: "bg-gradient-to-b from-red-400/20 to-red-700/30 border-red-500/50",
    active:
      "bg-gradient-to-b from-red-300 to-red-500 border-red-200 shadow-[0_0_18px_rgba(239,68,68,0.75),inset_0_1px_0_rgba(255,255,255,0.4)]",
  },
];

// Visual flash hold — long enough to register at a glance, short enough that
// rapid finger drumming reads as separate hits, not a smear.
const FLASH_MIN_MS = 90;
const FLASH_MAX_MS = 400;

export function SamplerPads({ track }: { track: TrackState }) {
  const [activePads, setActivePads] = useState<Set<string>>(new Set());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const t = timers.current;
    return () => {
      t.forEach(clearTimeout);
      t.clear();
    };
  }, []);

  function triggerPad(pad: SamplerPad) {
    getEngine().playPad(
      track.id,
      pad.startSec,
      pad.endSec,
      track.volume,
      track.normalizationGain,
      track.pan,
    );

    // Best-effort haptic. iOS Safari ignores this — the pad's visual flash
    // and the audio onset are the primary feedback there.
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      try {
        navigator.vibrate(8);
      } catch {
        // ignore
      }
    }

    const existing = timers.current.get(pad.id);
    if (existing) clearTimeout(existing);

    setActivePads((prev) => {
      const next = new Set(prev);
      next.add(pad.id);
      return next;
    });
    const sliceMs = (pad.endSec - pad.startSec) * 1000;
    const holdMs = Math.min(FLASH_MAX_MS, Math.max(FLASH_MIN_MS, sliceMs));
    const timer = setTimeout(() => {
      setActivePads((prev) => {
        const next = new Set(prev);
        next.delete(pad.id);
        return next;
      });
      timers.current.delete(pad.id);
    }, holdMs);
    timers.current.set(pad.id, timer);
  }

  return (
    <div className="grid grid-cols-4 gap-1.5 p-1 rounded-xl bg-black/40 ring-1 ring-white/5">
      {track.samplerPads.map((pad, i) => {
        const isActive = activePads.has(pad.id);
        const c = PAD_COLORS[i % PAD_COLORS.length];
        return (
          <button
            key={pad.id}
            onPointerDown={(e) => {
              // preventDefault stops the synthetic mouse "click" that follows
              // a touch on iOS Safari, which would otherwise re-trigger the
              // pad ~300ms after the touch.
              e.preventDefault();
              triggerPad(pad);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                triggerPad(pad);
              }
            }}
            className={`h-16 rounded-lg border-2 flex flex-col items-center justify-center gap-0.5 select-none touch-none transition-[transform,box-shadow,background-color,border-color] duration-75 ${
              isActive
                ? `scale-[0.93] ${c.active}`
                : `${c.idle} active:scale-[0.95] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_2px_3px_rgba(0,0,0,0.3)]`
            }`}
            aria-label={`Pad ${pad.label}`}
          >
            <span
              className={`text-base font-extrabold tabular-nums leading-none ${
                isActive ? "text-white" : "text-white/80"
              }`}
            >
              {pad.label}
            </span>
            <span
              className={`text-[8px] leading-none tabular-nums ${
                isActive ? "text-white/80" : "text-white/35"
              }`}
            >
              {(pad.endSec - pad.startSec).toFixed(2)}s
            </span>
          </button>
        );
      })}
    </div>
  );
}
