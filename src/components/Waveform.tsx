"use client";

import { useEffect, useRef, useState } from "react";
import { getEngine } from "@/audio/engine";
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
const HANDLE_TARGET_PX = 44;
const MIN_TRIM_GAP_SEC = 0.05;
const SNAP_TO_END_SEC = 0.01;
const DOUBLE_TAP_MS = 320;
const MAX_PEAK_BINS = 4096;

interface WaveformPeaks {
  min: Float32Array;
  max: Float32Array;
}

// AudioBuffers are replaced, rather than mutated, whenever track audio
// changes. A WeakMap therefore lets every Waveform instance reuse one compact
// peak summary without retaining buffers after the engine releases them.
const peakCache = new WeakMap<AudioBuffer, WaveformPeaks>();

function getWaveformPeaks(buffer: AudioBuffer): WaveformPeaks {
  const cached = peakCache.get(buffer);
  if (cached) return cached;

  const binCount = Math.max(1, Math.min(MAX_PEAK_BINS, buffer.length));
  const min = new Float32Array(binCount);
  const max = new Float32Array(binCount);
  const channels = Array.from(
    { length: buffer.numberOfChannels },
    (_, channel) => buffer.getChannelData(channel),
  );

  for (let bin = 0; bin < binCount; bin++) {
    const start = Math.floor((bin * buffer.length) / binCount);
    const end = Math.max(
      start + 1,
      Math.floor(((bin + 1) * buffer.length) / binCount),
    );
    let binMin = 0;
    let binMax = 0;
    for (let sample = start; sample < end; sample++) {
      let mono = 0;
      for (let channel = 0; channel < channels.length; channel++) {
        mono += channels[channel][sample];
      }
      mono /= channels.length;
      if (mono < binMin) binMin = mono;
      if (mono > binMax) binMax = mono;
    }
    min[bin] = Math.max(-1, Math.min(1, binMin));
    max[bin] = Math.max(-1, Math.min(1, binMax));
  }

  const peaks = { min, max };
  peakCache.set(buffer, peaks);
  return peaks;
}

// Paint the cached peak summary at the current canvas width. Resizing now
// costs O(canvas width + peak bins), not O(raw audio samples).
function drawWaveformToCanvas(canvas: HTMLCanvasElement, peaks: WaveformPeaks) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW === 0 || cssH === 0) return;

  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const numCols = Math.max(1, Math.floor(cssW));
  const binCount = peaks.min.length;
  const mid = cssH / 2;

  ctx.fillStyle = "#4e7fc4";

  for (let col = 0; col < numCols; col++) {
    const start = Math.min(
      binCount - 1,
      Math.floor((col * binCount) / numCols),
    );
    const end = Math.max(
      start + 1,
      Math.floor(((col + 1) * binCount) / numCols),
    );
    let min = peaks.min[start];
    let max = peaks.max[start];
    for (let bin = start + 1; bin < Math.min(binCount, end); bin++) {
      if (peaks.min[bin] < min) min = peaks.min[bin];
      if (peaks.max[bin] > max) max = peaks.max[bin];
    }
    const barH = Math.max(1, (max - min) * mid);
    ctx.fillRect(col, mid - max * mid, 1, barH);
  }
}

