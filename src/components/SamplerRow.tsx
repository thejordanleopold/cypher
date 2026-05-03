"use client";

import { useRef, useState } from "react";
import {
  useCypher,
  SAMPLER_PAD_COUNT,
  SAMPLER_STEP_COUNT,
  type SamplerPadState,
  type TrackState,
} from "@/state/store";

export function SamplerRow({ track }: { track: TrackState }) {
  const setVolume = useCypher((s) => s.setVolume);
  const setPan = useCypher((s) => s.setPan);
  const toggleMute = useCypher((s) => s.toggleMute);
  const toggleSolo = useCypher((s) => s.toggleSolo);
  const removeTrack = useCypher((s) => s.removeTrack);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <article className="glass rounded-xl" aria-label={track.name}>
      <header className="flex items-center gap-1 px-2.5 pt-1.5 pb-1">
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="h-7 w-7 -ml-1 rounded-md text-[var(--text-faint)] hover:text-[var(--text-primary)] active:scale-95 flex items-center justify-center shrink-0 transition-colors"
          aria-label={collapsed ? `Expand ${track.name}` : `Collapse ${track.name}`}
          aria-expanded={!collapsed}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={`transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`}
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
        <div className="min-w-0 flex-1 flex items-baseline gap-2">
          <div className="font-[family-name:var(--font-bebas)] tracking-[0.08em] text-sm text-[var(--text-primary)] truncate leading-none shrink-0">
            {track.name}
          </div>
          <div className="text-[10px] text-[var(--text-faint)] truncate leading-none">
            sampler · {track.pads.filter((p) => p.hasAudio).length}/{SAMPLER_PAD_COUNT} loaded
          </div>
        </div>
        <ToggleButton
          active={track.muted}
          activeClass="bg-amber-500 text-black"
          ariaLabel="Mute"
          onClick={() => toggleMute(track.id)}
        >
          M
        </ToggleButton>
        <ToggleButton
          active={track.soloed}
          activeClass="bg-cyan-400 text-black"
          ariaLabel="Solo"
          onClick={() => toggleSolo(track.id)}
        >
          S
        </ToggleButton>
        <button
          onClick={() => removeTrack(track.id)}
          className="h-7 w-7 rounded-md text-[var(--text-faint)] hover:text-red-400 active:scale-95 flex items-center justify-center shrink-0 transition-colors"
          aria-label={`Remove ${track.name}`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </header>

      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${
          collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="px-2.5 pb-2 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <SliderRow
                label="Volume"
                short="V"
                value={track.volume}
                min={0}
                max={1.5}
                step={0.01}
                onChange={(v) => setVolume(track.id, v)}
                formatValue={(v) => v.toFixed(2)}
              />
              <SliderRow
                label="Pan"
                short="P"
                value={track.pan}
                min={-1}
                max={1}
                step={0.01}
                onChange={(v) => setPan(track.id, v)}
                formatValue={(v) =>
                  v === 0
                    ? "C"
                    : v < 0
                    ? `L${Math.round(-v * 100)}`
                    : `R${Math.round(v * 100)}`
                }
              />
            </div>
            <PadGrid trackId={track.id} pads={track.pads} />
            <PatternGrid trackId={track.id} pattern={track.pattern} />
          </div>
        </div>
      </div>
    </article>
  );
}

function PadGrid({
  trackId,
  pads,
}: {
  trackId: string;
  pads: SamplerPadState[];
}) {
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {pads.map((pad, i) => (
        <Pad key={i} trackId={trackId} padIdx={i} pad={pad} />
      ))}
    </div>
  );
}

