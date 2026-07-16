export interface ProjectTimePad {
  hasAudio: boolean;
  durationSec: number;
}

export interface ProjectTimeEvent {
  padIdx: number;
  timeSec: number;
}

/** Normalize a runtime/persisted sampler event at the trust boundary. */
export function sanitizeSamplerEvent(
  event: unknown,
  padCount: number,
): ProjectTimeEvent | null {
  if (!event || typeof event !== "object") return null;
  const candidate = event as { padIdx?: unknown; timeSec?: unknown };
  if (
    !Number.isInteger(candidate.padIdx) ||
    (candidate.padIdx as number) < 0 ||
    (candidate.padIdx as number) >= padCount ||
    typeof candidate.timeSec !== "number"
  ) {
    return null;
  }
  return {
    padIdx: candidate.padIdx as number,
    // Tone can briefly report a negative/non-finite value while a scheduled
    // transport start is still in the future. Preserve the hit at time zero.
    timeSec: Number.isFinite(candidate.timeSec)
      ? Math.max(0, candidate.timeSec)
      : 0,
  };
}

export interface ProjectTimeTrack {
  kind: "audio" | "sampler";
  hasAudio: boolean;
  durationSec: number;
  trimInSec: number;
  trimOutSec: number | null;
  pads: readonly ProjectTimePad[];
  samplerPattern: readonly ProjectTimeEvent[];
  samplerRecArmed?: boolean;
}

/** Duration contributed by an audio clip after applying its source trim. */
export function audioTrackDuration(track: ProjectTimeTrack): number {
  if (!track.hasAudio) return 0;
  const sourceDuration = finiteNonNegative(track.durationSec);
  const trimIn = Math.min(sourceDuration, finiteNonNegative(track.trimInSec));
  const trimOut = Math.max(
    trimIn,
    Math.min(
      sourceDuration,
      track.trimOutSec === null
        ? sourceDuration
        : finiteNonNegative(track.trimOutSec),
    ),
  );
  return trimOut - trimIn;
}

/** Duration contributed by recorded one-shot events on the project timeline. */
export function samplerTrackDuration(track: ProjectTimeTrack): number {
  if (track.kind !== "sampler") return 0;
  let duration = 0;
  for (const event of track.samplerPattern) {
    const pad = track.pads[event.padIdx];
    if (!pad?.hasAudio) continue;
    duration = Math.max(
      duration,
      finiteNonNegative(event.timeSec) + finiteNonNegative(pad.durationSec),
    );
  }
  return duration;
}

export function trackProjectDuration(track: ProjectTimeTrack): number {
  return Math.max(audioTrackDuration(track), samplerTrackDuration(track));
}

export function projectDuration(tracks: readonly ProjectTimeTrack[]): number {
  let duration = 0;
  for (const track of tracks) {
    duration = Math.max(duration, trackProjectDuration(track));
  }
  return duration;
}

/** Whether a rolling transport can capture a first event on an armed sampler. */
export function hasSamplerCaptureSource(
  tracks: readonly ProjectTimeTrack[],
): boolean {
  return tracks.some(
    (track) =>
      track.kind === "sampler" &&
      track.samplerRecArmed === true &&
      track.pads.some((pad) => pad.hasAudio),
  );
}

/** A transport may run for audible content or to capture armed sampler hits. */
export function canRunTransport(tracks: readonly ProjectTimeTrack[]): boolean {
  return projectDuration(tracks) > 0 || hasSamplerCaptureSource(tracks);
}

export function clampProjectTime(seconds: number, duration: number): number {
  const safeDuration = finiteNonNegative(duration);
  return Math.min(safeDuration, finiteNonNegative(seconds));
}

/** Maps project playback time into an audio track's original source buffer. */
export function sourceTimeAtProjectTime(
  track: ProjectTimeTrack,
  projectTimeSec: number,
): number | null {
  const playableDuration = audioTrackDuration(track);
  const projectTime = finiteNonNegative(projectTimeSec);
  if (!track.hasAudio || projectTime > playableDuration) return null;
  const sourceStart = Math.min(
    finiteNonNegative(track.durationSec),
    finiteNonNegative(track.trimInSec),
  );
  return sourceStart + projectTime;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