export function Waveform({
  trackId,
  hasAudio,
  bufferRevision,
  trimInSec,
  trimOutSec,
  durationSec,
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
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

  // Recompute peaks only for a new AudioBuffer. ResizeObserver redraws from
  // the compact cached summary and coalesces resize bursts to one frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !hasAudio) return;
    const buffer = getEngine().getTrack(trackId)?.buffer;
    if (!buffer) return;

    let peaks: WaveformPeaks | null = null;
    let raf = 0;

    const draw = () => {
      raf = 0;
      if (canvas.clientWidth === 0 || canvas.clientHeight === 0) return;
      peaks ??= getWaveformPeaks(buffer);
      drawWaveformToCanvas(canvas, peaks);
    };
    const scheduleDraw = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    };

    scheduleDraw();

    const ro = new ResizeObserver(scheduleDraw);
    ro.observe(canvas);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [trackId, hasAudio, bufferRevision]);

  function onTrackPointerDown(e: React.PointerEvent<HTMLDivElement>) {
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
          const snapped = newOut >= safeDuration - SNAP_TO_END_SEC ? null : newOut;
          setTrim(trackId, trimInSec, snapped);
        }
      };
      const onUp = (ev: PointerEvent) => {
        try {
          (ev.target as Element)?.releasePointerCapture?.(ev.pointerId);
        } catch { /* ignore */ }
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

  function adjustTrimWithKeyboard(
    side: "left" | "right",
    event: React.KeyboardEvent<HTMLDivElement>,
  ) {
    const step = event.shiftKey ? 0.5 : 0.05;
    const current = side === "left" ? trimInSec : effectiveOut;
    const min = side === "left" ? 0 : trimInSec + MIN_TRIM_GAP_SEC;
    const max =
      side === "left" ? effectiveOut - MIN_TRIM_GAP_SEC : safeDuration;
    let next: number | null = null;

    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      next = current - step;
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      next = current + step;
    } else if (event.key === "Home") {
      next = min;
    } else if (event.key === "End") {
      next = max;
    }
    if (next === null) return;

    event.preventDefault();
    const clamped = Math.max(min, Math.min(max, next));
    if (side === "left") {
      setTrim(trackId, clamped, trimOutSec);
    } else {
      setTrim(
        trackId,
        trimInSec,
        clamped >= safeDuration - SNAP_TO_END_SEC ? null : clamped,
      );
    }
  }

  return (
    <div className="relative select-none pt-3.5">
      {/* Time labels during handle drag */}
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
        {/* Canvas + dim overlays */}
        <div className="absolute inset-0 rounded-md overflow-hidden bg-neutral-900/50">
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full"
          />
          {/* Dim region before trim-in */}
          <div
            className={`absolute inset-y-0 left-0 pointer-events-none transition-[background-color,width] ${
              trimMode ? "bg-black/55" : isTrimmed ? "bg-black/30" : "bg-transparent"
            }`}
            style={{ width: `${inPct}%` }}
          />
          {/* Dim region after trim-out */}
          <div
            className={`absolute inset-y-0 right-0 pointer-events-none transition-[background-color,width] ${
              trimMode ? "bg-black/55" : isTrimmed ? "bg-black/30" : "bg-transparent"
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
              ariaMin={0}
              ariaMax={Math.max(0, effectiveOut - MIN_TRIM_GAP_SEC)}
              onPointerDown={startDrag("left")}
              onKeyDown={(event) => adjustTrimWithKeyboard("left", event)}
            />
            <Handle
              side="right"
              pct={outPct}
              active={activeSide === "right"}
              ariaValue={effectiveOut}
              ariaMin={Math.min(safeDuration, trimInSec + MIN_TRIM_GAP_SEC)}
              ariaMax={safeDuration}
              onPointerDown={startDrag("right")}
              onKeyDown={(event) => adjustTrimWithKeyboard("right", event)}
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
      <button
        type="button"
        aria-pressed={trimMode}
        onClick={() => setTrimMode((enabled) => !enabled)}
        className={`mt-1 min-h-7 px-2 rounded-md border text-[10px] font-semibold uppercase tracking-[0.12em] transition-colors ${
          trimMode
            ? "border-amber-400/70 bg-amber-400/15 text-amber-300"
            : "border-[var(--border-subtle)] bg-white/[0.04] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        }`}
      >
        {trimMode ? "Done trimming" : "Trim audio"}
      </button>
    </div>
  );
}

function Handle({
  side,
  pct,
  active,
  ariaValue,
  ariaMin,
  ariaMax,
  onPointerDown,
  onKeyDown,
}: {
  side: "left" | "right";
  pct: number;
  active: boolean;
  ariaValue: number;
  ariaMin: number;
  ariaMax: number;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}) {
  const roundedClass = side === "left" ? "rounded-l-md" : "rounded-r-md";
  const left = `calc(${pct}% - ${HANDLE_TARGET_PX / 2}px)`;
  return (
    <div
      role="slider"
      tabIndex={0}
      data-trim-handle="true"
      aria-label={side === "left" ? "Trim start" : "Trim end"}
      aria-valuemin={ariaMin}
      aria-valuemax={ariaMax}
      aria-valuenow={ariaValue}
      aria-valuetext={`${ariaValue.toFixed(2)} seconds`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      style={{ left, width: HANDLE_TARGET_PX }}
      className="absolute -top-0.5 -bottom-0.5 cursor-ew-resize touch-none flex items-center justify-center"
    >
      <div
        className={`h-full flex items-center justify-center bg-amber-400 transition-shadow ${roundedClass} ${
        active
          ? "shadow-[0_0_0_4px_rgba(251,191,36,0.28)]"
          : "shadow-[0_2px_6px_rgba(0,0,0,0.4)]"
      }`}
        style={{ width: HANDLE_WIDTH_PX }}
      >
        <div className="h-4 w-[2px] bg-black/55 rounded-full" />
      </div>
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