function Pad({
  trackId,
  padIdx,
  pad,
}: {
  trackId: string;
  padIdx: number;
  pad: SamplerPadState;
}) {
  const triggerPad = useCypher((s) => s.triggerPad);
  const loadPadSample = useCypher((s) => s.loadPadSample);
  const clearPadSample = useCypher((s) => s.clearPadSample);
  const pushToast = useCypher((s) => s.pushToast);
  const patternRecording = useCypher((s) => s.patternRecording);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastTapRef = useRef(0);
  const [active, setActive] = useState(false);

  const isCapturing = patternRecording === trackId;

  const handleFile = async (file: File) => {
    try {
      await loadPadSample(trackId, padIdx, file);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not load that file";
      pushToast({
        variant: "error",
        title: `Pad ${padIdx + 1}: load failed`,
        message,
        ttlMs: 8000,
      });
    }
  };

  const onTap = () => {
    const now = performance.now();
    const isDoubleTap = now - lastTapRef.current < 300;
    lastTapRef.current = now;
    if (isDoubleTap) {
      lastTapRef.current = 0;
      fileRef.current?.click();
      return;
    }
    if (!pad.hasAudio) {
      fileRef.current?.click();
      return;
    }
    setActive(true);
    void triggerPad(trackId, padIdx);
    window.setTimeout(() => setActive(false), 120);
  };

  return (
    <div className="relative">
      <button
        onPointerDown={(e) => {
          e.preventDefault();
          onTap();
        }}
        aria-label={
          pad.hasAudio
            ? `Trigger pad ${padIdx + 1}: ${pad.fileName ?? "sample"} (double-tap to replace)`
            : `Pad ${padIdx + 1} — tap to load a sample`
        }
        className={`w-full aspect-square rounded-lg border text-[10px] font-medium flex flex-col items-center justify-center gap-0.5 transition-colors select-none touch-none ${
          active
            ? "bg-[var(--accent)] text-[#031024] border-[var(--accent)]"
            : isCapturing && pad.hasAudio
            ? "bg-white/[0.08] hover:bg-white/[0.12] border-red-500/50 text-[var(--text-primary)] ring-1 ring-red-500/30"
            : pad.hasAudio
            ? "bg-white/[0.08] hover:bg-white/[0.12] border-[var(--border-subtle)] text-[var(--text-primary)]"
            : "bg-white/[0.03] hover:bg-white/[0.06] border-dashed border-[var(--border-subtle)] text-[var(--text-faint)]"
        }`}
      >
        <span className="text-[9px] uppercase tracking-[0.16em] opacity-70">
          {padIdx + 1}
        </span>
        <span className="px-1 truncate max-w-full text-[10px] leading-tight">
          {pad.hasAudio ? padLabel(pad.fileName) : "+"}
        </span>
      </button>
      {/* Upload button — top-left */}
      <button
        onPointerDown={(e) => {
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          fileRef.current?.click();
        }}
        aria-label={
          pad.hasAudio
            ? `Replace sample on pad ${padIdx + 1}`
            : `Load sample to pad ${padIdx + 1}`
        }
        className="absolute top-0.5 left-0.5 w-4 h-4 rounded text-[var(--text-faint)] hover:text-[var(--text-primary)] hover:bg-black/40 flex items-center justify-center"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 16V4M6 10l6-6 6 6M4 20h16" />
        </svg>
      </button>
      {/* Clear button — top-right */}
      {pad.hasAudio && (
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            clearPadSample(trackId, padIdx);
          }}
          aria-label={`Clear pad ${padIdx + 1}`}
          className="absolute top-0.5 right-0.5 w-4 h-4 rounded text-[var(--text-faint)] hover:text-red-400 hover:bg-black/40 flex items-center justify-center text-[10px] leading-none"
        >
          ×
        </button>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/ogg,audio/*"
        className="sr-only"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          const input = e.target;
          if (f) await handleFile(f);
          input.value = "";
        }}
      />
    </div>
  );
}

function PatternGrid({
  trackId,
  pattern,
}: {
  trackId: string;
  pattern: boolean[][];
}) {
  const togglePatternStep = useCypher((s) => s.togglePatternStep);
  const clearPattern = useCypher((s) => s.clearPattern);
  const togglePatternRecording = useCypher((s) => s.togglePatternRecording);
  const patternRecording = useCypher((s) => s.patternRecording);
  const isPlaying = useCypher((s) => s.isPlaying);
  const isRecording = patternRecording === trackId;

  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[9px] uppercase tracking-[0.16em] text-[var(--text-faint)] flex-1">
          Pattern
        </span>
        {/* REC button — captures live pad taps into the grid while playing */}
        <button
          onClick={() => togglePatternRecording(trackId)}
          aria-pressed={isRecording}
          aria-label={
            isRecording
              ? "Stop pattern recording"
              : "Record pad hits into pattern"
          }
          title={
            isRecording
              ? "Stop recording pad hits"
              : isPlaying
              ? "Tap pads to record hits into the pattern"
              : "Start transport first, then tap pads to record"
          }
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-[0.1em] transition-colors ${
            isRecording
              ? "bg-red-600 text-white animate-pulse"
              : "bg-white/[0.05] hover:bg-white/[0.09] border border-[var(--border-subtle)] text-[var(--text-muted)]"
          }`}
        >
          <span className={`block w-1.5 h-1.5 rounded-full ${isRecording ? "bg-white" : "bg-red-500"}`} />
          REC
        </button>
        <button
          onClick={() => clearPattern(trackId)}
          className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-faint)] hover:text-[var(--text-primary)] px-1.5 py-0.5 rounded hover:bg-white/[0.06] border border-transparent hover:border-[var(--border-subtle)] transition-colors"
        >
          Clear
        </button>
      </div>
      {/* Scrollable 8×16 grid */}
      <div className="overflow-x-auto -mx-0.5 px-0.5">
        <div className="inline-block min-w-full">
          {Array.from({ length: SAMPLER_PAD_COUNT }, (_, padIdx) => (
            <div key={padIdx} className="flex items-center gap-0.5 mb-0.5">
              <span className="text-[8px] text-[var(--text-faint)] w-3 shrink-0 text-right tabular-nums">
                {padIdx + 1}
              </span>
              <div className="flex gap-0.5 ml-0.5">
                {Array.from({ length: SAMPLER_STEP_COUNT }, (_, step) => {
                  const on = pattern[padIdx]?.[step] ?? false;
                  const beatStart = step % 4 === 0;
                  return (
                    <button
                      key={step}
                      onClick={() => togglePatternStep(trackId, padIdx, step)}
                      aria-label={`Pad ${padIdx + 1} step ${step + 1} ${on ? "on" : "off"}`}
                      aria-pressed={on}
                      className={`w-5 h-5 rounded-sm transition-colors shrink-0 ${
                        on
                          ? "bg-[var(--accent)] hover:opacity-80"
                          : beatStart
                          ? "bg-white/[0.09] hover:bg-white/[0.16] border border-[var(--border-subtle)]"
                          : "bg-white/[0.04] hover:bg-white/[0.10] border border-[var(--border-subtle)]/50"
                      }`}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function padLabel(fileName: string | null): string {
  if (!fileName) return "sample";
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  return stem.length > 10 ? `${stem.slice(0, 9)}…` : stem;
}

function ToggleButton({
  active,
  activeClass,
  ariaLabel,
  onClick,
  disabled,
  children,
}: {
  active: boolean;
  activeClass: string;
  ariaLabel: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={active}
      className={`h-7 w-7 rounded-md text-[11px] font-bold flex items-center justify-center active:scale-95 transition-colors shrink-0 ${
        active
          ? activeClass
          : "bg-white/[0.05] hover:bg-white/[0.09] border border-[var(--border-subtle)] text-[var(--text-muted)]"
      } ${disabled ? "opacity-40" : ""}`}
    >
      {children}
    </button>
  );
}

function SliderRow({
  label,
  short,
  value,
  min,
  max,
  step,
  onChange,
  formatValue,
}: {
  label: string;
  short: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  formatValue: (v: number) => string;
}) {
  return (
    <label className="flex items-center gap-1 min-w-0">
      <span className="text-[9px] uppercase tracking-[0.16em] text-[var(--text-faint)] w-2.5 shrink-0">
        {short}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        className="flex-1 min-w-0"
      />
      <span className="text-[9px] tabular-nums text-[var(--text-faint)] w-10 text-right shrink-0">
        {formatValue(value)}
      </span>
    </label>
  );
}
