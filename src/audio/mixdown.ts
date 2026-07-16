// Render a set of tracks into a single stereo AudioBuffer faster-than-realtime.
// The caller decides which tracks to include — mute and solo are not interpreted
// here, so this works for both "mix the song" (caller filters muted tracks) and
// "render this track alone for stems" (caller passes a single track).

export interface MixTrack {
  buffer: AudioBuffer | null;
  // One-shot samples scheduled on the project timeline. Sampler tracks use
  // these instead of a single linear buffer.
  events?: readonly MixEvent[];
  volume: number;
  pan: number;
  trimInSec: number;
  trimOutSec: number | null;
  normalizationGain?: number;
}

export interface MixEvent {
  buffer: AudioBuffer;
  timeSec: number;
}

// All exports use the project's delivery format. AudioBufferSourceNode
// resamples source buffers to the OfflineAudioContext rate while rendering,
// so WAV and MP3 mixdowns (including stems) share the same 44.1 kHz clock.
export const MIXDOWN_SAMPLE_RATE = 44_100;

export async function mixdown(tracks: MixTrack[]): Promise<AudioBuffer> {
  const playable = tracks.filter(
    (t) => t.buffer !== null || (t.events?.length ?? 0) > 0,
  );
  if (playable.length === 0) {
    const ctx = new OfflineAudioContext(
      2,
      MIXDOWN_SAMPLE_RATE,
      MIXDOWN_SAMPLE_RATE,
    );
    return ctx.startRendering();
  }

  const lengthSec = Math.max(
    ...playable.map((t) => {
      const linearDuration = t.buffer
        ? Math.max(0, (t.trimOutSec ?? t.buffer.duration) - t.trimInSec)
        : 0;
      const eventDuration = Math.max(
        0,
        ...(t.events?.map((event) =>
          Math.max(0, event.timeSec) + event.buffer.duration,
        ) ?? []),
      );
      return Math.max(linearDuration, eventDuration);
    }),
  );
  const totalSamples = Math.max(
    1,
    Math.ceil(lengthSec * MIXDOWN_SAMPLE_RATE),
  );
  const ctx = new OfflineAudioContext(
    2,
    totalSamples,
    MIXDOWN_SAMPLE_RATE,
  );

  // Match the engine's playback compressor — see engine.ts for the
  // rationale on the slow release.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.005;
  limiter.release.value = 0.25;
  limiter.connect(ctx.destination);

  for (const t of playable) {
    const gain = ctx.createGain();
    gain.gain.value = t.volume * (t.normalizationGain ?? 1);
    const panner = ctx.createStereoPanner();
    panner.pan.value = t.pan;
    gain.connect(panner).connect(limiter);

    if (t.buffer) {
      const src = ctx.createBufferSource();
      src.buffer = t.buffer;
      src.connect(gain);
      const end = t.trimOutSec ?? t.buffer.duration;
      const dur = Math.max(0, end - t.trimInSec);
      if (dur > 0) src.start(0, t.trimInSec, dur);
    }

    for (const event of t.events ?? []) {
      const src = ctx.createBufferSource();
      src.buffer = event.buffer;
      src.connect(gain);
      // Patterns normally contain non-negative transport positions. If an
      // older/corrupt project contains a negative value, trim the sample by
      // the amount that would have occurred before project time zero.
      const startAt = Math.max(0, event.timeSec);
      const offset = Math.max(0, -event.timeSec);
      const duration = Math.max(0, event.buffer.duration - offset);
      if (duration > 0) src.start(startAt, offset, duration);
    }
  }

  return ctx.startRendering();
}
