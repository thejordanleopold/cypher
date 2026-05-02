"use client";

import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { getEngine } from "@/audio/engine";
import { audioBufferToWavBlob } from "@/audio/wav";
import { useCypher } from "@/state/store";

interface WaveformProps {
  trackId: string;
  hasAudio: boolean;
  bufferRevision: number;
  trimInSec: number;
  trimOutSec: number | null;
  durationSec: number;
}

const HANDLE_WIDTH_PX = 12;
const MIN_TRIM_GAP_SEC = 0.05;
const SNAP_TO_END_SEC = 0.01;
const DOUBLE_TAP_MS = 320;

export function Waveform({
  trackId,
  hasAudio,
  bufferRevision,
  trimInSec,
  trimOutSec,
  durationSec,
}: WaveformProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const waveContainerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const lastTapRef = useRef(0);
  const setTrim = useCypher((s) => s.setTrim);
  const [activeSide, setActiveSide] = useState<"left" | "right" | null>(null);
  const [trimMode, setTrimMode] = useState(false);

  const safeDuration = durationSec > 0 ? durationSec : 1;
  const effectiveOut = trimOutSec ?? safeDuration;
  const inPct = clampPct((trimInSec / safeDuration) * 100);
  const outPct = clampPct((effectiveOut / safeDuration) * 100);
  const isTrimmed =
    trimInSec > 0.001 ||
    (trimOutSec !== null && trimOutSec < safeDuration - SNAP_TO_END_SEC);

  useEffect(() => {
    if (!waveContainerRef.current) return;
    const ws = WaveSurfer.create({
      container: waveContainerRef.current,
      height: 36,
      waveColor: "#324264",
      progressColor: "#60a5fa",
      cursorColor: "transparent",
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      interact: false,
      normalize: true,
    });
    wsRef.current = ws;
    return () => {
      ws.destroy();
      wsRef.current = null;
    };
  }, [trackId]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !hasAudio) return;
    const buf = getEngine().getTrack(trackId)?.buffer;
    if (!buf) return;
    ws.loadBlob(audioBufferToWavBlob(buf)).catch(() => {});
  }, [trackId, hasAudio, bufferRevision]);

  function onTrackPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Handle taps manage their own pointer events — ignore them here.
    const target = e.target as HTMLElement;
    if (target.closest("[data-trim-handle]")) return;
    const now = Date.now();
    const delta = now - lastTapRef.current;
    if (delta > 0 && delta < DOUBLE_TAP_MS) {
      setTrimMode((m) => !m);
      lastTapRef.current = 0;
    } else {
      lastTapRef.current = now;
    }
  }

  function startDrag(side: "left" | "right") {
    return (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      // Don't let the tap bubble into the parent's double-tap detection.
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      setActiveSide(side);

      const onMove = (ev: PointerEvent) => {
        const r = trackRef.current?.getBoundingClientRect();
        if (!r || r.width === 0) return;
        const ratio = (ev.clientX - r.left) / r.width;
        const sec = Math.max(0, Math.min(safeDuration, ratio * safeDuration));
        if (side === "left") {
          const limit = (trimOutSec ?? safeDuration) - MIN_TRIM_GAP_SEC;
          setTrim(trackId, Math.min(sec, Math.max(0, limit)), trimOutSec);
        } else {
          const minOut = trimInSec + MIN_TRIM_GAP_SEC;
          const newOut = Math.max(sec, minOut);
          // Snap back to "open" trim when dragged to the very end so the
          // saved value matches the buffer length even if the user grew it.
          const snapped = newOut >= safeDuration - SNAP_TO_END_SEC ? null : newOut;
          setTrim(trackId, trimInSec, snapped);
        }
      };
      const onUp = (ev: PointerEvent) => {
        try {
          (ev.target as Element)?.releasePointerCapture?.(ev.pointerId);
        } catch {
          // ignore — pointer capture may already be lost
        }
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        setActiveSide(null);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    };
  }

  return (
    <div className="relative select-none pt-3.5">
      {/* Time labels — visible while a handle is being dragged */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 h-3 transition-opacity duration-150 ${
          activeSide ? "opacity-100" : "opacity-0"
        }`}
      >
        <TimeLabel pct={inPct} seconds={trimInSec} />
        <TimeLabel pct={outPct} seconds={effectiveOut} />
      </div>

      <div
        ref={trackRef}
        onPointerDown={onTrackPointerDown}
        className={`relative h-11 transition-shadow ${
          trimMode ? "ring-1 ring-amber-400/40 rounded-md" : ""
        }`}
        title={trimMode ? "Double tap to exit trim" : "Double tap to trim"}
      >
        {/* Wave + dim overlays — clipped to the rounded track */}
        <div className="absolute inset-0 rounded-md overflow-hidden bg-neutral-900/50">
          <div ref={waveContainerRef} className="absolute inset-0" />
          <div
            className={`absolute inset-y-0 left-0 pointer-events-none transition-[background-color,width] ${
              trimMode
                ? "bg-black/55"
                : isTrimmed
                ? "bg-black/30"
                : "bg-transparent"
            }`}
            style={{ width: `${inPct}%` }}
          />
          <div
            className={`absolute inset-y-0 right-0 pointer-events-none transition-[background-color,width] ${
              trimMode
                ? "bg-black/55"
                : isTrimmed
                ? "bg-black/30"
                : "bg-transparent"
            }`}
            style={{ width: `${100 - outPct}%` }}
          />
        </div>

        {trimMode ? (
          <>
            <div
              className={`absolute inset-y-0 border-y-2 pointer-events-none transition-colors ${
                activeSide ? "border-amber-300" : "border-amber-400/85"
              }`}
              style={{ left: `${inPct}%`, right: `${100 - outPct}%` }}
            />
            <Handle
              side="left"
              pct={inPct}
              active={activeSide === "left"}
              ariaValue={trimInSec}
              ariaMax={safeDuration}
              onPointerDown={startDrag("left")}
            />
            <Handle
              side="right"
              pct={outPct}
              active={activeSide === "right"}
              ariaValue={effectiveOut}
              ariaMax={safeDuration}
              onPointerDown={startDrag("right")}
            />
          </>
        ) : (
          isTrimmed && (
            <>
              <div
                className="absolute inset-y-1 w-px bg-amber-400/55 pointer-events-none"
                style={{ left: `${inPct}%` }}
              />
              <div
                className="absolute inset-y-1 w-px bg-amber-400/55 pointer-events-none"
                style={{ left: `${outPct}%` }}
              />
            </>
          )
        )}
      </div>
    </div>
  );
}

function Handle({
  side,
  pct,
  active,
  ariaValue,
  ariaMax,
  onPointerDown,
}: {
  side: "left" | "right";
  pct: number;
  active: boolean;
  ariaValue: number;
  ariaMax: number;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const roundedClass = side === "left" ? "rounded-l-md" : "rounded-r-md";
  // Center the handle over the trim boundary so the grab target straddles it.
  const left = `calc(${pct}% - ${HANDLE_WIDTH_PX / 2}px)`;
  return (
    <div
      role="slider"
      tabIndex={0}
      data-trim-handle="true"
      aria-label={side === "left" ? "Trim start" : "Trim end"}
      aria-valuemin={0}
      aria-valuemax={ariaMax}
      aria-valuenow={ariaValue}
      onPointerDown={onPointerDown}
      style={{ left, width: HANDLE_WIDTH_PX }}
      className={`absolute -top-0.5 -bottom-0.5 ${roundedClass} bg-amber-400 cursor-ew-resize touch-none flex items-center justify-center transition-shadow ${
        active
          ? "shadow-[0_0_0_4px_rgba(251,191,36,0.28)]"
          : "shadow-[0_2px_6px_rgba(0,0,0,0.4)]"
      }`}
    >
      <div className="h-4 w-[2px] bg-black/55 rounded-full" />
    </div>
  );
}

function TimeLabel({ pct, seconds }: { pct: number; seconds: number }) {
  return (
    <span
      className="absolute -translate-x-1/2 text-[10px] font-semibold tabular-nums text-amber-300 leading-none whitespace-nowrap"
      style={{ left: `${pct}%` }}
    >
      {formatTime(seconds)}
    </span>
  );
}

function clampPct(p: number): number {
  if (!isFinite(p)) return 0;
  return Math.max(0, Math.min(100, p));
}

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const tenths = Math.floor((s - Math.floor(s)) * 10);
  return `${m}:${sec.toString().padStart(2, "0")}.${tenths}`;
}
