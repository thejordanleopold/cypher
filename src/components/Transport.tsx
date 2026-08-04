"use client";

import { useState } from "react";
import { canRunTransport } from "@/audio/project-time";
import { TIME_SIGNATURE_OPTIONS } from "@/audio/time-signature";
import { useCypher } from "@/state/store";

export function Transport() {
  const isPlaying = useCypher((state) => state.isPlaying);
  const play = useCypher((state) => state.play);
  const pause = useCypher((state) => state.pause);
  const stop = useCypher((state) => state.stop);
  const bpm = useCypher((state) => state.bpm);
  const setBpm = useCypher((state) => state.setBpm);
  const timeSignature = useCypher((state) => state.timeSignature);
  const setTimeSignature = useCypher((state) => state.setTimeSignature);
  const metronomeOn = useCypher((state) => state.metronomeOn);
  const toggleMetronome = useCypher((state) => state.toggleMetronome);
  const isMultiRecording = useCypher((state) => state.isMultiRecording);
  const isStartingRecording = useCypher((state) => state.isStartingRecording);
  const isFinalizingRecording = useCypher(
    (state) => state.isFinalizingRecording,
  );
  const startArmedRecording = useCypher((state) => state.startArmedRecording);
  const stopArmedRecording = useCypher((state) => state.stopArmedRecording);
  const countInBeats = useCypher((state) => state.countInBeats);
  const setCountInBeats = useCypher((state) => state.setCountInBeats);
  const countdownActive = useCypher((state) => state.countdownActive);
  const countdownBeat = useCypher((state) => state.countdownBeat);
  const cancelCountdown = useCypher((state) => state.cancelCountdown);
  const undo = useCypher((state) => state.undo);
  const redo = useCypher((state) => state.redo);
  const canUndo = useCypher(
    (s) => s.undoStack.length > 0 && !s.isApplyingHistory,
  );
  const canRedo = useCypher(
    (s) => s.redoStack.length > 0 && !s.isApplyingHistory,
  );
  const transportCanRun = useCypher((state) => canRunTransport(state.tracks));
  const armedCount = useCypher(
    (state) =>
      state.tracks.filter((track) => track.kind !== "sampler" && track.armed)
        .length,
  );
  const emptyCount = useCypher(
    (state) =>
      state.tracks.filter(
        (track) => track.kind !== "sampler" && !track.hasAudio,
      ).length,
  );
  const willRecordCount = armedCount > 0 ? armedCount : emptyCount;
  const playDisabled = !isPlaying && !transportCanRun;
  const recordDisabled = willRecordCount === 0 && !transportCanRun;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-center gap-2 px-2 py-2 sm:flex-nowrap sm:px-4 lg:px-5 lg:py-3">
        <div className="flex items-center gap-1 sm:gap-2">
        <button
          disabled={playDisabled}
          onClick={() => (isPlaying ? pause() : play())}
          title={playDisabled ? "Add or record audio to play" : undefined}
          className="h-9 w-9 sm:h-10 sm:w-10 rounded-full bg-gradient-to-b from-[#7cb6ff] to-[#3b82f6] text-[#031024] flex items-center justify-center active:scale-95 shrink-0 shadow-[0_4px_14px_-4px_rgba(59,130,246,0.6)] disabled:opacity-40 disabled:pointer-events-none"
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M7 4.5v15a1 1 0 0 0 1.5.87l13-7.5a1 1 0 0 0 0-1.74l-13-7.5A1 1 0 0 0 7 4.5z" />
            </svg>
          )}
        </button>
        <button
          onClick={() => stop()}
          className="h-9 w-9 sm:h-10 sm:w-10 rounded-full bg-white/[0.06] hover:bg-white/[0.1] border border-[var(--border-subtle)] text-[var(--text-primary)] flex items-center justify-center active:scale-95 shrink-0 transition-colors"
          aria-label="Stop"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="1.5" />
          </svg>
        </button>
        <button
          disabled={
            isFinalizingRecording ||
            (isStartingRecording && !countdownActive) ||
            recordDisabled
          }
          onClick={() => {
            if (countdownActive) cancelCountdown();
            else if (isMultiRecording) stopArmedRecording();
            else startArmedRecording();
          }}
          aria-label={
            isFinalizingRecording
              ? "Finalizing recording"
              : countdownActive
              ? "Cancel countdown"
              : isStartingRecording
              ? "Starting recording"
              : isMultiRecording
              ? "Stop recording"
              : "Play and record"
          }
          aria-pressed={isMultiRecording || countdownActive}
          title={
            isMultiRecording
              ? "Stop recording"
              : willRecordCount > 0
              ? `Play & record ${willRecordCount} track${willRecordCount === 1 ? "" : "s"}${
                  armedCount === 0 ? " (auto-arming empty tracks)" : ""
                }`
              : "Play (no empty tracks to record on — arm a track with R or add a new one)"
          }
          className={`h-9 w-9 sm:h-10 sm:w-10 rounded-full flex items-center justify-center active:scale-95 shrink-0 transition-colors disabled:opacity-60 disabled:pointer-events-none ${
            isMultiRecording
              ? "bg-red-600 text-white animate-pulse ring-2 ring-red-400/60 ring-offset-2 ring-offset-[#050a18]"
              : countdownActive
              ? "bg-amber-500 text-black"
              : "bg-white/[0.06] hover:bg-white/[0.1] border border-[var(--border-subtle)] text-[var(--text-primary)]"
          }`}
        >
          {countdownActive ? (
            <span className="text-xs font-bold tabular-nums">
              {Math.max(1, countInBeats - countdownBeat + 1)}
            </span>
          ) : (
            <span
              className={`block h-2.5 w-2.5 rounded-full ${
                isMultiRecording ? "bg-white" : "bg-red-500"
              }`}
            />
          )}
        </button>

        <div className="hidden sm:block h-7 w-px bg-[var(--border-subtle)]/80 mx-1" aria-hidden="true" />
        <HistoryButton label="Undo" disabled={!canUndo} onClick={undo}>
          <path d="M9 14L4 9l5-5" />
          <path d="M4 9h11a5 5 0 0 1 0 10h-4" />
        </HistoryButton>
        <HistoryButton label="Redo" disabled={!canRedo} onClick={redo}>
          <path d="M15 14l5-5-5-5" />
          <path d="M20 9H9a5 5 0 0 0 0 10h4" />
        </HistoryButton>
        </div>

        <div className="hidden flex-1 sm:block" />
        <div className="hidden sm:block h-7 w-px bg-[var(--border-subtle)]/80 mx-1" aria-hidden="true" />

        <div className="flex items-center gap-1 sm:gap-2">
        <label className="flex items-center gap-1 sm:gap-1.5 shrink-0">
          <span className="hidden sm:inline text-[10px] uppercase tracking-[0.18em] text-[var(--text-faint)]">
            BPM
          </span>
          <TempoInput key={bpm} bpm={bpm} onCommit={setBpm} />
        </label>
        <button
          type="button"
          onClick={() => {
            const current = TIME_SIGNATURE_OPTIONS.findIndex(
              (option) =>
                option.numerator === timeSignature.numerator &&
                option.denominator === timeSignature.denominator,
            );
            const next = TIME_SIGNATURE_OPTIONS[
              (current + 1) % TIME_SIGNATURE_OPTIONS.length
            ];
            setTimeSignature(next);
          }}
          aria-label={`Time signature: ${timeSignature.numerator}/${timeSignature.denominator}`}
          title="Change time signature"
          className="h-7 sm:h-9 min-w-10 px-1.5 rounded-md bg-white/[0.05] hover:bg-white/[0.09] border border-[var(--border-subtle)] text-[11px] sm:text-xs font-bold text-[var(--text-muted)] tabular-nums flex items-center justify-center active:scale-95 shrink-0 transition-colors"
        >
          {timeSignature.numerator}/{timeSignature.denominator}
        </button>
        <button
          onClick={() => {
            const next = countInBeats === 0 ? 1 : countInBeats === 1 ? 2 : countInBeats === 2 ? 4 : 0;
            setCountInBeats(next);
          }}
          aria-label={`Count-in: ${countInBeats === 0 ? "off" : `${countInBeats} beat${countInBeats === 1 ? "" : "s"}`}`}
          title="Pre-record count-in"
          className={`h-7 w-7 sm:h-9 sm:w-auto sm:px-2 rounded-md text-[11px] sm:text-xs font-bold flex items-center justify-center active:scale-95 shrink-0 tabular-nums transition-colors ${
            countInBeats > 0
              ? "bg-amber-500 text-black"
              : "bg-white/[0.05] hover:bg-white/[0.09] border border-[var(--border-subtle)] text-[var(--text-muted)]"
          }`}
        >
          {countInBeats === 0 ? "0" : countInBeats}·
        </button>
        <button
          onClick={toggleMetronome}
          aria-pressed={metronomeOn}
          aria-label="Metronome"
          className={`h-7 w-7 sm:h-9 sm:w-9 rounded-md flex items-center justify-center active:scale-95 shrink-0 transition-colors ${
            metronomeOn
              ? "bg-[var(--accent)] text-[#031024]"
              : "bg-white/[0.05] hover:bg-white/[0.09] border border-[var(--border-subtle)] text-[var(--text-muted)]"
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M9 2h6l4 18H5L9 2z" opacity=".4" />
            <path d="M12 6v10M12 16l4-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
          </svg>
        </button>
        </div>
      </div>
    </div>
  );
}

function TempoInput({
  bpm,
  onCommit,
}: {
  bpm: number;
  onCommit: (bpm: number) => void;
}) {
  const [draft, setDraft] = useState(String(bpm));

  function commit() {
    const parsed = Number(draft);
    const next = Number.isFinite(parsed)
      ? Math.max(40, Math.min(240, Math.round(parsed)))
      : bpm;
    setDraft(String(next));
    if (next !== bpm) onCommit(next);
  }

  return (
    <input
      type="number"
      inputMode="numeric"
      min={40}
      max={240}
      value={draft}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        else if (event.key === "Escape") {
          event.preventDefault();
          setDraft(String(bpm));
        }
      }}
      className="w-11 sm:w-12 h-7 sm:h-9 bg-white/[0.05] border border-[var(--border-subtle)] rounded-md px-1 text-sm text-[var(--text-primary)] tabular-nums text-center focus:border-[var(--accent)] transition-colors"
      aria-label="Tempo in beats per minute"
    />
  );
}

function HistoryButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="h-7 w-7 sm:h-9 sm:w-9 rounded-md bg-white/[0.05] hover:bg-white/[0.09] border border-[var(--border-subtle)] text-[var(--text-muted)] flex items-center justify-center active:scale-95 shrink-0 transition-colors disabled:opacity-40 disabled:hover:bg-white/[0.05]"
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
        {children}
      </svg>
    </button>
  );
}
