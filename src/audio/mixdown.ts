import type { Track } from "@/audio/engine";

// Render all tracks into a single stereo AudioBuffer faster-than-realtime.
// Solo is a monitoring-only tool; the exported mix includes every track
// that has audio and isn't explicitly muted.
export async function mixdown(tracks: Track[], sampleRate = 44100): Promise<AudioBuffer> {
  const playable = tracks.filter((t) => t.buffer);
  if (playable.length === 0) {
    const silentCtx = new OfflineAudioContext(2, sampleRate, sampleRate);
    return silentCtx.startRendering();
  }

  const audibleTracks = playable.filter((t) => !t.muted);
  if (audibleTracks.length === 0) {
    const silentCtx = new OfflineAudioContext(2, sampleRate, sampleRate);
    return silentCtx.startRendering();
  }

  if (typeof console !== "undefined") {
    console.info(
      `[mixdown] mixing ${audibleTracks.length} of ${tracks.length} tracks`,
      audibleTracks.map((t) => ({
        id: t.id,
        name: t.name,
        duration: t.buffer!.duration,
        sampleRate: t.buffer!.sampleRate,
        volume: t.volume,
        muted: t.muted,
      })),
    );
  }

  const lengthSec = Math.max(
    ...audibleTracks.map((t) => {
      const end = t.trimOutSec ?? t.buffer!.duration;
      return Math.max(0, end - t.trimInSec);
    }),
  );
  const totalSamples = Math.ceil(lengthSec * sampleRate);
  const ctx = new OfflineAudioContext(2, totalSamples, sampleRate);

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.05;
  limiter.connect(ctx.destination);

  for (const t of audibleTracks) {
    const src = ctx.createBufferSource();
    src.buffer = t.buffer!;
    const gain = ctx.createGain();
    gain.gain.value = t.volume;
    const panner = ctx.createStereoPanner();
    panner.pan.value = t.pan;
    src.connect(gain).connect(panner).connect(limiter);
    const end = t.trimOutSec ?? t.buffer!.duration;
    const dur = Math.max(0, end - t.trimInSec);
    if (dur > 0) src.start(0, t.trimInSec, dur);
  }

  return ctx.startRendering();
}
