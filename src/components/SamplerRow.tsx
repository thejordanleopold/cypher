"use client";

import { useEffect, useRef, useState } from "react";
import {
  useCypher,
  SAMPLER_PAD_COUNT,
  SAMPLER_STEP_COUNT,
  type SamplerPadState,
  type TrackState,
} from "@/state/store";
import { getEngine } from "@/audio/engine";

export function SamplerRow({ track }: { track: TrackState }) {
  const setVolume = useCypher((s) => s.setVolume);
  const setPan = useCypher((s) => s.setPan);
  const toggleMute = useCypher((s) => s.toggleMute);
  const toggleSolo = useCypher((s) => s.toggleSolo);
  const removeTrack = useCypher((s) => s.removeTrack);
  const [collapsed, setCollapsed] = useState(false);
  const [selectedPad, setSelectedPad] = useState<number | null>(null);

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

            <PadGrid
              trackId={track.id}
              pads={track.pads}
              selectedPad={selectedPad}
              onSelectPad={setSelectedPad}
            />

            {selectedPad !== null ? (
              <PadStepEditor
                trackId={track.id}
                padIdx={selectedPad}
                steps={track.pattern[selectedPad] ?? Array(SAMPLER_STEP_COUNT).fill(false)}
                padName={track.pads[selectedPad]?.fileName ?? null}
                onClose={() => setSelectedPad(null)}
              />
            ) : (
              <PatternOverview
                trackId={track.id}
                pattern={track.pattern}
                pads={track.pads}
                onSelectPad={setSelectedPad}
              />
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

// ---- Pad grid ----

function PadGrid({
  trackId,
  pads,
  selectedPad,
  onSelectPad,
}: {
  trackId: string;
  pads: SamplerPadState[];
  selectedPad: number | null;
  onSelectPad: (idx: number | null) => void;
}) {
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {pads.map((pad, i) => (
        <Pad
          key={i}
          trackId={trackId}
          padIdx={i}
          pad={pad}
          selected={selectedPad === i}
          onSelect={() => onSelectPad(selectedPad === i ? null : i)}
        />
      ))}
    </div>
  );
}

function Pad({
  trackId,
  padIdx,
  pad,
  selected,
  onSelect,
}: {
  trackId: string;
  padIdx: number;
  pad: SamplerPadState;
  selected: boolean;
  onSelect: () => void;
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
      pushToast({
        variant: "error",
        title: `Pad ${padIdx + 1}: load failed`,
        message: err instanceof Error ? err.message : "Could not load that file",
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
      if (pad.hasAudio) {
        // Double-tap loaded pad → open step sequencer for this pad
        onSelect();
      } else {
        fileRef.current?.click();
      }
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
            ? `Trigger pad ${padIdx + 1}: ${pad.fileName ?? "sample"} — double-tap to edit steps`
            : `Pad ${padIdx + 1} — tap to load a sample`
        }
        className={`w-full rounded-lg border text-[10px] font-medium flex flex-col items-start justify-between transition-colors select-none touch-none overflow-hidden ${
          active
            ? "bg-[var(--accent)] text-[#031024] border-[var(--accent)]"
            : selected
            ? "bg-[var(--accent)]/10 border-[var(--accent)]/60 ring-1 ring-[var(--accent)]/40 text-[var(--text-primary)]"
            : isCapturing && pad.hasAudio
            ? "bg-white/[0.08] border-red-500/50 text-[var(--text-primary)] ring-1 ring-red-500/30"
            : pad.hasAudio
            ? "bg-white/[0.08] hover:bg-white/[0.12] border-[var(--border-subtle)] text-[var(--text-primary)]"
            : "bg-white/[0.03] hover:bg-white/[0.06] border-dashed border-[var(--border-subtle)] text-[var(--text-faint)]"
        }`}
      >
        <div className="flex items-center justify-between w-full px-1.5 pt-1.5 pb-0.5">
          <span className="text-[9px] uppercase tracking-[0.16em] opacity-70 leading-none">
            {padIdx + 1}
          </span>
          <span className="px-0 truncate max-w-[70%] text-[9px] leading-none opacity-80 text-right">
            {pad.hasAudio ? padLabel(pad.fileName) : "+"}
          </span>
        </div>
        {/* Waveform area — double-tap hint when loaded */}
        <div className="w-full px-1 pb-1.5 min-h-[28px]">
          {pad.hasAudio ? (
            <PadWaveform
              trackId={trackId}
              padIdx={padIdx}
              bufferRevision={pad.bufferRevision}
              active={active}
              selected={selected}
            />
          ) : (
            <div className="h-6" />
          )}
        </div>
      </button>

      {/* Upload button — top-left corner */}
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          fileRef.current?.click();
        }}
        aria-label={pad.hasAudio ? `Replace sample on pad ${padIdx + 1}` : `Load sample to pad ${padIdx + 1}`}
        className="absolute top-0.5 left-0.5 w-4 h-4 rounded text-[var(--text-faint)] hover:text-[var(--text-primary)] hover:bg-black/40 flex items-center justify-center"
      >
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 16V4M6 10l6-6 6 6M4 20h16" />
        </svg>
      </button>

      {/* Clear button — top-right corner */}
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

// ---- Pad waveform ----

function PadWaveform({
  trackId,
  padIdx,
  bufferRevision,
  active,
  selected,
}: {
  trackId: string;
  padIdx: number;
  bufferRevision: number;
  active: boolean;
  selected: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const buf = getEngine().getPadBuffer(trackId, padIdx);
    if (!buf) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.offsetWidth || 80;
    const h = canvas.offsetHeight || 24;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const data = buf.getChannelData(0);
    const samplesPerPx = data.length / w;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = active ? "rgba(3,16,36,0.7)" : selected ? "rgba(124,182,255,0.8)" : "rgba(124,182,255,0.5)";

    for (let x = 0; x < w; x++) {
      const start = Math.floor(x * samplesPerPx);
      const end = Math.min(data.length, Math.floor((x + 1) * samplesPerPx));
      let peak = 0;
      for (let i = start; i < end; i++) {
        const abs = Math.abs(data[i]);
        if (abs > peak) peak = abs;
      }
      const barH = Math.max(1, peak * h * 0.9);
      ctx.fillRect(x, (h - barH) / 2, 1, barH);
    }
  }, [trackId, padIdx, bufferRevision, active, selected]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-6 rounded-sm"
      aria-hidden="true"
    />
  );
}

// ---- Per-pad step editor ----

function PadStepEditor({
  trackId,
  padIdx,
  steps,
  padName,
  onClose,
}: {
  trackId: string;
  padIdx: number;
  steps: boolean[];
  padName: string | null;
  onClose: () => void;
}) {
  const togglePatternStep = useCypher((s) => s.togglePatternStep);
  const clearPattern = useCypher((s) => s.clearPattern);
  const togglePatternRecording = useCypher((s) => s.togglePatternRecording);
  const patternRecording = useCypher((s) => s.patternRecording);
  const isRecording = patternRecording === trackId;

  return (
    <div className="rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)]/5 p-2 space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-medium text-[var(--text-primary)] flex-1 truncate">
          Pad {padIdx + 1}{padName ? ` · ${padLabel(padName)}` : ""}
        </span>
        <button
          onClick={() => togglePatternRecording(trackId)}
          aria-pressed={isRecording}
          aria-label={isRecording ? "Stop pattern recording" : "Record pad hits into pattern"}
          className={`flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-[0.1em] transition-colors ${
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
          title="Clear this row"
          className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-faint)] hover:text-[var(--text-primary)] px-1.5 py-0.5 rounded hover:bg-white/[0.06] border border-transparent hover:border-[var(--border-subtle)] transition-colors"
        >
          Clear
        </button>
        <button
          onClick={onClose}
          aria-label="Close step editor"
          className="w-5 h-5 rounded flex items-center justify-center text-[var(--text-faint)] hover:text-[var(--text-primary)] hover:bg-white/[0.06]"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* 16 steps grouped into 4 beats */}
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((beat) => (
          <div key={beat} className="flex gap-0.5 flex-1">
            {[0, 1, 2, 3].map((sub) => {
              const step = beat * 4 + sub;
              const on = steps[step] ?? false;
              return (
                <button
                  key={step}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    togglePatternStep(trackId, padIdx, step);
                  }}
                  aria-label={`Step ${step + 1} ${on ? "on" : "off"}`}
                  aria-pressed={on}
                  className={`flex-1 h-10 rounded-sm transition-colors touch-none select-none ${
                    on
                      ? "bg-[var(--accent)] hover:opacity-80"
                      : sub === 0
                      ? "bg-white/[0.10] hover:bg-white/[0.18] border border-[var(--border-subtle)]"
                      : "bg-white/[0.05] hover:bg-white/[0.12] border border-[var(--border-subtle)]/60"
                  }`}
                />
              );
            })}
          </div>
        ))}
      </div>

      {/* Step number labels */}
      <div className="flex gap-1 px-px">
        {[0, 1, 2, 3].map((beat) => (
          <div key={beat} className="flex gap-0.5 flex-1">
            {[0, 1, 2, 3].map((sub) => {
              const step = beat * 4 + sub;
              return (
                <span key={step} className="flex-1 text-center text-[7px] text-[var(--text-faint)] tabular-nums">
                  {step + 1}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Pattern overview ----

function PatternOverview({
  trackId,
  pattern,
  pads,
  onSelectPad,
}: {
  trackId: string;
  pattern: boolean[][];
  pads: SamplerPadState[];
  onSelectPad: (idx: number) => void;
}) {
  const togglePatternStep = useCypher((s) => s.togglePatternStep);
  const togglePatternRecording = useCypher((s) => s.togglePatternRecording);
  const clearPattern = useCypher((s) => s.clearPattern);
  const patternRecording = useCypher((s) => s.patternRecording);
  const isRecording = patternRecording === trackId;

  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[9px] uppercase tracking-[0.16em] text-[var(--text-faint)] flex-1">
          Pattern
        </span>
        <button
          onClick={() => togglePatternRecording(trackId)}
          aria-pressed={isRecording}
          aria-label={isRecording ? "Stop pattern recording" : "Record pad hits into pattern"}
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

      <div className="overflow-x-auto -mx-0.5 px-0.5">
        <div className="inline-block min-w-full">
          {Array.from({ length: SAMPLER_PAD_COUNT }, (_, padIdx) => {
            const hasAudio = pads[padIdx]?.hasAudio;
            return (
              <div key={padIdx} className="flex items-center gap-0.5 mb-0.5">
                {/* Pad label — tap to open step editor */}
                <button
                  onClick={() => onSelectPad(padIdx)}
                  title={`Edit steps for pad ${padIdx + 1}`}
                  className={`text-[8px] w-5 shrink-0 text-right tabular-nums rounded px-0.5 transition-colors ${
                    hasAudio
                      ? "text-[var(--text-primary)] hover:text-[var(--accent)] hover:bg-white/[0.06]"
                      : "text-[var(--text-faint)]"
                  }`}
                >
                  {padIdx + 1}
                </button>
                <div className="flex gap-0.5">
                  {Array.from({ length: SAMPLER_STEP_COUNT }, (_, step) => {
                    const on = pattern[padIdx]?.[step] ?? false;
                    const beatStart = step % 4 === 0;
                    return (
                      <button
                        key={step}
                        onClick={() => togglePatternStep(trackId, padIdx, step)}
                        aria-label={`Pad ${padIdx + 1} step ${step + 1} ${on ? "on" : "off"}`}
                        aria-pressed={on}
                        className={`w-5 h-4 rounded-sm transition-colors shrink-0 ${
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
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---- Helpers ----

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
