"use client";

import { useEffect, useRef, useState } from "react";
import { useCypher } from "@/state/store";
import { getEngine } from "@/audio/engine";
import {
  clampProjectTime,
  hasSamplerCaptureSource,
  projectDuration,
  trackProjectDuration,
} from "@/audio/project-time";

const DOUBLE_TAP_MS = 300;

export function Timeline({ onOpenSongEditor }: { onOpenSongEditor?: () => void }) {
  const tracks = useCypher((s) => s.tracks);
  const isPlaying = useCypher((s) => s.isPlaying);
  const isRecording = useCypher(
    (s) => s.isMultiRecording || s.recordingTrackId !== null,
  );
  const storedPosition = useCypher((s) => s.positionSec);
  const seek = useCypher((s) => s.seek);
  const stop = useCypher((s) => s.stop);
  const lastTapRef = useRef(0);

  const duration = projectDuration(tracks);
  const samplerCaptureReady = hasSamplerCaptureSource(tracks);

  const [livePosition, setLivePosition] = useState<number | null>(null);
  const [scrubPosition, setScrubPosition] = useState<number | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const scrubbing = scrubPosition !== null;
  const position = clampProjectTime(
    scrubPosition ?? (isPlaying ? livePosition ?? storedPosition : storedPosition),
    duration,
  );

  // Live position via rAF while playing — bypasses store for tightness.
  useEffect(() => {
    if (!isPlaying || scrubbing) return;
    let raf = 0;
    const tick = () => {
      const t = getEngine().seconds();
      setLivePosition(t);
      if (
        !isRecording &&
        !samplerCaptureReady &&
        (duration <= 0 || t >= duration)
      ) {
        // Auto-stop at the end of the longest track.
        stop();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [
    isPlaying,
    isRecording,
    scrubbing,
    duration,
    samplerCaptureReady,
    stop,
  ]);

  function pointToSeconds(clientX: number): number {
    const r = railRef.current?.getBoundingClientRect();
    if (!r || duration === 0) return 0;
    const ratio = (clientX - r.left) / r.width;
    return Math.max(0, Math.min(duration, ratio * duration));
  }

  function onPointerDown(e: React.PointerEvent) {
    if (duration === 0) return;

    // Double-tap opens the song editor.
    const now = Date.now();
    const delta = now - lastTapRef.current;
    if (delta > 0 && delta < DOUBLE_TAP_MS) {
      lastTapRef.current = 0;
      onOpenSongEditor?.();
      return;
    }
    lastTapRef.current = now;

    railRef.current?.setPointerCapture(e.pointerId);
    const s = pointToSeconds(e.clientX);
    setScrubPosition(s);
    setLivePosition(s);
    void seek(s);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!scrubbing) return;
    const s = pointToSeconds(e.clientX);
    setScrubPosition(s);
  }
  function onPointerUp(e: React.PointerEvent) {
    if (!scrubbing) return;
    try {
      railRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      // The browser may already have released capture on pointer cancellation.
    }
    const nextPosition = pointToSeconds(e.clientX);
    setScrubPosition(null);
    setLivePosition(nextPosition);
    void seek(nextPosition);
  }

  function seekFromKeyboard(nextPosition: number) {
    const clamped = clampProjectTime(nextPosition, duration);
    setLivePosition(clamped);
    void seek(clamped);
  }

  const hasAudio = duration > 0;
  const playPercent = hasAudio ? (position / duration) * 100 : 0;

  return (
    <div className="px-3 sm:px-4 lg:px-5 py-1.5 lg:pb-3">
      <div className="flex items-center gap-2">
        <span className="text-[11px] tabular-nums text-[var(--accent)] w-10 text-right">
          {formatTime(position)}
        </span>
        <div
          ref={railRef}
          role="slider"
          aria-label="Project playhead"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={position}
          tabIndex={hasAudio ? 0 : -1}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={(e) => {
            if (!hasAudio) return;
            const step = e.shiftKey ? 5 : 1;
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              seekFromKeyboard(position - step);
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              seekFromKeyboard(position + step);
            } else if (e.key === "Home") {
              e.preventDefault();
              seekFromKeyboard(0);
            } else if (e.key === "End") {
              e.preventDefault();
              seekFromKeyboard(duration);
            }
          }}
          title={hasAudio ? "Double-tap to open song editor" : undefined}
          className={`flex-1 h-7 relative rounded-md bg-white/[0.04] border border-[var(--border-subtle)] overflow-hidden select-none ${
            hasAudio ? "cursor-pointer" : "cursor-default opacity-60"
          }`}
        >
          {/* Track lanes */}
          <div className="absolute inset-0 flex flex-col gap-px">
            {tracks.length > 0 ? (
              tracks.slice(0, 4).map((t) => (
                <TrackLane
                  key={t.id}
                  durationRatio={
                    duration > 0 ? trackProjectDuration(t) / duration : 0
                  }
                />
              ))
            ) : null}
          </div>

          {/* Tick marks every second when zoomed-out */}
          {hasAudio && <Ticks duration={duration} />}

          {/* Playhead */}
          {hasAudio && (
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-[var(--accent)] pointer-events-none"
              style={{ left: `${playPercent}%` }}
            >
              <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-[var(--accent)]" />
            </div>
          )}
        </div>
        <span className="text-[11px] tabular-nums text-[var(--text-faint)] w-10">
          {formatTime(duration)}
        </span>
        <button
          type="button"
          onClick={onOpenSongEditor}
          disabled={!hasAudio || !onOpenSongEditor}
          aria-label="Open song editor"
          title="Open song editor"
          className="h-7 w-7 shrink-0 rounded-md border border-[var(--border-subtle)] bg-white/[0.04] text-[var(--text-muted)] flex items-center justify-center hover:text-[var(--text-primary)] disabled:opacity-40 disabled:cursor-default"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function TrackLane({
  durationRatio,
}: {
  durationRatio: number;
}) {
  if (durationRatio <= 0) {
    return <div className="flex-1" />;
  }
  return (
    <div className="flex-1 relative">
      <div
        className="absolute top-0.5 bottom-0.5 bg-[var(--accent)]/25 rounded-sm"
        style={{
          left: 0,
          width: `${Math.min(1, durationRatio) * 100}%`,
        }}
      />
    </div>
  );
}

function Ticks({ duration }: { duration: number }) {
  // Pick a sensible tick interval based on duration so we don't spam the bar.
  const interval =
    duration < 10 ? 1 : duration < 60 ? 5 : duration < 300 ? 30 : 60;
  const count = Math.floor(duration / interval);
  if (count < 2) return null;
  const ticks = Array.from({ length: count }, (_, i) => (i + 1) * interval);
  return (
    <div className="absolute inset-0 pointer-events-none">
      {ticks.map((t) => (
        <div
          key={t}
          className="absolute top-0 bottom-0 w-px bg-neutral-700/40"
          style={{ left: `${(t / duration) * 100}%` }}
        />
      ))}
    </div>
  );
}

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
