"use client";

import { useEffect, useState } from "react";
import { useCypher } from "@/state/store";
import { LevelMeter } from "@/components/LevelMeter";

const HOLD_MS = 3000;
const RING_CIRCUMFERENCE = 2 * Math.PI * 46;

export function RecordingShield() {
  const isMultiRecording = useCypher((s) => s.isMultiRecording);
  const recordingTrackId = useCypher((s) => s.recordingTrackId);
  const tracks = useCypher((s) => s.tracks);
  const stopArmedRecording = useCypher((s) => s.stopArmedRecording);
  const stopRecording = useCypher((s) => s.stopRecording);
  const active = isMultiRecording || recordingTrackId !== null;

  const meterTrackId =
    recordingTrackId ?? tracks.find((t) => t.armed)?.id ?? null;

  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) return;
    const startedAt = performance.now();
    let raf = 0;
    const tick = () => {
      setElapsed((performance.now() - startedAt) / 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  const [holding, setHolding] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!holding) return;
    const startedAt = performance.now();
    let stopped = false;
    let raf = 0;
    const tick = () => {
      const p = Math.min(1, (performance.now() - startedAt) / HOLD_MS);
      setProgress(p);
      if (p >= 1 && !stopped) {
        stopped = true;
        const state = useCypher.getState();
        if (state.isMultiRecording) state.stopArmedRecording();
        else if (state.recordingTrackId) state.stopRecording();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [holding, stopArmedRecording, stopRecording]);

  const release = () => {
    setHolding(false);
    setProgress(0);
  };

  if (!active) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Recording in progress — touch is locked"
      className="fixed inset-0 z-[60] bg-neutral-950/95 backdrop-blur-sm flex flex-col items-center justify-between py-12 px-6 select-none touch-none pt-[max(env(safe-area-inset-top),3rem)] pb-[max(env(safe-area-inset-bottom),3rem)]"
    >
      <div className="flex flex-col items-center gap-4">
        <div className="flex items-center gap-2 text-red-400 text-xs uppercase tracking-[0.25em]">
          <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
          Recording
        </div>
        <div className="font-[family-name:var(--font-bebas)] text-7xl tabular-nums text-neutral-100 tracking-wider leading-none">
          {formatTime(elapsed)}
        </div>
        {meterTrackId && (
          <div className="h-12 flex items-end">
            <LevelMeter trackId={meterTrackId} />
          </div>
        )}
      </div>

      <div className="flex flex-col items-center gap-5">
        <p className="text-neutral-400 text-xs text-center max-w-[18rem] leading-relaxed">
          Screen is locked so a stray touch can&rsquo;t end your take. Hold the button below for 3 seconds to stop.
        </p>
        <HoldButton
          progress={progress}
          onPress={() => setHolding(true)}
          onRelease={release}
        />
      </div>
    </div>
  );
}

function HoldButton({
  progress,
  onPress,
  onRelease,
}: {
  progress: number;
  onPress: () => void;
  onRelease: () => void;
}) {
  return (
    <button
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        onPress();
      }}
      onPointerUp={onRelease}
      onPointerCancel={onRelease}
      aria-label="Hold for three seconds to stop recording"
      className="relative h-36 w-36 rounded-full bg-red-600 active:bg-red-700 flex items-center justify-center shadow-[0_0_60px_-10px_rgba(239,68,68,0.6)] touch-none"
    >
      <svg
        className="absolute inset-0 -rotate-90"
        viewBox="0 0 100 100"
        aria-hidden="true"
      >
        <circle
          cx="50"
          cy="50"
          r="46"
          fill="none"
          stroke="rgba(255,255,255,0.18)"
          strokeWidth="4"
        />
        <circle
          cx="50"
          cy="50"
          r="46"
          fill="none"
          stroke="white"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${progress * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
        />
      </svg>
      <span className="text-white text-[11px] uppercase tracking-[0.15em] font-bold text-center leading-tight">
        Hold 3s
        <br />
        to stop
      </span>
    </button>
  );
}

function formatTime(seconds: number): string {
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
