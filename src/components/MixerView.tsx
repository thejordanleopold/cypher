"use client";

import { useCallback, useRef } from "react";
import { useCypher, type TrackState } from "@/state/store";
import { LevelMeter } from "@/components/LevelMeter";
import { AddTrackButton } from "@/components/AddTrackButton";

const VOL_MIN = 0;
const VOL_MAX = 1.5;
const STRIP_HEIGHT = 360; // px — caps mixer strip card height

export function MixerView() {
  const tracks = useCypher((s) => s.tracks);

  return (
    <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
      <div className="flex items-start gap-1.5 px-3 pt-2 pb-[max(env(safe-area-inset-bottom),0.75rem)] min-w-min">
        {tracks.map((t) => (
          <ChannelStrip key={t.id} track={t} />
        ))}
        <AddTrackButton variant="strip" stripHeight={STRIP_HEIGHT} />
      </div>
    </div>
  );
}

function ChannelStrip({ track }: { track: TrackState }) {
  const setVolume = useCypher((s) => s.setVolume);
  const setPan = useCypher((s) => s.setPan);
  const toggleMute = useCypher((s) => s.toggleMute);
  const toggleSolo = useCypher((s) => s.toggleSolo);
  const toggleArm = useCypher((s) => s.toggleArm);
  const toggleNormalize = useCypher((s) => s.toggleNormalize);
  const isMultiRecording = useCypher((s) => s.isMultiRecording);
  const isRecordingNow = isMultiRecording && track.armed;

  return (
    <div
      style={{ height: STRIP_HEIGHT }}
      className={`glass shrink-0 w-[92px] rounded-xl flex flex-col gap-1.5 px-2 pt-2 pb-2.5 transition-colors ${
        isRecordingNow
          ? "!border-red-500/60 ring-1 ring-red-500/40"
          : track.armed
          ? "!border-red-500/30"
          : ""
      }`}
      aria-label={track.name}
    >
      {/* Track name */}
      <div className="font-[family-name:var(--font-bebas)] tracking-[0.08em] text-xs text-[var(--text-primary)] truncate text-center leading-none">
        {track.name}
      </div>

      {/* Pan */}
      <div className="flex flex-col items-center gap-0.5">
        <span className="text-[8px] uppercase tracking-[0.18em] text-[var(--text-faint)] leading-none">
          Pan
        </span>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.01}
          value={track.pan}
          onChange={(e) => setPan(track.id, Number(e.target.value))}
          aria-label={`Pan ${track.name}`}
          className="w-full"
        />
        <span className="text-[9px] tabular-nums text-[var(--text-faint)] leading-none">
          {track.pan === 0
            ? "C"
            : track.pan < 0
            ? `L${Math.round(-track.pan * 100)}`
            : `R${Math.round(track.pan * 100)}`}
        </span>
      </div>

      {/* M / S / R / N */}
      <div className="grid grid-cols-4 gap-0.5">
        <ChannelToggle
          active={track.muted}
          onClick={() => toggleMute(track.id)}
          ariaLabel="Mute"
          activeClass="bg-amber-500 text-black"
        >
          M
        </ChannelToggle>
        <ChannelToggle
          active={track.soloed}
          onClick={() => toggleSolo(track.id)}
          ariaLabel="Solo"
          activeClass="bg-cyan-400 text-black"
        >
          S
        </ChannelToggle>
        <ChannelToggle
          active={track.armed}
          onClick={() => toggleArm(track.id)}
          disabled={isMultiRecording}
          ariaLabel="Arm for recording"
          activeClass="bg-red-600 text-white"
        >
          R
        </ChannelToggle>
        <ChannelToggle
          active={track.normalized}
          onClick={() => toggleNormalize(track.id)}
          disabled={!track.hasAudio}
          ariaLabel={
            track.normalized
              ? "Remove normalization"
              : "Normalize peak to -1 dBFS"
          }
          activeClass="bg-[var(--accent)] text-[#031024]"
        >
          N
        </ChannelToggle>
      </div>

      {/* Vertical fader + meter */}
      <div className="flex-1 min-h-0 flex justify-center gap-2 mt-1">
        <VerticalFader
          value={track.volume}
          onChange={(v) => setVolume(track.id, v)}
          label={`Volume ${track.name}`}
        />
        <div className="w-1.5 self-stretch flex">
          <LevelMeter trackId={track.id} />
        </div>
      </div>

      {/* Volume readout */}
      <div className="text-[10px] tabular-nums text-[var(--text-muted)] text-center leading-none">
        {formatGain(track.volume)} dB
      </div>
    </div>
  );
}

