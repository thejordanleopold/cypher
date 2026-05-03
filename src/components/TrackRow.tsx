"use client";

import { useRef, useState } from "react";
import { useCypher, MAX_INPUT_GAIN, type TrackState } from "@/state/store";
import { Waveform } from "@/components/Waveform";
import { LiveWaveform } from "@/components/LiveWaveform";
import { InputPicker } from "@/components/InputPicker";
import { LevelMeter } from "@/components/LevelMeter";
import { SamplerPads } from "@/components/SamplerPads";

export function TrackRow({ track }: { track: TrackState }) {
  const {
    importFile,
    setVolume,
    setPan,
    setInputGain,
    toggleMute,
    toggleSolo,
    toggleArm,
    toggleNormalize,
    removeTrack,
    setTrackMode,
    isMultiRecording,
  } = useCypher();
  const fileRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const armDisabled = isMultiRecording;
  const isRecordingNow = isMultiRecording && track.armed;
  const swipeRef = useRef<{ x: number; y: number; id: number } | null>(null);

  function onSwipeStart(e: React.PointerEvent) {
    const el = e.target as HTMLElement;
    if (el.closest('input, [role="slider"], [data-trim-handle]')) return;
    // In audio mode, ignore button-originated swipes so taps on header
    // controls don't sometimes register as a mode switch. In sampler mode,
    // pads ARE buttons — allow swipes from them so users can swipe back to
    // audio mode without hunting for the gap between pads (the pad still
    // triggers on pointerdown; the mode switch only fires past 64px of
    // horizontal motion, well beyond a tap).
    if (track.mode === 'audio' && el.closest('button')) return;
    swipeRef.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
  }

  function onSwipeMove(e: React.PointerEvent) {
    const sw = swipeRef.current;
    if (!sw || sw.id !== e.pointerId) return;
    const dx = e.clientX - sw.x;
    const dy = e.clientY - sw.y;
    if (Math.abs(dx) > 64 && Math.abs(dy) < 36) {
      swipeRef.current = null;
      if (dx > 0 && track.mode === 'audio' && track.hasAudio) {
        setTrackMode(track.id, 'sampler');
      } else if (dx < 0 && track.mode === 'sampler') {
        setTrackMode(track.id, 'audio');
      }
    }
  }

  function onSwipeEnd() {
    swipeRef.current = null;
  }

  return (
    <article
      className={`glass rounded-xl transition-colors ${
        isRecordingNow
          ? "!border-red-500/60 ring-1 ring-red-500/40"
          : track.armed
          ? "!border-red-500/30"
          : ""
      }`}
      aria-label={track.name}
    >
      {/* Header — always visible */}
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
            {track.hasAudio
              ? `${track.fileName} · ${track.durationSec.toFixed(1)}s`
              : "no audio"}
          </div>
        </div>
        {isRecordingNow && <LevelMeter trackId={track.id} />}
        {track.mode === 'sampler' && (
          <button
            onClick={() => setTrackMode(track.id, 'audio')}
            className="h-7 px-1.5 rounded-md bg-violet-500/20 border border-violet-500/40 text-violet-300 text-[9px] font-bold uppercase tracking-widest shrink-0 active:scale-95 transition-colors hover:bg-violet-500/30"
            aria-label="Exit sampler mode"
            title="Exit sampler — swipe left to exit"
          >
            SMPLR
          </button>
        )}
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
          active={track.armed}
          activeClass="bg-red-600 text-white"
          ariaLabel="Arm for recording"
          disabled={armDisabled}
          onClick={() => toggleArm(track.id)}
        >
          R
        </ToggleButton>
        <ToggleButton
          active={track.normalized}
          activeClass="bg-[var(--accent)] text-[#031024]"
          ariaLabel={
            track.normalized
              ? "Remove normalization"
              : "Normalize peak to -1 dBFS"
          }
          disabled={!track.hasAudio}
          onClick={() => toggleNormalize(track.id)}
        >
          N
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

      {/* Collapsible body */}
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${
          collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="px-2.5 pb-1.5 space-y-1">
            <div className="flex gap-1">
              <div className="flex-1 min-w-0">
                <InputPicker
                  trackId={track.id}
                  selectedDeviceId={track.inputDeviceId}
                  disabled={isMultiRecording}
                />
              </div>
              <button
                onClick={() => fileRef.current?.click()}
                className="h-7 px-2.5 rounded-md bg-white/[0.06] hover:bg-white/[0.1] border border-[var(--border-subtle)] text-[var(--text-primary)] text-[11px] font-medium active:scale-95 shrink-0 transition-colors"
              >
                {track.hasAudio ? "Replace" : "Import"}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/ogg,audio/*"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) await importFile(track.id, f);
                  e.target.value = "";
                }}
              />
            </div>

            <div className="grid grid-cols-3 gap-2">
              <SliderRow
                label="Mic gain"
                short="G"
                value={track.inputGain}
                min={0}
                max={MAX_INPUT_GAIN}
                step={0.1}
                onChange={(v) => setInputGain(track.id, v)}
                formatValue={(v) => `${v.toFixed(1)}×`}
              />
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
          </div>
        </div>
      </div>

      {/* Waveform / Sampler — always visible so collapsed cards still show audio */}
      <div
        className="px-2.5 pb-2 touch-pan-y"
        onPointerDown={onSwipeStart}
        onPointerMove={onSwipeMove}
        onPointerUp={onSwipeEnd}
        onPointerCancel={onSwipeEnd}
      >
        {isRecordingNow ? (
          <LiveWaveform trackId={track.id} />
        ) : track.mode === 'sampler' && track.hasAudio ? (
          <SamplerPads track={track} />
        ) : (
          track.hasAudio && (
            <Waveform
              trackId={track.id}
              hasAudio={track.hasAudio}
              bufferRevision={track.bufferRevision}
              trimInSec={track.trimInSec}
              trimOutSec={track.trimOutSec}
              durationSec={track.durationSec}
            />
          )
        )}
      </div>
    </article>
  );
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
      <span className="text-[9px] tabular-nums text-[var(--text-faint)] w-7 text-right shrink-0">
        {formatValue(value)}
      </span>
    </label>
  );
}
