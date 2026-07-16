"use client";

import { useEffect, useRef, useState } from "react";
import { useCypher } from "@/state/store";
import { getEngine } from "@/audio/engine";
import type { TrackState } from "@/state/store";
import {
  clampProjectTime,
  projectDuration,
  sourceTimeAtProjectTime,
} from "@/audio/project-time";

const SIDEBAR_W = 72;
const LANE_H = 60;
const RULER_H = 28;
const MIN_PX_PER_SEC = 20;
const MAX_PX_PER_SEC = 300;
const DEFAULT_PX_PER_SEC = 80;
const HANDLE_W = 12;
const HANDLE_TARGET_W = 44;
const MIN_TRIM_GAP_SEC = 0.05;
const SNAP_TO_END_SEC = 0.01;

export function SongEditor({ onClose }: { onClose: () => void }) {
  const tracks = useCypher((s) => s.tracks);
  const isPlaying = useCypher((s) => s.isPlaying);
  const storedPosition = useCypher((s) => s.positionSec);
  const seek = useCypher((s) => s.seek);
  const setTrim = useCypher((s) => s.setTrim);

  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);
  const [livePosition, setLivePosition] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Source time is used only by the trim lanes. Project time is used by
  // playback and sampler events; keeping separate axes prevents trim-in from
  // being mistaken for a clip's placement on the song timeline.
  const maxSourceDuration = Math.max(
    10,
    ...tracks.map((t) => (t.hasAudio ? t.durationSec : 0)),
  );
  const songDuration = projectDuration(tracks);
  const position = clampProjectTime(
    isPlaying ? livePosition ?? storedPosition : storedPosition,
    songDuration,
  );
  const scrollAreaWidth = maxSourceDuration * pxPerSec;

  // Poll only during playback. Paused/stopped/seeking positions come from the
  // store, so keyboard and external transport controls stay synchronized.
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const tick = () => {
      setLivePosition(getEngine().seconds());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);

  // Treat the full-screen editor as a modal: focus it on entry, contain Tab,
  // support Escape, and restore the previously focused control on exit.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const changed: Array<{
      node: HTMLElement;
      inert: boolean;
      ariaHidden: string | null;
    }> = [];
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
    // Pointer activation can finish after this effect runs and move focus
    // back to the document. Wait one frame so the modal reliably owns focus.
    const focusFrame = requestAnimationFrame(() => {
      closeButtonRef.current?.focus({ preventScroll: true });
    });
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handler);
      for (const { node, inert, ariaHidden } of changed.reverse()) {
        node.inert = inert;
        if (ariaHidden === null) node.removeAttribute("aria-hidden");
        else node.setAttribute("aria-hidden", ariaHidden);
      }
      previouslyFocused?.focus();
    };
  }, [onClose]);

  function seekProject(nextPosition: number) {
    const clamped = clampProjectTime(nextPosition, songDuration);
    setLivePosition(clamped);
    void seek(clamped);
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="song-editor-title"
      className="fixed inset-0 z-50 flex flex-col bg-[var(--bg-base)] animate-[slide-up_250ms_cubic-bezier(0.22,1,0.36,1)_both]"
    >
      {/* Header */}
      <div className="flex flex-col gap-2 px-4 pt-[max(env(safe-area-inset-top),0.75rem)] pb-3 border-b border-[var(--border-subtle)] shrink-0">
        <div className="flex items-center gap-2">
          <h2
            id="song-editor-title"
            className="font-[family-name:var(--font-bebas)] text-xl tracking-[0.18em] leading-none bg-gradient-to-b from-white to-[#9bb6e6] bg-clip-text text-transparent"
          >
            SONG EDITOR
          </h2>
          <span className="text-[11px] tabular-nums text-[var(--accent)] ml-0.5">
            {formatTime(position)}
          </span>
          <div className="flex-1" />
          <button
            onClick={() => setPxPerSec((p) => Math.max(MIN_PX_PER_SEC, p / 1.5))}
            aria-label="Zoom source timeline out"
            className="w-8 h-8 rounded-lg bg-white/[0.06] border border-[var(--border-subtle)] text-[var(--text-muted)] text-base flex items-center justify-center active:scale-95 transition-transform"
          >
            −
          </button>
          <button
            onClick={() => setPxPerSec((p) => Math.min(MAX_PX_PER_SEC, p * 1.5))}
            aria-label="Zoom source timeline in"
            className="w-8 h-8 rounded-lg bg-white/[0.06] border border-[var(--border-subtle)] text-[var(--text-muted)] text-base flex items-center justify-center active:scale-95 transition-transform"
          >
            +
          </button>
          <button
            ref={closeButtonRef}
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
        <label className="flex items-center gap-2 text-[9px] uppercase tracking-[0.16em] text-[var(--text-faint)]">
          <span>Project</span>
          <input
            type="range"
            min={0}
            max={Math.max(songDuration, 0.01)}
            step={0.01}
            value={position}
            disabled={songDuration <= 0}
            onChange={(event) => seekProject(Number(event.currentTarget.value))}
            aria-label="Project playhead"
            className="flex-1"
          />
          <span className="tabular-nums normal-case tracking-normal">
            {formatTime(songDuration)}
          </span>
        </label>
      </div>

      {/* Scrollable timeline */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto"
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
              className="sticky left-0 z-20 shrink-0 bg-[var(--bg-base)] border-r border-[var(--border-subtle)] flex items-center justify-center text-[8px] uppercase tracking-[0.12em] text-[var(--text-faint)]"
              style={{ width: SIDEBAR_W }}
            >
              Source
            </div>
            {/* Tick area — overflow-hidden prevents ticks escaping container */}
            <div
              className="relative overflow-hidden select-none"
              style={{ width: scrollAreaWidth }}
            >
              <RulerTicks duration={maxSourceDuration} pxPerSec={pxPerSec} />
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
                  positionSec={position}
                  setTrim={setTrim}
                />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function LaneContent({
  track,
  pxPerSec,
  scrollAreaWidth,
  positionSec,
  setTrim,
}: {
  track: TrackState;
  pxPerSec: number;
  scrollAreaWidth: number;
  positionSec: number;
  setTrim: (id: string, inSec: number, outSec: number | null) => void;
}) {
  const laneRef = useRef<HTMLDivElement>(null);
  const [activeSide, setActiveSide] = useState<"left" | "right" | null>(null);

  const safeDur = track.durationSec > 0 ? track.durationSec : 1;
  const effectiveOut = track.trimOutSec ?? safeDur;
  const laneWidth = safeDur * pxPerSec;
  const inPx = (track.trimInSec / safeDur) * laneWidth;
  const outPx = (effectiveOut / safeDur) * laneWidth;
  const sourcePlayhead = sourceTimeAtProjectTime(track, positionSec);

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

  function adjustWithKeyboard(
    side: "left" | "right",
    event: React.KeyboardEvent<HTMLDivElement>,
  ) {
    const step = event.shiftKey ? 0.5 : 0.05;
    const current = side === "left" ? track.trimInSec : effectiveOut;
    const min = side === "left" ? 0 : track.trimInSec + MIN_TRIM_GAP_SEC;
    const max = side === "left" ? effectiveOut - MIN_TRIM_GAP_SEC : safeDur;
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
      setTrim(track.id, clamped, track.trimOutSec);
    } else {
      setTrim(
        track.id,
        track.trimInSec,
        clamped >= safeDur - SNAP_TO_END_SEC ? null : clamped,
      );
    }
  }

  if (track.kind === "sampler") {
    return (
      <div
        className="border-b border-[var(--border-subtle)]/30 flex items-center px-3 text-[10px] text-[var(--text-faint)]"
        style={{ width: scrollAreaWidth, height: LANE_H, flexShrink: 0 }}
      >
        {track.samplerPattern.length > 0
          ? `${track.samplerPattern.length} pattern event${track.samplerPattern.length === 1 ? "" : "s"} on the project timeline`
          : "No recorded pattern events"}
      </div>
    );
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
    <div
      ref={laneRef}
      className="relative shrink-0 border-b border-[var(--border-subtle)]/30"
      style={{ width: scrollAreaWidth, height: LANE_H }}
    >
      {/* Visual lane content clips to the source region, while the centered
          44px trim hitboxes may extend past an endpoint for touch access. */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {/* Dim before trim-in */}
        {inPx > 0 && (
          <div
            className="absolute inset-y-0 left-0 bg-black/50"
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
            className="absolute inset-y-0 bg-black/50"
            style={{ left: outPx, width: Math.max(0, laneWidth - outPx) }}
          />
        )}

        {sourcePlayhead !== null && (
          <div
            className="absolute inset-y-0 w-px bg-[var(--accent)]/80 z-[8]"
            style={{ left: sourcePlayhead * pxPerSec }}
            aria-hidden="true"
          />
        )}
      </div>

      {/* Trim handles — clamped so they stay fully visible within the lane */}
      <TrimHandle
        side="left"
        px={Math.max(0, inPx - HANDLE_W / 2) + HANDLE_W / 2}
        active={activeSide === "left"}
        onPointerDown={startDrag("left")}
        onKeyDown={(event) => adjustWithKeyboard("left", event)}
        label={`${track.name} trim start`}
        min={0}
        max={Math.max(0, effectiveOut - MIN_TRIM_GAP_SEC)}
        value={track.trimInSec}
      />
      <TrimHandle
        side="right"
        px={Math.min(laneWidth, outPx + HANDLE_W / 2) - HANDLE_W / 2}
        active={activeSide === "right"}
        onPointerDown={startDrag("right")}
        onKeyDown={(event) => adjustWithKeyboard("right", event)}
        label={`${track.name} trim end`}
        min={Math.min(safeDur, track.trimInSec + MIN_TRIM_GAP_SEC)}
        max={safeDur}
        value={effectiveOut}
      />

    </div>
  );
}

function TrimHandle({
  side,
  px,
  active,
  onPointerDown,
  onKeyDown,
  label,
  min,
  max,
  value,
}: {
  side: "left" | "right";
  px: number;
  active: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  label: string;
  min: number;
  max: number;
  value: number;
}) {
  const rounded = side === "left" ? "rounded-l-sm" : "rounded-r-sm";
  return (
    <div
      data-trim-handle
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={formatPreciseTime(value)}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: px - HANDLE_TARGET_W / 2,
        width: HANDLE_TARGET_W,
      }}
      className="cursor-ew-resize touch-none z-20 flex items-center justify-center"
    >
      <div
        className={`h-full flex items-center justify-center bg-amber-400 ${rounded} ${
          active ? "shadow-[0_0_0_3px_rgba(251,191,36,0.28)]" : ""
        }`}
        style={{ width: HANDLE_W }}
      >
        <div className="h-4 w-[2px] bg-black/50 rounded-full" />
      </div>
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

function formatPreciseTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  return `${s.toFixed(2)} seconds`;
}
