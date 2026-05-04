"use client";

import { useEffect, useRef, useState } from "react";
import { useCypher } from "@/state/store";
import { getEngine } from "@/audio/engine";
import type { TrackState } from "@/state/store";

const SIDEBAR_W = 72;
const LANE_H = 60;
const RULER_H = 28;
const MIN_PX_PER_SEC = 20;
const MAX_PX_PER_SEC = 300;
const DEFAULT_PX_PER_SEC = 80;
const HANDLE_W = 12;
const MIN_TRIM_GAP_SEC = 0.05;
const SNAP_TO_END_SEC = 0.01;

export function SongEditor({ onClose }: { onClose: () => void }) {
  const tracks = useCypher((s) => s.tracks);
  const seek = useCypher((s) => s.seek);
  const setTrim = useCypher((s) => s.setTrim);

  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);
  const [position, setPosition] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinchStartDist = useRef<number | null>(null);
  const pinchStartPx = useRef(DEFAULT_PX_PER_SEC);

  // Full original audio length drives the scroll area width and ruler range.
  const maxDuration = Math.max(
    10,
    ...tracks.map((t) => (t.hasAudio ? t.durationSec : 0)),
  );
  // Effective playable length (respecting trim) drives the playhead auto-stop.
  const songDuration = Math.max(
    1,
    ...tracks.map((t) => (t.hasAudio ? (t.trimOutSec ?? t.durationSec) : 0)),
  );
  const scrollAreaWidth = maxDuration * pxPerSec;

  // Live playhead via rAF.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setPosition(getEngine().seconds());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Escape to close.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Pinch-to-zoom.
  function pinchDist(e: React.TouchEvent) {
    const t = e.touches;
    return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  }
  function onTouchStart(e: React.TouchEvent) {
    if (e.touches.length === 2) {
      pinchStartDist.current = pinchDist(e);
      pinchStartPx.current = pxPerSec;
    }
  }
  function onTouchMove(e: React.TouchEvent) {
    if (e.touches.length !== 2 || pinchStartDist.current === null) return;
    const ratio = pinchDist(e) / pinchStartDist.current;
    setPxPerSec(
      Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, pinchStartPx.current * ratio)),
    );
  }
  function onTouchEnd() {
    pinchStartDist.current = null;
  }

  // Seek by tapping the ruler tick area.
  function onRulerPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const sec = (e.clientX - rect.left) / pxPerSec;
    seek(Math.max(0, Math.min(songDuration, sec)));
  }

  const playheadPx = position * pxPerSec;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--bg-base)] animate-[slide-up_250ms_cubic-bezier(0.22,1,0.36,1)_both]">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 pt-[max(env(safe-area-inset-top),0.75rem)] pb-3 border-b border-[var(--border-subtle)] shrink-0">
        <h2 className="font-[family-name:var(--font-bebas)] text-xl tracking-[0.18em] leading-none bg-gradient-to-b from-white to-[#9bb6e6] bg-clip-text text-transparent">
          SONG EDITOR
        </h2>
        <span className="text-[11px] tabular-nums text-[var(--accent)] ml-0.5">
          {formatTime(position)}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setPxPerSec((p) => Math.max(MIN_PX_PER_SEC, p / 1.5))}
          aria-label="Zoom out"
          className="w-8 h-8 rounded-lg bg-white/[0.06] border border-[var(--border-subtle)] text-[var(--text-muted)] text-base flex items-center justify-center active:scale-95 transition-transform"
        >
          −
        </button>
        <button
          onClick={() => setPxPerSec((p) => Math.min(MAX_PX_PER_SEC, p * 1.5))}
          aria-label="Zoom in"
          className="w-8 h-8 rounded-lg bg-white/[0.06] border border-[var(--border-subtle)] text-[var(--text-muted)] text-base flex items-center justify-center active:scale-95 transition-transform"
        >
          +
        </button>
        <button
          onClick={onClose}
          aria-label="Close song editor"
          className="w-8 h-8 rounded-lg bg-white/[0.06] border border-[var(--border-subtle)] text-[var(--text-muted)] flex items-center justify-center active:scale-95 transition-transform ml-0.5"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 11 11"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M1 1l9 9M10 1L1 10" />
          </svg>
        </button>
      </div>

      {/* Scrollable timeline */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {/* Inner content — sets scroll extent. The repeating gradient draws
            subtle lane-guide lines across the full empty area below tracks. */}
        <div
          className="relative"
          style={{
            width: scrollAreaWidth + SIDEBAR_W + 32,
            minWidth: "100%",
            backgroundImage: `repeating-linear-gradient(to bottom, transparent 0px, transparent ${LANE_H - 1}px, rgba(120,160,220,0.07) ${LANE_H - 1}px, rgba(120,160,220,0.07) ${LANE_H}px)`,
            backgroundPositionY: `${RULER_H}px`,
          }}
        >
          {/* ── Ruler row (sticky top) ── */}
          <div
            className="sticky top-0 z-10 flex bg-[var(--bg-base)] border-b border-[var(--border-subtle)]"
            style={{ height: RULER_H }}
          >
            {/* Corner — sticky left within sticky-top row */}
            <div
              className="sticky left-0 z-20 shrink-0 bg-[var(--bg-base)] border-r border-[var(--border-subtle)]"
              style={{ width: SIDEBAR_W }}
            />
            {/* Tick area — overflow-hidden prevents ticks escaping container */}
            <div
              className="relative overflow-hidden select-none cursor-pointer"
              style={{ width: scrollAreaWidth }}
              onPointerDown={onRulerPointerDown}
            >
              <RulerTicks duration={maxDuration} pxPerSec={pxPerSec} />
              {/* Playhead dot lives in ruler so it stays visible when scrolling tracks */}
              <div
                className="absolute bottom-0 w-2.5 h-2.5 rounded-full bg-[var(--accent)] pointer-events-none -translate-x-1/2"
                style={{ left: playheadPx }}
              />
            </div>
          </div>

          {/* ── Track lanes ── */}
          {tracks.length === 0 ? (
            <div
              className="flex items-center justify-center text-[var(--text-faint)] text-sm"
              style={{ height: 120 }}
            >
              Add tracks to see them here
            </div>
          ) : (
            tracks.map((t) => (
              <div
                key={t.id}
                className="flex"
                style={{ height: LANE_H }}
              >
                {/* Track name — sticky left so it stays visible when scrolling right */}
                <div
                  className="sticky left-0 z-10 shrink-0 flex items-center px-2.5 bg-[var(--bg-base)] border-r border-b border-[var(--border-subtle)]/50"
                  style={{ width: SIDEBAR_W }}
                >
                  <span className="text-[10px] font-medium text-[var(--text-muted)] truncate leading-tight">
                    {t.name}
                  </span>
                </div>
                {/* Audio region */}
                <LaneContent
                  track={t}
                  pxPerSec={pxPerSec}
                  scrollAreaWidth={scrollAreaWidth}
                  setTrim={setTrim}
                />
              </div>
            ))
          )}

          {/* ── Playhead line through track lanes ──
              z-[5] keeps it below the sticky ruler (z-10) so the ruler header
              always paints on top when scrolling vertically. */}
          <div
            className="absolute top-0 bottom-0 w-px bg-[var(--accent)]/60 pointer-events-none z-[5]"
            style={{ left: SIDEBAR_W + playheadPx }}
          />
        </div>
      </div>
    </div>
  );
}

