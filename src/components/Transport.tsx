"use client";

import { useCypher } from "@/state/store";

export function Transport() {
  const {
    isPlaying,
    play,
    pause,
    stop,
    bpm,
    setBpm,
    addTrack,
    metronomeOn,
    toggleMetronome,
    isMultiRecording,
    startArmedRecording,
    stopArmedRecording,
    tracks,
    countInBeats,
    setCountInBeats,
    countdownActive,
    countdownBeat,
    cancelCountdown,
  } = useCypher();
  const armedCount = tracks.filter((t) => t.armed).length;
  const emptyCount = tracks.filter((t) => !t.hasAudio).length;
  const willRecordCount = armedCount > 0 ? armedCount : emptyCount;

  return (
    <div className="sticky top-0 z-20 bg-neutral-950/95 backdrop-blur border-b border-neutral-800">
      <div className="flex items-center gap-1.5 px-3 py-2.5 sm:gap-2 sm:px-4">
        <button
          onClick={() => (isPlaying ? pause() : play())}
          className="h-10 w-10 rounded-full bg-emerald-500 text-black flex items-center justify-center active:scale-95 shrink-0"
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
          className="h-10 w-10 rounded-full bg-neutral-800 text-neutral-200 flex items-center justify-center active:scale-95 shrink-0"
          aria-label="Stop"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="1.5" />
          </svg>
        </button>
        <button
          onClick={() => {
            if (countdownActive) cancelCountdown();
            else if (isMultiRecording) stopArmedRecording();
            else startArmedRecording();
          }}
          aria-label={
            countdownActive
              ? "Cancel countdown"
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
          className={`h-10 w-10 rounded-full flex items-center justify-center active:scale-95 shrink-0 transition-colors ${
            isMultiRecording
              ? "bg-red-600 text-white animate-pulse ring-2 ring-red-400/60 ring-offset-2 ring-offset-neutral-950"
              : countdownActive
              ? "bg-amber-500 text-black"
              : "bg-neutral-800 text-neutral-200 hover:bg-neutral-700"
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

        <div className="w-px h-7 bg-neutral-800 mx-1 shrink-0" aria-hidden="true" />

        <button
          onClick={() => addTrack()}
          className="h-9 px-2.5 rounded-md bg-neutral-800 text-neutral-100 text-xs font-medium active:scale-95 shrink-0"
          aria-label="Add track"
        >
          + Track
        </button>

        <div className="flex-1" />

        <label className="flex items-center gap-1.5 shrink-0">
          <span className="text-[10px] uppercase tracking-wider text-neutral-500">
            BPM
          </span>
          <input
            type="number"
            min={40}
            max={240}
            value={bpm}
            onChange={(e) => setBpm(Number(e.target.value) || 120)}
            className="w-12 h-9 bg-neutral-900 border border-neutral-700 rounded-md px-1 text-sm text-neutral-100 tabular-nums text-center"
            aria-label="Tempo in beats per minute"
          />
        </label>
        <button
          onClick={() => {
            const next = countInBeats === 0 ? 1 : countInBeats === 1 ? 2 : countInBeats === 2 ? 4 : 0;
            setCountInBeats(next);
          }}
          aria-label={`Count-in: ${countInBeats === 0 ? "off" : `${countInBeats} beat${countInBeats === 1 ? "" : "s"}`}`}
          title="Pre-record count-in"
          className={`h-9 px-2 rounded-md text-xs font-bold flex items-center justify-center active:scale-95 shrink-0 tabular-nums ${
            countInBeats > 0
              ? "bg-amber-500 text-black"
              : "bg-neutral-800 text-neutral-300"
          }`}
        >
          {countInBeats === 0 ? "0" : countInBeats}·
        </button>
        <button
          onClick={toggleMetronome}
          aria-pressed={metronomeOn}
          aria-label="Metronome"
          className={`h-9 w-9 rounded-md flex items-center justify-center active:scale-95 shrink-0 ${
            metronomeOn ? "bg-emerald-500 text-black" : "bg-neutral-800 text-neutral-300"
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M9 2h6l4 18H5L9 2z" opacity=".4" />
            <path d="M12 6v10M12 16l4-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
          </svg>
        </button>
      </div>
    </div>
  );
}
