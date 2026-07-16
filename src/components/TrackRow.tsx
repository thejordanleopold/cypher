"use client";

import { memo, useRef, useState } from "react";
import { useCypher, MAX_INPUT_GAIN, type TrackState } from "@/state/store";
import { Waveform } from "@/components/Waveform";
import { LiveWaveform } from "@/components/LiveWaveform";
import { InputPicker } from "@/components/InputPicker";
import { LevelMeter } from "@/components/LevelMeter";
import { ReorderGrip } from "@/components/ReorderGrip";

export const TrackRow = memo(function TrackRow({
  track,
  onDragStart,
  onMove,
}: {
  track: TrackState;
  onDragStart?: (trackId: string, pointerX: number, pointerY: number) => void;
  onMove?: (trackId: string, direction: -1 | 1) => void;
}) {
  const importFile = useCypher((state) => state.importFile);
  const setVolume = useCypher((state) => state.setVolume);
  const setPan = useCypher((state) => state.setPan);
  const setInputGain = useCypher((state) => state.setInputGain);
  const toggleMute = useCypher((state) => state.toggleMute);
  const toggleSolo = useCypher((state) => state.toggleSolo);
  const toggleArm = useCypher((state) => state.toggleArm);
  const toggleNormalize = useCypher((state) => state.toggleNormalize);
  const removeTrack = useCypher((state) => state.removeTrack);
  const isMultiRecording = useCypher((state) => state.isMultiRecording);
  const isStartingRecording = useCypher((state) => state.isStartingRecording);
  const isFinalizingRecording = useCypher(
    (state) => state.isFinalizingRecording,
  );
  const fileRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const recordingControlsDisabled =
    isMultiRecording || isStartingRecording || isFinalizingRecording;
  const isRecordingNow = isMultiRecording && track.armed;
  const confirmRemove = () => {
    if (!window.confirm(`Delete "${track.name}"? You can undo this action.`)) return;
    void removeTrack(track.id);
  };

  return (
    <article
      data-track-id={track.id}
      className={`glass rounded-xl touch-pan-y transition-colors ${
        isRecordingNow
          ? "!border-red-500/60 ring-1 ring-red-500/40"
          : track.armed
          ? "!border-red-500/30"
          : ""
      }`}
      aria-label={track.name}
    >
      <header className="flex flex-wrap items-center gap-1 px-2.5 pt-1.5 pb-1">
        <button
          type="button"
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${track.name}`}
          aria-expanded={!collapsed}
          aria-controls={`track-body-${track.id}`}
          onClick={() => setCollapsed((value) => !value)}
          className="h-7 w-5 flex items-center justify-center shrink-0 text-[var(--text-faint)] hover:text-[var(--text-primary)] rounded-md"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`}>
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
        <div className="min-w-[7rem] flex-1 flex items-baseline gap-2">
          <div className="font-[family-name:var(--font-bebas)] tracking-[0.08em] text-sm text-[var(--text-primary)] truncate leading-none shrink-0">
            {track.name}
          </div>
          <div className="text-[10px] text-[var(--text-faint)] truncate leading-none">
            {track.hasAudio
              ? `${track.fileName} · ${track.durationSec.toFixed(1)}s`
              : "no audio"}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
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
            disabled={recordingControlsDisabled}
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
            type="button"
            onClick={confirmRemove}
            aria-label={`Delete ${track.name}`}
            title={`Delete ${track.name}`}
            className="h-7 w-7 rounded-md bg-white/[0.05] hover:bg-red-500/15 border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-red-300 flex items-center justify-center active:scale-95 transition-colors shrink-0"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 10v6M14 10v6" />
            </svg>
          </button>
          <ReorderGrip
            trackId={track.id}
            trackName={track.name}
            onDragStart={onDragStart}
            onMove={onMove}
          />
        </div>
      </header>

      {/* Collapsible body */}
      <div
        id={`track-body-${track.id}`}
        inert={collapsed}
        aria-hidden={collapsed ? "true" : undefined}
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
                  disabled={recordingControlsDisabled}
                />
              </div>
              <button
                disabled={recordingControlsDisabled}
                onClick={() => fileRef.current?.click()}
                className="h-7 px-2.5 rounded-md bg-white/[0.06] hover:bg-white/[0.1] border border-[var(--border-subtle)] text-[var(--text-primary)] text-[11px] font-medium active:scale-95 shrink-0 transition-colors disabled:opacity-40 disabled:pointer-events-none"
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
});

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