function LaneContent({
  track,
  pxPerSec,
  scrollAreaWidth,
  setTrim,
}: {
  track: TrackState;
  pxPerSec: number;
  scrollAreaWidth: number;
  setTrim: (id: string, inSec: number, outSec: number | null) => void;
}) {
  const laneRef = useRef<HTMLDivElement>(null);
  const [activeSide, setActiveSide] = useState<"left" | "right" | null>(null);

  const safeDur = track.durationSec > 0 ? track.durationSec : 1;
  const effectiveOut = track.trimOutSec ?? safeDur;
  const laneWidth = safeDur * pxPerSec;
  const inPx = (track.trimInSec / safeDur) * laneWidth;
  const outPx = (effectiveOut / safeDur) * laneWidth;

  function startDrag(side: "left" | "right") {
    return (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      setActiveSide(side);

      const onMove = (ev: PointerEvent) => {
        const r = laneRef.current?.getBoundingClientRect();
        if (!r) return;
        const sec = Math.max(0, Math.min(safeDur, (ev.clientX - r.left) / pxPerSec));
        if (side === "left") {
          const limit = (track.trimOutSec ?? safeDur) - MIN_TRIM_GAP_SEC;
          setTrim(track.id, Math.min(sec, Math.max(0, limit)), track.trimOutSec);
        } else {
          const minOut = track.trimInSec + MIN_TRIM_GAP_SEC;
          const newOut = Math.max(sec, minOut);
          const snapped = newOut >= safeDur - SNAP_TO_END_SEC ? null : newOut;
          setTrim(track.id, track.trimInSec, snapped);
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

  if (!track.hasAudio) {
    // Empty lane extends to fill the full scroll area width.
    return (
      <div
        className="border-b border-[var(--border-subtle)]/30"
        style={{ width: scrollAreaWidth, height: LANE_H, flexShrink: 0 }}
      />
    );
  }

  return (
    // overflow-hidden clips handles that would otherwise bleed into the sidebar
    // at trimInSec=0 (left handle at px -6) or past track end (right at +6).
    <div
      ref={laneRef}
      className="relative shrink-0 overflow-hidden border-b border-[var(--border-subtle)]/30"
      style={{ width: laneWidth, height: LANE_H }}
    >
      {/* Dim before trim-in */}
      {inPx > 0 && (
        <div
          className="absolute inset-y-0 left-0 bg-black/50 pointer-events-none"
          style={{ width: inPx }}
        />
      )}

      {/* Active region */}
      <div
        className="absolute inset-y-[6px] bg-[var(--accent)]/[0.17] border-y border-[var(--accent)]/25"
        style={{ left: inPx, width: Math.max(0, outPx - inPx) }}
      />

      {/* Dim after trim-out */}
      {outPx < laneWidth && (
        <div
          className="absolute inset-y-0 right-0 bg-black/50 pointer-events-none"
          style={{ width: Math.max(0, laneWidth - outPx) }}
        />
      )}

      {/* Trim handles — clamped so they stay fully visible within the lane */}
      <TrimHandle
        side="left"
        px={Math.max(0, inPx - HANDLE_W / 2) + HANDLE_W / 2}
        active={activeSide === "left"}
        onPointerDown={startDrag("left")}
      />
      <TrimHandle
        side="right"
        px={Math.min(laneWidth, outPx + HANDLE_W / 2) - HANDLE_W / 2}
        active={activeSide === "right"}
        onPointerDown={startDrag("right")}
      />
    </div>
  );
}

function TrimHandle({
  side,
  px,
  active,
  onPointerDown,
}: {
  side: "left" | "right";
  px: number;
  active: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const rounded = side === "left" ? "rounded-l-sm" : "rounded-r-sm";
  return (
    <div
      data-trim-handle
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: px - HANDLE_W / 2,
        width: HANDLE_W,
      }}
      className={`cursor-ew-resize touch-none z-10 flex items-center justify-center bg-amber-400 ${rounded} ${
        active ? "shadow-[0_0_0_3px_rgba(251,191,36,0.28)]" : ""
      }`}
    >
      <div className="h-4 w-[2px] bg-black/50 rounded-full" />
    </div>
  );
}

function RulerTicks({ duration, pxPerSec }: { duration: number; pxPerSec: number }) {
  const interval =
    pxPerSec >= 160 ? 1 : pxPerSec >= 40 ? 5 : pxPerSec >= 14 ? 15 : 30;

  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += interval) {
    ticks.push(t);
  }

  return (
    <>
      {ticks.map((t) => (
        <div
          key={t}
          className="absolute top-0 flex flex-col items-center pointer-events-none"
          style={{ left: t * pxPerSec }}
        >
          <div className="w-px h-2 bg-[var(--border-strong)]" />
          <span className="text-[8px] tabular-nums text-[var(--text-faint)] mt-0.5 whitespace-nowrap select-none">
            {formatTime(t)}
          </span>
        </div>
      ))}
    </>
  );
}

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
