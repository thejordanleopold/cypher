"use client";

import { useRef, useState } from "react";
import { useCypher, MAX_INPUT_GAIN, type TrackState } from "@/state/store";
import { Waveform } from "@/components/Waveform";
import { LiveWaveform } from "@/components/LiveWaveform";
import { InputPicker } from "@/components/InputPicker";
import { LevelMeter } from "@/components/LevelMeter";

export function TrackRow({
  track,
  onDragStart,
}: {
  track: TrackState;
  onDragStart?: (trackId: string, pointerX: number, pointerY: number) => void;
}) {
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
    isMultiRecording,
  } = useCypher();
  const fileRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const armDisabled = isMultiRecording;
  const isRecordingNow = isMultiRecording && track.armed;

  return (
    <article
      data-track-id={track.id}
      className={`glass rounded-xl transition-colors ${
        isRecordingNow
          ? "!border-red-500/60 ring-1 ring-red-500/40"
          : track.armed
          ? "!border-red-500/30"
          : ""
      }`}
      aria-label={track.name}
    >
      {/* Header — click to collapse, hold to drag */}
      <header
        className="flex items-center gap-1 px-2.5 pt-1.5 pb-1 cursor-pointer touch-none [&_button]:cursor-pointer"
        onPointerDown={(e) => {
          if ((e.target as Element).closest("button")) return;
          const startY = e.clientY;
          let currentX = e.clientX;
          let currentY = e.clientY;
          let didDrag = false;
          let scrollCancelled = false;

          const timer = setTimeout(() => {
            if (scrollCancelled) return;
            didDrag = true;
            cleanup();
            onDragStart?.(track.id, currentX, currentY);
          }, 260);

          const onMove = (mv: PointerEvent) => {
            currentX = mv.clientX;
            currentY = mv.clientY;
            if (!scrollCancelled && Math.abs(mv.clientY - startY) > 8) {
              scrollCancelled = true;
              clearTimeout(timer);
              cleanup();
            }
          };

          const onUp = () => {
            cleanup();
            if (!didDrag && !scrollCancelled) setCollapsed((v) => !v);
          };

          const cleanup = () => {
            clearTimeout(timer);
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
            document.removeEventListener("pointercancel", onUp);
          };

          document.addEventListener("pointermove", onMove);
          document.addEventListener("pointerup", onUp);
          document.addEventListener("pointercancel", onUp);
        }}
      >
        {/* Remove — left */}
        <button
          onClick={() => removeTrack(track.id)}
          className="-ml-1 h-7 w-7 rounded-md text-[var(--text-faint)] hover:text-red-400 active:scale-95 flex items-center justify-center shrink-0 transition-colors"
          aria-label={`Remove ${track.name}`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
        {/* Collapse indicator — visual only */}
        <div className="h-5 w-4 flex items-center justify-center shrink-0 pointer-events-none text-[var(--text-faint)]" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`}>
            <path d="M9 18l6-6-6-6" />
          </svg>
        </div>
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
        {/* Grip — right, visual affordance for hold-to-drag */}
        <div className="-mr-1 h-7 w-5 flex items-center justify-center shrink-0 pointer-events-none text-[var(--text-faint)]" aria-hidden="true">
          <GripIcon />
        </div>
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

      {/* Waveform — always visible so collapsed cards still tell you what's there */}
      <div className="px-2.5 pb-2">
        {isRecordingNow ? (
          <LiveWaveform trackId={track.id} />
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

function GripIcon() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="2.5" r="1.2" />
      <circle cx="7" cy="2.5" r="1.2" />
      <circle cx="3" cy="7"   r="1.2" />
      <circle cx="7" cy="7"   r="1.2" />
      <circle cx="3" cy="11.5" r="1.2" />
      <circle cx="7" cy="11.5" r="1.2" />
    </svg>
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
