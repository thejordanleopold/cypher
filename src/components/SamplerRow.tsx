"use client";

import { useRef, useState } from "react";
import {
  useCypher,
  SAMPLER_PAD_COUNT,
  SAMPLER_BANK_SIZE,
  type SamplerPadState,
  type TrackState,
} from "@/state/store";

const BANK_LABELS = ["A", "B", "C", "D"] as const;

export function SamplerRow({ track }: { track: TrackState }) {
  const setVolume = useCypher((s) => s.setVolume);
  const setPan = useCypher((s) => s.setPan);
  const toggleMute = useCypher((s) => s.toggleMute);
  const toggleSolo = useCypher((s) => s.toggleSolo);
  const removeTrack = useCypher((s) => s.removeTrack);
  const armSamplerRecord = useCypher((s) => s.armSamplerRecord);
  const clearSamplerPattern = useCypher((s) => s.clearSamplerPattern);
  const isPlaying = useCypher((s) => s.isPlaying);
  const [collapsed, setCollapsed] = useState(false);
  const [activeBank, setActiveBank] = useState(0);

  const bankOffset = activeBank * SAMPLER_BANK_SIZE;
  const bankPads = track.pads.slice(bankOffset, bankOffset + SAMPLER_BANK_SIZE);
  const totalLoaded = track.pads.filter((p) => p.hasAudio).length;

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
            sampler · {totalLoaded}/{SAMPLER_PAD_COUNT} loaded
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
        <ToggleButton
          active={track.samplerRecArmed}
          activeClass="bg-red-600 text-white"
          ariaLabel={
            track.samplerRecArmed
              ? "Disable pattern recording"
              : "Enable pattern recording — pad hits will be recorded while transport plays"
          }
          onClick={() => armSamplerRecord(track.id)}
        >
          ●
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

      {/* Compact pad grid — visible only when collapsed */}
      {collapsed && (
        <div className="px-2.5 pb-2 pt-1">
          <div className="flex gap-1.5 items-stretch">
            <div className="flex-1 grid grid-cols-4 gap-1">
              {bankPads.map((pad, i) => (
                <CompactPad
                  key={bankOffset + i}
                  trackId={track.id}
                  padIdx={bankOffset + i}
                  pad={pad}
                />
              ))}
            </div>
            <div className="flex flex-col gap-1 w-6 shrink-0">
              {(BANK_LABELS as readonly string[]).map((label, i) => {
                const start = i * SAMPLER_BANK_SIZE;
                const hasContent = track.pads
                  .slice(start, start + SAMPLER_BANK_SIZE)
                  .some((p) => p.hasAudio);
                const isActive = i === activeBank;
                return (
                  <button
                    key={label}
                    onClick={() => setActiveBank(i)}
                    aria-label={`Bank ${label}`}
                    aria-pressed={isActive}
                    className={`flex-1 rounded text-[9px] font-bold tracking-wide flex flex-col items-center justify-center gap-0.5 transition-colors ${
                      isActive
                        ? "bg-[var(--accent)] text-[#031024]"
                        : "bg-white/[0.05] border border-[var(--border-subtle)] text-[var(--text-muted)] hover:bg-white/[0.09] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {label}
                    {hasContent && (
                      <span
                        className={`w-1 h-1 rounded-full ${
                          isActive ? "bg-[#031024]/50" : "bg-[var(--accent)]"
                        }`}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

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
            {(track.samplerRecArmed || track.samplerPattern.length > 0) && (
              <div className="flex items-center gap-2 text-[9px] leading-none">
                {track.samplerRecArmed && (
                  <span
                    className={`flex items-center gap-1 font-bold tracking-wider uppercase ${
                      isPlaying ? "text-red-400" : "text-[var(--text-muted)]"
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full bg-red-500 ${
                        isPlaying ? "animate-pulse" : "opacity-50"
                      }`}
                    />
                    {isPlaying ? "Recording" : "Rec armed"}
                  </span>
                )}
                {track.samplerPattern.length > 0 && (
                  <>
                    {track.samplerRecArmed && (
                      <span className="text-[var(--border-strong)]">·</span>
                    )}
                    <span className="text-[var(--text-faint)]">
                      {track.samplerPattern.length}{" "}
                      {track.samplerPattern.length === 1 ? "event" : "events"}
                    </span>
                    <button
                      onClick={() => clearSamplerPattern(track.id)}
                      className="text-[var(--text-faint)] hover:text-red-400 transition-colors uppercase tracking-wider"
                    >
                      Clear
                    </button>
                  </>
                )}
              </div>
            )}
            <div className="flex gap-1.5 items-stretch">
              <PadGrid trackId={track.id} pads={bankPads} bankOffset={bankOffset} />
              <div className="flex flex-col gap-1 w-7 shrink-0">
                {(BANK_LABELS as readonly string[]).map((label, i) => {
                  const start = i * SAMPLER_BANK_SIZE;
                  const hasContent = track.pads
                    .slice(start, start + SAMPLER_BANK_SIZE)
                    .some((p) => p.hasAudio);
                  const isActive = i === activeBank;
                  return (
                    <button
                      key={label}
                      onClick={() => setActiveBank(i)}
                      aria-label={`Bank ${label}`}
                      aria-pressed={isActive}
                      className={`flex-1 rounded-md text-[10px] font-bold tracking-wide flex flex-col items-center justify-center gap-0.5 transition-colors ${
                        isActive
                          ? "bg-[var(--accent)] text-[#031024]"
                          : "bg-white/[0.05] border border-[var(--border-subtle)] text-[var(--text-muted)] hover:bg-white/[0.09] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      {label}
                      {hasContent && (
                        <span
                          className={`w-1 h-1 rounded-full ${
                            isActive ? "bg-[#031024]/50" : "bg-[var(--accent)]"
                          }`}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

function PadGrid({
  trackId,
  pads,
  bankOffset,
}: {
  trackId: string;
  pads: SamplerPadState[];
  bankOffset: number;
}) {
  return (
    <div className="flex-1 grid grid-cols-4 gap-1.5">
      {pads.map((pad, i) => (
        <Pad key={bankOffset + i} trackId={trackId} padIdx={bankOffset + i} pad={pad} />
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
  const fileRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(false);

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

  // Every pointerdown fires immediately with no debounce or double-tap window
  // so finger-drumming layers cleanly. Replacement and clear are handled by
  // the dedicated corner buttons.
  const onTap = () => {
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
            ? `Trigger pad ${padIdx + 1}: ${pad.fileName ?? "sample"}`
            : `Pad ${padIdx + 1} — tap to load a sample`
        }
        className={`w-full aspect-square rounded-lg border text-[10px] font-medium flex flex-col items-center justify-center gap-0.5 transition-colors select-none touch-none ${
          active
            ? "bg-[var(--accent)] text-[#031024] border-[var(--accent)]"
            : pad.hasAudio
            ? "bg-white/[0.08] hover:bg-white/[0.12] border-[var(--border-subtle)] text-[var(--text-primary)]"
            : "bg-white/[0.03] hover:bg-white/[0.06] border-dashed border-[var(--border-subtle)] text-[var(--text-faint)]"
        }`}
      >
        <span className="text-[9px] uppercase tracking-[0.16em] opacity-70">
          {(padIdx % SAMPLER_BANK_SIZE) + 1}
        </span>
        <span className="px-1 truncate max-w-full text-[10px] leading-tight">
          {pad.hasAudio ? padLabel(pad.fileName) : "+"}
        </span>
      </button>
      <button
        onPointerDown={(e) => {
          // Stop the underlying pad's pointerdown from firing — without this
          // both buttons get a hit and the pad would trigger right before
          // the file picker opened.
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
          // Reset BEFORE awaiting so re-picking the same file fires a fresh
          // change event (browsers suppress duplicate selections), and so a
          // failure mid-load doesn't strand the input in a state that
          // refuses subsequent picks.
          e.target.value = "";
          if (f) await handleFile(f);
        }}
      />
    </div>
  );
}

function CompactPad({
  trackId,
  padIdx,
  pad,
}: {
  trackId: string;
  padIdx: number;
  pad: SamplerPadState;
}) {
  const triggerPad = useCypher((s) => s.triggerPad);
  const [active, setActive] = useState(false);

  const onTap = () => {
    if (!pad.hasAudio) return;
    setActive(true);
    void triggerPad(trackId, padIdx);
    window.setTimeout(() => setActive(false), 120);
  };

  return (
    <button
      onPointerDown={(e) => {
        e.preventDefault();
        onTap();
      }}
      aria-label={
        pad.hasAudio
          ? `Trigger pad ${(padIdx % SAMPLER_BANK_SIZE) + 1}: ${pad.fileName ?? "sample"}`
          : `Pad ${(padIdx % SAMPLER_BANK_SIZE) + 1} — empty`
      }
      className={`aspect-square rounded border text-[8px] flex flex-col items-center justify-center gap-px transition-colors select-none touch-none ${
        active
          ? "bg-[var(--accent)] text-[#031024] border-[var(--accent)]"
          : pad.hasAudio
          ? "bg-white/[0.08] hover:bg-white/[0.12] border-[var(--border-subtle)] text-[var(--text-muted)]"
          : "bg-white/[0.02] border-dashed border-[var(--border-subtle)] opacity-30"
      }`}
    >
      <span className="opacity-60 leading-none">{(padIdx % SAMPLER_BANK_SIZE) + 1}</span>
      {pad.hasAudio && (
        <span className="w-1 h-1 rounded-full bg-current opacity-50" />
      )}
    </button>
  );
}

function padLabel(fileName: string | null): string {
  if (!fileName) return "sample";
  // Strip extension and shrink to a chip-friendly width.
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
