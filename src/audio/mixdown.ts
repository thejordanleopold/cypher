// Render a set of tracks into a single stereo AudioBuffer faster-than-realtime.
// The caller decides which tracks to include — mute and solo are not interpreted
// here, so this works for both "mix the song" (caller filters muted tracks) and
// "render this track alone for stems" (caller passes a single track).

export interface MixTrack {
  buffer: AudioBuffer | null;
  volume: number;
  pan: number;
  trimInSec: number;
  trimOutSec: number | null;
  normalizationGain?: number;
}

const FALLBACK_RATE = 48_000;
const MAX_RATE = 96_000;
const MIN_RATE = 8_000;

export async function mixdown(tracks: MixTrack[]): Promise<AudioBuffer> {
  const playable = tracks.filter((t) => t.buffer);
  if (playable.length === 0) {
    const ctx = new OfflineAudioContext(2, FALLBACK_RATE, FALLBACK_RATE);
    return ctx.startRendering();
  }

  // Match the highest source rate so a 48 kHz recording isn't silently
  // downsampled to 44.1 on the way out. Clamp to OfflineAudioContext's
  // valid range.
  const sourceRate = Math.max(...playable.map((t) => t.buffer!.sampleRate));
  const sampleRate = Math.min(MAX_RATE, Math.max(MIN_RATE, sourceRate));

  const lengthSec = Math.max(
    ...playable.map((t) => {
      const end = t.trimOutSec ?? t.buffer!.duration;
      return Math.max(0, end - t.trimInSec);
    }),
  );
  const totalSamples = Math.max(1, Math.ceil(lengthSec * sampleRate));
  const ctx = new OfflineAudioContext(2, totalSamples, sampleRate);

  // Soft peak ceiling: catch material above -1 dBFS without modulating the
  // gain so fast that it pumps audibly. Brick-wall settings (ratio 20:1 +
  // 10 ms release) modulate gain around 100 Hz on music that frequently
  // crosses threshold, which reads as a metallic/"robotic" sheen on the
  // exported mix. Match the engine's playback compressor.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.005;
  limiter.release.value = 0.25;
  limiter.connect(ctx.destination);

  for (const t of playable) {
    const src = ctx.createBufferSource();
    src.buffer = t.buffer!;
    const gain = ctx.createGain();
    gain.gain.value = t.volume * (t.normalizationGain ?? 1);
    const panner = ctx.createStereoPanner();
    panner.pan.value = t.pan;
    src.connect(gain).connect(panner).connect(limiter);
    const end = t.trimOutSec ?? t.buffer!.duration;
    const dur = Math.max(0, end - t.trimInSec);
    if (dur > 0) src.start(0, t.trimInSec, dur);
  }

  return ctx.startRendering();
}
