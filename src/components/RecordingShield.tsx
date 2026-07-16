"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useCypher } from "@/state/store";
import { LevelMeter } from "@/components/LevelMeter";

const HOLD_MS = 3000;
const RING_CIRCUMFERENCE = 2 * Math.PI * 46;

export function RecordingShield() {
  const isMultiRecording = useCypher((s) => s.isMultiRecording);
  const recordingTrackId = useCypher((s) => s.recordingTrackId);
  const isFinalizingRecording = useCypher((s) => s.isFinalizingRecording);
  const tracks = useCypher((s) => s.tracks);
  const active =
    isMultiRecording || recordingTrackId !== null || isFinalizingRecording;
  const dialogRef = useRef<HTMLDivElement>(null);
  const holdButtonRef = useRef<HTMLButtonElement>(null);
  const stoppingRef = useRef(false);

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
  const [stopping, setStopping] = useState(false);

  const stopActiveRecording = useCallback(async () => {
    if (stoppingRef.current) return;
    const state = useCypher.getState();
    if (!state.isMultiRecording && !state.recordingTrackId) return;

    stoppingRef.current = true;
    setStopping(true);
    dialogRef.current?.focus();
    setHolding(false);
    setProgress(0);
    try {
      if (state.isMultiRecording) await state.stopArmedRecording();
      else await state.stopRecording();
    } finally {
      stoppingRef.current = false;
      setStopping(false);
    }
  }, []);

  useEffect(() => {
    if (active) return;
    const frame = requestAnimationFrame(() => {
      setHolding(false);
      setProgress(0);
      setElapsed(0);
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const changed: Array<{
      node: HTMLElement;
      inert: boolean;
      ariaHidden: string | null;
    }> = [];

    // Make every sibling outside the dialog's ancestor chain inert. This
    // covers the app beneath the shield and layout-level UI such as toasts.
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

    const keepFocusInside = (event: FocusEvent) => {
      if (!dialog.contains(event.target as Node)) holdButtonRef.current?.focus();
    };
    document.addEventListener("focusin", keepFocusInside);
    const frame = requestAnimationFrame(() => holdButtonRef.current?.focus());

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", keepFocusInside);
      for (const { node, inert, ariaHidden } of changed.reverse()) {
        node.inert = inert;
        if (ariaHidden === null) node.removeAttribute("aria-hidden");
        else node.setAttribute("aria-hidden", ariaHidden);
      }
      previouslyFocused?.focus();
    };
  }, [active]);

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
        void stopActiveRecording();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [holding, stopActiveRecording]);

  const release = () => {
    setHolding(false);
    setProgress(0);
  };

  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      holdButtonRef.current?.focus();
      return;
    }
    if (event.key !== "Tab") return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!active) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="recording-shield-title"
      aria-describedby="recording-shield-instructions"
      aria-busy={stopping}
      tabIndex={-1}
      onKeyDown={onDialogKeyDown}
      className="fixed inset-0 z-[60] bg-neutral-950/95 backdrop-blur-sm flex flex-col items-center overflow-y-auto py-12 px-6 select-none touch-pan-y overscroll-contain pt-[max(env(safe-area-inset-top),3rem)] pb-[max(env(safe-area-inset-bottom),3rem)]"
    >
      <div className="flex flex-col items-center gap-4 shrink-0">
        <div
          id="recording-shield-title"
          className="flex items-center gap-2 text-red-400 text-xs uppercase tracking-[0.25em]"
        >
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

      <div className="flex flex-col items-center gap-5 mt-auto pt-8 shrink-0">
        <p
          id="recording-shield-instructions"
          className="text-neutral-400 text-xs text-center max-w-[20rem] leading-relaxed"
        >
          Screen is locked so a stray touch can&rsquo;t end your take. Hold the large button for 3 seconds, or use Stop Now.
        </p>
        <HoldButton
          buttonRef={holdButtonRef}
          progress={progress}
          onPress={() => setHolding(true)}
          onRelease={release}
          disabled={stopping}
        />
        <button
          type="button"
          onClick={() => void stopActiveRecording()}
          disabled={stopping}
          className="min-h-11 px-5 rounded-xl border border-red-500/50 bg-red-950/60 hover:bg-red-900/70 text-red-100 text-sm font-semibold transition-colors disabled:opacity-60"
        >
          {stopping ? "Stopping…" : "Stop Now"}
        </button>
      </div>
    </div>
  );
}

function HoldButton({
  buttonRef,
  progress,
  onPress,
  onRelease,
  disabled,
}: {
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  progress: number;
  onPress: () => void;
  onRelease: () => void;
  disabled: boolean;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      disabled={disabled}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        onPress();
      }}
      onPointerUp={onRelease}
      onPointerCancel={onRelease}
      onKeyDown={(e) => {
        if ((e.key !== " " && e.key !== "Enter") || e.repeat) return;
        e.preventDefault();
        onPress();
      }}
      onKeyUp={(e) => {
        if (e.key !== " " && e.key !== "Enter") return;
        e.preventDefault();
        onRelease();
      }}
      onBlur={onRelease}
      aria-label="Hold for three seconds to stop recording"
      className="relative h-36 w-36 rounded-full bg-red-600 hover:bg-red-500 active:bg-red-700 flex items-center justify-center shadow-[0_0_60px_-10px_rgba(239,68,68,0.6)] touch-none disabled:opacity-60"
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
