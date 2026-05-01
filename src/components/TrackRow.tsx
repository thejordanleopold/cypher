"use client";

import { useRef, useState } from "react";
import { useCypher, type TrackState } from "@/state/store";
import { Waveform } from "@/components/Waveform";
import { LiveWaveform } from "@/components/LiveWaveform";
import { InputPicker } from "@/components/InputPicker";
import { LevelMeter } from "@/components/LevelMeter";

export function TrackRow({ track }: { track: TrackState }) {
  const {
    importFile,
    setVolume,
    setPan,
    toggleMute,
    toggleSolo,
    toggleArm,
    removeTrack,
    isMultiRecording,
  } = useCypher();
  const fileRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const armDisabled = isMultiRecording;
  const isRecordingNow = isMultiRecording && track.armed;

  return (
    <article
      className={`rounded-lg border bg-neutral-900/60 transition-colors ${
        isRecordingNow
          ? "border-red-600/60 ring-1 ring-red-600/40"
          : track.armed
          ? "border-red-900/70"
          : "border-neutral-800"
      }`}
      aria-label={track.name}
    >
      {/* Header — always visible */}
      <header className="flex items-center gap-1.5 px-3 pt-2.5 pb-2">
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="h-8 w-8 -ml-1 mr-0.5 rounded-md text-neutral-500 hover:text-neutral-200 active:scale-95 flex items-center justify-center shrink-0"
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
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-neutral-100 truncate leading-tight">
            {track.name}
          </div>
          <div className="text-[11px] text-neutral-500 truncate leading-tight">
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
        <button
          onClick={() => removeTrack(track.id)}
          className="h-8 w-8 ml-0.5 rounded-md text-neutral-600 hover:text-red-400 active:scale-95 flex items-center justify-center shrink-0"
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
          <div className="px-3 pb-2 space-y-2">
            <div className="flex gap-1.5">
              <div className="flex-1 min-w-0">
                <InputPicker
                  trackId={track.id}
                  selectedDeviceId={track.inputDeviceId}
                  disabled={isMultiRecording}
                />
              </div>
              <button
                onClick={() => fileRef.current?.click()}
                className="h-9 px-3 rounded-md bg-neutral-800 text-neutral-100 text-xs font-medium active:scale-95 shrink-0"
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

            <div className="grid grid-cols-2 gap-3">
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
      <div className="px-3 pb-3">
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
      className={`h-9 w-9 rounded-md text-xs font-bold flex items-center justify-center active:scale-95 transition-colors shrink-0 ${
        active ? activeClass : "bg-neutral-800 text-neutral-300"
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
    <label className="flex items-center gap-2 min-w-0">
      <span className="text-[10px] uppercase tracking-wider text-neutral-500 w-3 shrink-0">
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
        className="flex-1 accent-emerald-500 min-w-0"
      />
      <span className="text-[10px] tabular-nums text-neutral-500 w-7 text-right shrink-0">
        {formatValue(value)}
      </span>
    </label>
  );
}