function ChannelToggle({
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
      className={`h-6 rounded text-[10px] font-bold flex items-center justify-center active:scale-95 transition-colors ${
        active
          ? activeClass
          : "bg-white/[0.05] hover:bg-white/[0.09] border border-[var(--border-subtle)] text-[var(--text-muted)]"
      } ${disabled ? "opacity-40" : ""}`}
    >
      {children}
    </button>
  );
}

function VerticalFader({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  label: string;
}) {
  const railRef = useRef<HTMLDivElement>(null);

  const updateFromY = useCallback(
    (clientY: number) => {
      const rail = railRef.current;
      if (!rail) return;
      const r = rail.getBoundingClientRect();
      const ratio = 1 - Math.max(0, Math.min(1, (clientY - r.top) / r.height));
      const v = VOL_MIN + ratio * (VOL_MAX - VOL_MIN);
      onChange(Number(v.toFixed(3)));
    },
    [onChange],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    railRef.current?.setPointerCapture(e.pointerId);
    updateFromY(e.clientY);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!railRef.current?.hasPointerCapture(e.pointerId)) return;
    updateFromY(e.clientY);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    railRef.current?.releasePointerCapture(e.pointerId);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      onChange(Math.min(VOL_MAX, value + step));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      onChange(Math.max(VOL_MIN, value - step));
    } else if (e.key === "Home") {
      e.preventDefault();
      onChange(VOL_MIN);
    } else if (e.key === "End") {
      e.preventDefault();
      onChange(VOL_MAX);
    }
  };

  // Position from bottom: 0 = bottom, max = top.
  const ratio = (value - VOL_MIN) / (VOL_MAX - VOL_MIN);
  const fromBottomPct = ratio * 100;
  // Unity (1.0) gridline reference.
  const unityPct = ((1 - VOL_MIN) / (VOL_MAX - VOL_MIN)) * 100;

  return (
    <div
      ref={railRef}
      role="slider"
      aria-label={label}
      aria-valuemin={VOL_MIN}
      aria-valuemax={VOL_MAX}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      className="relative w-7 h-full select-none touch-none cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
    >
      {/* Track */}
      <div className="absolute left-1/2 top-1 bottom-1 -translate-x-1/2 w-1 rounded-full bg-white/[0.08] border border-[var(--border-subtle)]" />
      {/* Filled portion */}
      <div
        className="absolute left-1/2 -translate-x-1/2 w-1 rounded-full bg-gradient-to-t from-[var(--accent-deep)] to-[var(--accent)]"
        style={{
          bottom: `calc(0.25rem)`,
          height: `calc((100% - 0.5rem) * ${ratio})`,
        }}
      />
      {/* Unity tick */}
      <div
        className="absolute left-0 right-0 h-px bg-[var(--border-strong)]"
        style={{ bottom: `calc(0.25rem + (100% - 0.5rem) * ${unityPct / 100})` }}
        aria-hidden="true"
      />
      {/* Thumb */}
      <div
        className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 w-6 h-3 rounded-[3px] bg-gradient-to-b from-[#cfe1ff] to-[var(--accent)] border border-[#0a1228] shadow-[0_2px_6px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.4)] pointer-events-none"
        style={{ bottom: `calc(0.25rem + (100% - 0.5rem) * ${fromBottomPct / 100})` }}
      />
    </div>
  );
}

function formatGain(v: number): string {
  if (v <= 0) return "-∞";
  const db = 20 * Math.log10(v);
  if (db > 0) return `+${db.toFixed(1)}`;
  return db.toFixed(1);
}
