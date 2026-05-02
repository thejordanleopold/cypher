"use client";

import { useCypher, type TrackState } from "@/state/store";
import { LevelMeter } from "@/components/LevelMeter";

export function MixerView() {
  const tracks = useCypher((s) => s.tracks);
  const addTrack = useCypher((s) => s.addTrack);

  return (
    <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
      <div className="flex items-stretch gap-1.5 px-3 pt-2 pb-[max(env(safe-area-inset-bottom),0.75rem)] min-w-min h-full">
        {tracks.map((t) => (
          <ChannelStrip key={t.id} track={t} />
        ))}
        <button
          onClick={() => addTrack()}
          aria-label="Add new track"
          className="glass shrink-0 w-12 max-h-[420px] rounded-xl text-[var(--text-faint)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] flex items-center justify-center transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
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
  const isMultiRecording = useCypher((s) => s.isMultiRecording);
  const isRecordingNow = isMultiRecording && track.armed;

  return (
    <div
      className={`glass shrink-0 w-[88px] h-full max-h-[420px] rounded-xl flex flex-col items-stretch gap-2 px-2 pt-2 pb-2.5 transition-colors ${
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
      <label className="flex flex-col items-center gap-0.5">
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
      </label>

      {/* M / S / R */}
      <div className="grid grid-cols-3 gap-0.5">
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
      </div>

      {/* Vertical fader + meter */}
      <div className="flex-1 min-h-[160px] flex items-stretch justify-center gap-1.5 mt-1">
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
        {formatGain(track.volume)}
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
  return (
    <input
      type="range"
      min={0}
      max={1.5}
      step={0.01}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      aria-label={label}
      className="vertical-fader"
      style={{
        writingMode: "vertical-lr",
        direction: "rtl",
        height: "100%",
        width: 24,
      }}
    />
  );
}

function formatGain(v: number): string {
  if (v <= 0) return "-∞";
  const db = 20 * Math.log10(v);
  if (db > 0) return `+${db.toFixed(1)}`;
  return db.toFixed(1);
}
