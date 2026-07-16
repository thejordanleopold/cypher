import * as Tone from "tone";
import {
  DEFAULT_TIME_SIGNATURE,
  type TimeSignature,
} from "@/audio/time-signature";
import { hasUsableRecordingAfterLead } from "@/audio/recording-duration";

export type TrackId = string;

export type TrackKind = "audio" | "sampler";

export interface RecordingInterruption {
  trackId: TrackId;
  reason: "input-ended" | "recorder-error" | "recorder-stopped";
  error?: Error;
}

export interface Track {
  id: TrackId;
  name: string;
  kind: TrackKind;
  buffer: AudioBuffer | null;
  player: Tone.Player | null;
  gain: Tone.Gain;
  panner: Tone.Panner;
  volume: number;
  pan: number;
  muted: boolean;
  soloed: boolean;
  trimInSec: number;
  trimOutSec: number | null; // null = until end of buffer
  // Multiplier applied on top of volume to bring quiet recordings up to a
  // target peak. 1 = unmodified. Stored so the user can toggle it off and
  // get the original signal back without re-recording or re-importing.
  normalizationGain: number;
  // Sampler pads. Indexed by pad slot; a missing entry = empty pad. Only
  // populated when kind === "sampler".
  pads: Map<number, AudioBuffer>;
  // Transport-scheduled Part for sampler pattern playback. Null when no
  // pattern has been recorded or the track is in record-armed mode.
  samplerPart: Tone.Part | null;
  // Live AudioBufferSourceNodes from pad triggers. Tracked so stop() can
  // cut them all immediately rather than letting them ring out.
  activePadSources: Set<AudioBufferSourceNode>;
}

interface RecordingSession {
  trackId: TrackId;
  audioSessionToken: symbol;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  sink: GainNode;
  inputGainValue: number;
  recorder: MediaRecorder;
  chunks: Blob[];
  mimeType: string;
  startedAt: number;
  transportStartAt: number | null;
  capturedSampleRate: number;
  routerEl: HTMLAudioElement | null;
  expectedStop: boolean;
  interruptionReported: boolean;
  stopped: Promise<void>;
  resolveStopped: () => void;
  cleanupInterruptionListeners: () => void;
}

const DEFAULT_RECORDER_BITRATE = 512_000;
const RECORDING_START_AHEAD_SEC = 0.05;
const TONE_LOOKAHEAD_SEC = 0.02;
const TRANSPORT_SCHEDULE_MARGIN_SEC = 0.01;
// Decode recordings into a 48 kHz buffer so the saved WAV preserves the
// mic's full bandwidth even on iOS Safari, where the live AudioContext
// is often clamped to 24 kHz when the speaker route is active.
const DECODE_SAMPLE_RATE = 48_000;

function disconnectSessionNodes(session: RecordingSession) {
  for (const node of [session.analyser, session.sink, session.source]) {
    try {
      node.disconnect();
    } catch {
      // ignore
    }
  }
  if (session.routerEl) {
    try {
      session.routerEl.pause();
      session.routerEl.srcObject = null;
      session.routerEl.remove();
    } catch {
      // ignore
    }
    session.routerEl = null;
  }
}

function throwIfRecordingStartAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = new Error("Recording start cancelled");
  error.name = "AbortError";
  throw error;
}

function softClipSample(v: number): number {
  // Linear up to ±0.92 (so most music passes through bit-for-bit), then
  // asymptote smoothly toward ±1.0 above that. Aggressive thresholds here
  // squash transients and read as "muffled" or "smushed" — keep the curve
  // mostly out of the way and only catch true overs.
  const a = v < 0 ? -v : v;
  if (a <= 0.92) return v;
  const sign = v < 0 ? -1 : 1;
  return sign * (0.92 + 0.08 * (1 - Math.exp(-(a - 0.92) / 0.08)));
}

function applyInputGain(buf: AudioBuffer, gain: number): AudioBuffer {
  if (gain === 1) return buf;
  // Probe peak first — if the gained signal stays inside ±1.0 there's no
  // need to soft-clip at all, and we just multiply linearly. This prevents
  // the soft-clip curve from coloring quiet recordings that the user
  // boosted modestly.
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
    }
  }
  const willClip = peak * gain > 1.0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const data = buf.getChannelData(c);
    if (willClip) {
      for (let i = 0; i < data.length; i++) {
        data[i] = softClipSample(data[i] * gain);
      }
    } else {
      for (let i = 0; i < data.length; i++) data[i] = data[i] * gain;
    }
  }
  return buf;
}

function trimBufferStart(buf: AudioBuffer, seconds: number): AudioBuffer {
  const frames = Math.min(
    Math.max(0, Math.round(seconds * buf.sampleRate)),
    Math.max(0, buf.length - 1),
  );
  if (frames === 0) return buf;
  const length = Math.max(1, buf.length - frames);
  const trimmed = new AudioBuffer({
    length,
    numberOfChannels: buf.numberOfChannels,
    sampleRate: buf.sampleRate,
  });
  for (let channel = 0; channel < buf.numberOfChannels; channel++) {
    trimmed.copyToChannel(
      buf.getChannelData(channel).subarray(frames, frames + length),
      channel,
    );
  }
  return trimmed;
}

async function decodeRecording(
  arr: ArrayBuffer,
  hintRate: number,
): Promise<AudioBuffer> {
  // Decode at the source rate when known so we don't bloat the WAV with
  // empty resampled headroom. Clamp to OfflineAudioContext's valid range.
  const targetRate = Math.max(
    8_000,
    Math.min(96_000, Math.round(hintRate) || DECODE_SAMPLE_RATE),
  );
  if (typeof OfflineAudioContext !== "undefined") {
    try {
      const oac = new OfflineAudioContext(1, 1, targetRate);
      return await oac.decodeAudioData(arr.slice(0));
    } catch {
      // Some browsers refuse decodeAudioData on OfflineAudioContext;
      // fall through to a real context.
    }
  }
  const ctx = new AudioContext({ sampleRate: targetRate });
  try {
    return await ctx.decodeAudioData(arr.slice(0));
  } finally {
    try {
      await ctx.close();
    } catch {
      // ignore
    }
  }
}

// iOS 17+ Audio Session API — lets us pick the AVAudioSession category and
// mode WebKit uses for the page. Without this, recording sessions default
// to a voice profile that band-limits the mic (and on iPhone forces the
// bottom voice mic regardless of orientation). Best-effort: silently
// ignored on browsers without the API.
type AudioSessionType =
  | "auto"
  | "playback"
  | "transient"
  | "transient-solo"
  | "ambient"
  | "play-and-record";
type NavigatorWithAudioSession = Navigator & {
  audioSession?: { type: AudioSessionType };
};
function setAudioSessionType(type: AudioSessionType) {
  if (typeof navigator === "undefined") return;
  const nav = navigator as NavigatorWithAudioSession;
  if (!nav.audioSession) return;
  // Use "playback" during normal operation and only switch to "play-and-record"
  // when a recording session is actually opening. The output bridge (<audio>
  // element fed from a MediaStreamAudioDestinationNode) keeps audio on the
  // loud speaker even while the session is in play-and-record mode, so the
  // earpiece-routing concern from the old approach is already handled.
  // Permanently pinning to "play-and-record" was causing iOS to show the
  // orange mic indicator in the Dynamic Island even when not recording.
  try {
    nav.audioSession.type = type;
  } catch {
    // ignore — older browsers may treat the setter as read-only
  }
}

function needsIosRecordingOutputBridge(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function pickRecorderMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/aac",
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c))
      return c;
  }
  return "";
}

class AudioEngine {
  private master: Tone.Gain | null = null;
  private limiter: Tone.Compressor | null = null;
  private tracks = new Map<TrackId, Track>();
  private started = false;
  private nativeCtx: AudioContext | null = null;
  private recording: RecordingSession | null = null;
  private multiRecording = new Map<TrackId, RecordingSession>();
  // A token exists from the moment a recording session starts opening until
  // its stream is released. This also covers sessions that have opened but
  // have not yet been installed in `recording` / `multiRecording`.
  private recordingAudioSessionTokens = new Set<symbol>();
  private metronomeSynth: Tone.MembraneSynth | null = null;
  private metronomeLoop: Tone.Loop | null = null;
  private metronomeOn = false;
  private timeSignature: TimeSignature = { ...DEFAULT_TIME_SIGNATURE };
  private toneStartCalled = false;
  // Output bridge: while a mic is open on iOS Safari the AudioContext's
  // destination gets routed to the receiver/earpiece (or muted entirely on
  // some headphone profiles). Pulling the mix through an HTMLAudioElement
  // forces the loud-speaker / standard playback route. Activated only while
  // recording so non-recording playback stays on the regular ctx.destination.
  private outputBridgeStreamNode: MediaStreamAudioDestinationNode | null = null;
  private outputBridgeEl: HTMLAudioElement | null = null;
  private outputBridgeRefs = 0;
  // Which path is the user's chosen output device routed through. The bridge
  // path is used when only HTMLMediaElement.setSinkId is available; the ctx
  // path is preferred otherwise.
  private activeSinkRoute: "ctx" | "bridge" = "ctx";
  private transportPositionSec = 0;

  private syncAudioSessionType() {
    setAudioSessionType(
      this.recordingAudioSessionTokens.size > 0
        ? "play-and-record"
        : "playback",
    );
  }

  private acquireRecordingAudioSession(): symbol {
    const token = Symbol("recording-audio-session");
    this.recordingAudioSessionTokens.add(token);
    this.syncAudioSessionType();
    return token;
  }

  private releaseRecordingAudioSession(token: symbol) {
    if (!this.recordingAudioSessionTokens.delete(token)) return;
    this.syncAudioSessionType();
  }

  async start() {
    // Idempotent. Safe to call from any user gesture or even non-gesture
    // contexts — if the AudioContext was created suspended (which is the
    // case on iOS Safari until a real user gesture arrives), we'll attempt
    // to resume it on every call. Subsequent calls inside a real gesture
    // will succeed where earlier ones silently no-op'd.
    if (!this.nativeCtx) {
      this.nativeCtx = new AudioContext({ latencyHint: "interactive" });
      Tone.setContext(this.nativeCtx);
      // Tone's default 100 ms lookahead is too large for an overdubbing UI.
      // Keep a small scheduler cushion, then place Transport events just past
      // it so Parts/metronome callbacks are never scheduled in the past.
      Tone.getContext().lookAhead = TONE_LOOKAHEAD_SEC;
    }
    // Hint WebKit (iOS 17+) to use the high-fidelity Playback audio session
    // when we're not actively recording. Without this, the default "auto"
    // category often demotes the session to a voice profile (16 kHz,
    // earpiece route) the moment the page touches anything mic-adjacent.
    this.syncAudioSessionType();
    if (this.nativeCtx.state === "suspended") {
      const resumeAttempt = this.nativeCtx.resume().catch(() => {
        // Will retry on the next call (likely from a user gesture).
      });
      const hasUserActivation =
        typeof navigator !== "undefined" &&
        (
          navigator as Navigator & {
            userActivation?: { isActive: boolean };
          }
        ).userActivation?.isActive === true;
      // Safari can leave resume() pending indefinitely when initialization
      // runs outside a user gesture. Build the graph immediately in that
      // case; gesture-driven calls still wait for the resume attempt so the
      // context is running before playback starts.
      if (hasUserActivation) await resumeAttempt;
    }
    if (!this.started) {
      // Create the graph nodes synchronously — Tone constructors are safe on
      // a suspended context. Only await Tone.start() once the context is
      // actually running (post-gesture), otherwise it blocks forever and
      // stalls callers like initProject.
      this.master = new Tone.Gain(1);
      // Catch peaks above -1 dBFS so the destination doesn't hard-clip on
      // hot mixes, but with a slow release so the gain reduction doesn't
      // modulate audibly. Tone.Limiter ships with release=0.01 s, which on
      // music whose peaks regularly cross threshold modulates the gain
      // around 100 Hz and reads as a "robotic"/"metallic" coloration on the
      // master bus. A 250 ms release pushes that modulation well below the
      // audible band while still catching transients.
      this.limiter = new Tone.Compressor({
        threshold: -1,
        knee: 6,
        ratio: 12,
        attack: 0.005,
        release: 0.25,
      });
      this.master.connect(this.limiter);
      this.limiter.toDestination();
      if (this.metronomeSynth) {
        this.metronomeSynth.disconnect();
        this.metronomeSynth.connect(this.master);
      }
      this.started = true;
      // Set up the output bridge (muted by default) inside this potentially
      // gesture-bearing call. iOS Safari blocks HTMLAudioElement.play() outside
      // user gestures, so creating it lazily during a recording session — which
      // happens after `await getUserMedia` — leaves it silently paused. Build
      // it now while we may still have the gesture, and unmute later only when
      // we need it (i.e. while recording on iOS-like browsers).
      this.installOutputBridge();
    }
    if (this.nativeCtx.state === "running" && !this.toneStartCalled) {
      this.toneStartCalled = true;
      try {
        await Tone.start();
      } catch {
        this.toneStartCalled = false;
      }
    }
  }

  isStarted() {
    return this.started;
  }

  private installOutputBridge() {
    if (this.outputBridgeStreamNode || !this.nativeCtx || !this.limiter) return;
    if (typeof document === "undefined") return;
    try {
      const streamNode = this.nativeCtx.createMediaStreamDestination();
      this.limiter.connect(streamNode);
      const el = document.createElement("audio");
      el.srcObject = streamNode.stream;
      el.autoplay = true;
      el.muted = true; // start muted so autoplay is allowed; unmute on demand
      el.setAttribute("playsinline", "");
      el.setAttribute("webkit-playsinline", "");
      el.style.position = "fixed";
      el.style.width = "0";
      el.style.height = "0";
      el.style.opacity = "0";
      el.style.pointerEvents = "none";
      document.body.appendChild(el);
      el.play().catch(() => {
        // Even with muted=true autoplay can occasionally fail; non-fatal.
      });
      this.outputBridgeStreamNode = streamNode;
      this.outputBridgeEl = el;
    } catch {
      // ignore — fall back to ctx.destination route
    }
  }

  private enableOutputBridge() {
    this.outputBridgeRefs += 1;
    if (!this.outputBridgeEl || !this.nativeCtx) return;
    // This bridge is an iOS/WebKit recording-session workaround, not a proxy
    // for setSinkId feature support. Firefox and desktop WebKit can lack
    // AudioContext.setSinkId while their native destination remains audible;
    // unmuting there would double-play the mix and create comb filtering.
    if (needsIosRecordingOutputBridge()) {
      this.outputBridgeEl.muted = false;
      this.outputBridgeEl.play().catch(() => {
        // Fall back to the native destination if autoplay policy blocks the
        // workaround instead of leaving a half-enabled bridge route.
        if (this.outputBridgeEl && this.activeSinkRoute !== "bridge") {
          this.outputBridgeEl.muted = true;
        }
      });
    }
  }

  private disableOutputBridge() {
    this.outputBridgeRefs = Math.max(0, this.outputBridgeRefs - 1);
    if (this.outputBridgeRefs > 0) return;
    // Only re-mute when the bridge isn't currently being used as the user's
    // chosen output sink — otherwise we'd silence them after every record.
    if (this.outputBridgeEl && this.activeSinkRoute !== "bridge") {
      this.outputBridgeEl.muted = true;
    }
  }

  context(): AudioContext {
    if (!this.nativeCtx) throw new Error("Engine not started");
    return this.nativeCtx;
  }

  async addTrack(id: TrackId, name: string, kind: TrackKind = "audio"): Promise<Track> {
    await this.start();
    const gain = new Tone.Gain(1);
    const panner = new Tone.Panner(0);
    gain.connect(panner);
    if (this.master) panner.connect(this.master);
    const track: Track = {
      id,
      name,
      kind,
      buffer: null,
      player: null,
      gain,
      panner,
      volume: 1,
      pan: 0,
      muted: false,
      soloed: false,
      trimInSec: 0,
      trimOutSec: null,
      normalizationGain: 1,
      pads: new Map(),
      samplerPart: null,
      activePadSources: new Set(),
    };
    this.tracks.set(id, track);
    return track;
  }

  setPadBuffer(id: TrackId, padIdx: number, buffer: AudioBuffer | null) {
    const t = this.tracks.get(id);
    if (!t) return;
    if (buffer) t.pads.set(padIdx, buffer);
    else t.pads.delete(padIdx);
  }

  getPadBuffer(id: TrackId, padIdx: number): AudioBuffer | null {
    const t = this.tracks.get(id);
    if (!t) return null;
    return t.pads.get(padIdx) ?? null;
  }

  // Fire a one-shot of the pad's sample through the track's gain/pan chain.
  // A fresh BufferSource is allocated per trigger so overlapping taps layer
  // instead of cancelling the previous play. The browser GCs the source once
  // it ends. When `audioTime` is provided (from a scheduled Tone.Part), the
  // source is started at that precise AudioContext time for accurate timing.
  triggerPad(id: TrackId, padIdx: number, audioTime?: number) {
    const t = this.tracks.get(id);
    if (!t || !this.nativeCtx) return;
    const buf = t.pads.get(padIdx);
    if (!buf) return;
    if (this.nativeCtx.state === "suspended") {
      // Best-effort wake; if we're outside a gesture this no-ops and the
      // user retries by tapping again.
      void this.nativeCtx.resume();
    }
    const src = this.nativeCtx.createBufferSource();
    src.buffer = buf;
    // Connect into the Tone.Gain's underlying input so volume/pan/mute apply.
    const gainInput = (t.gain as unknown as { input: AudioNode }).input;
    src.connect(gainInput);
    t.activePadSources.add(src);
    src.onended = () => t.activePadSources.delete(src);
    if (audioTime !== undefined) {
      src.start(audioTime);
    } else {
      src.start();
    }
  }

  private stopActivePadSources(track: Track) {
    for (const src of track.activePadSources) {
      try {
        src.stop();
      } catch {
        // The source may already have ended.
      }
    }
    track.activePadSources.clear();
  }

  // Build a Tone.Part from recorded events and schedule it to fire at the
  // appropriate transport positions. Called from the store before transport
  // starts so the Part is ready to fire on play. The Part calls triggerPad
  // directly (not through the store) so the playback hits are not re-recorded.
  setSamplerPattern(
    id: TrackId,
    events: Array<{ padIdx: number; timeSec: number }>,
  ) {
    const t = this.tracks.get(id);
    if (!t) return;
    t.samplerPart?.dispose();
    t.samplerPart = null;
    if (events.length === 0) return;
    const part = new Tone.Part(
      (time: number, val: { padIdx: number }) => {
        this.triggerPad(id, val.padIdx, time);
      },
      events.map((e) => ({ time: e.timeSec, padIdx: e.padIdx })),
    );
    part.loop = false;
    part.start(0);
    t.samplerPart = part;
  }

  clearSamplerPart(id: TrackId) {
    const t = this.tracks.get(id);
    if (!t) return;
    t.samplerPart?.dispose();
    t.samplerPart = null;
  }

  async loadFileToPad(
    id: TrackId,
    padIdx: number,
    file: File,
  ): Promise<AudioBuffer> {
    if (!this.tracks.has(id)) throw new Error(`No track ${id}`);
    const audioBuf = await this.decodeFile(file);
    this.setPadBuffer(id, padIdx, audioBuf);
    return audioBuf;
  }

  clearAllPads(id: TrackId) {
    const t = this.tracks.get(id);
    if (!t) return;
    t.pads.clear();
  }

  removeTrack(id: TrackId) {
    const t = this.tracks.get(id);
    if (!t) return;
    t.player?.dispose();
    t.samplerPart?.dispose();
    this.stopActivePadSources(t);
    t.gain.dispose();
    t.panner.dispose();
    t.pads.clear();
    this.tracks.delete(id);
  }

  clearAllTracks() {
    this.abortAllRecording();
    Tone.getTransport().stop(Tone.now());
    this.transportPositionSec = 0;
    for (const t of this.tracks.values()) {
      t.player?.dispose();
      t.samplerPart?.dispose();
      this.stopActivePadSources(t);
      t.gain.dispose();
      t.panner.dispose();
      t.pads.clear();
    }
    this.tracks.clear();
  }

  async decodeFile(file: Blob): Promise<AudioBuffer> {
    const arrayBuf = await file.arrayBuffer();
    return this.context().decodeAudioData(arrayBuf.slice(0));
  }

  setTrackBuffer(id: TrackId, audioBuf: AudioBuffer) {
    const t = this.tracks.get(id);
    if (!t) throw new Error(`No track ${id}`);
    t.player?.dispose();
    const player = new Tone.Player(audioBuf);
    player.connect(t.gain);
    t.player = player;
    t.buffer = audioBuf;
    t.trimInSec = 0;
    t.trimOutSec = null;
    // Normalization belongs to the previous waveform, not the track slot.
    // A replacement import/take must start at unity or a quiet old buffer's
    // large multiplier can hard-clip unrelated new audio.
    t.normalizationGain = 1;
    t.gain.gain.rampTo(this.effectiveGain(t), 0.01);
  }

  async loadFileToTrack(id: TrackId, file: File): Promise<AudioBuffer> {
    if (!this.tracks.has(id)) throw new Error(`No track ${id}`);
    const audioBuf = await this.decodeFile(file);
    this.setTrackBuffer(id, audioBuf);
    return audioBuf;
  }

  clearTrackAudio(id: TrackId) {
    const t = this.tracks.get(id);
    if (!t) return;
    try {
      t.player?.stop(Tone.now());
    } catch {
      // The player may already be stopped.
    }
    t.player?.dispose();
    t.player = null;
    t.buffer = null;
    t.trimInSec = 0;
    t.trimOutSec = null;
    t.normalizationGain = 1;
  }

  setTrim(id: TrackId, inSec: number, outSec: number | null) {
    const t = this.tracks.get(id);
    if (!t || !t.buffer) return;
    const dur = t.buffer.duration;
    t.trimInSec = Math.max(0, Math.min(dur, inSec));
    t.trimOutSec =
      outSec === null
        ? null
        : Math.max(t.trimInSec, Math.min(dur, outSec));
  }

  private effectiveGain(t: Track): number {
    return t.muted ? 0 : t.volume * t.normalizationGain;
  }

  setVolume(id: TrackId, v: number) {
    const t = this.tracks.get(id);
    if (!t) return;
    t.volume = v;
    t.gain.gain.rampTo(this.effectiveGain(t), 0.01);
  }

  setPan(id: TrackId, p: number) {
    const t = this.tracks.get(id);
    if (!t) return;
    t.pan = p;
    t.panner.pan.rampTo(p, 0.01);
  }

  setMute(id: TrackId, muted: boolean) {
    const t = this.tracks.get(id);
    if (!t) return;
    t.muted = muted;
    t.gain.gain.rampTo(this.effectiveGain(t), 0.01);
  }

  setNormalizationGain(id: TrackId, gain: number) {
    const t = this.tracks.get(id);
    if (!t) return;
    t.normalizationGain = Math.max(0, gain);
    t.gain.gain.rampTo(this.effectiveGain(t), 0.05);
  }

  // Find the absolute peak across every channel. Used by the store to pick
  // a normalization multiplier that gets the loudest sample close to full
  // scale without clipping.
  bufferPeak(id: TrackId): number {
    const t = this.tracks.get(id);
    if (!t || !t.buffer) return 0;
    let peak = 0;
    for (let c = 0; c < t.buffer.numberOfChannels; c++) {
      const data = t.buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) {
        const a = Math.abs(data[i]);
        if (a > peak) peak = a;
      }
    }
    return peak;
  }

  getTracks(): Track[] {
    return [...this.tracks.values()];
  }

  getTrack(id: TrackId) {
    return this.tracks.get(id);
  }

  private isCapturing(id: TrackId): boolean {
    return this.recording?.trackId === id || this.multiRecording.has(id);
  }

  private transportSecondsAt(time = Tone.immediate()) {
    return Tone.getTransport().getSecondsAtTime(time);
  }

  private scheduledTransportTime(extraSeconds = 0) {
    return (
      Tone.now() +
      TRANSPORT_SCHEDULE_MARGIN_SEC +
      Math.max(0, extraSeconds)
    );
  }

  async play(scheduleAheadSec = 0): Promise<number> {
    await this.start();
    const transport = Tone.getTransport();
    if (transport.state === "started") return Tone.immediate();
    const startAt = this.scheduledTransportTime(scheduleAheadSec);
    const position = this.transportPositionSec;
    for (const t of this.tracks.values()) {
      // Don't sound a track that's actively being recorded — the previous
      // take would otherwise play back through the speaker and bleed into
      // the mic, fighting the new take we're trying to capture.
      if (this.isCapturing(t.id)) continue;
      if (t.player && t.buffer) {
        const offset = t.trimInSec + position;
        const end = t.trimOutSec ?? t.buffer.duration;
        const dur = Math.max(0, end - t.trimInSec - position);
        if (dur > 0) t.player.start(startAt, offset, dur);
      }
    }
    transport.start(startAt, position);
    return startAt;
  }

  pause(): number {
    const transport = Tone.getTransport();
    const now = Tone.now();
    const position = this.transportSecondsAt(now);
    // stop() cancels a start that may still be queued just beyond Tone's
    // lookahead. We retain the musical position ourselves and pass it back as
    // an explicit offset on play(), so pause semantics stay intact.
    transport.stop(now);
    for (const t of this.tracks.values()) {
      t.player?.stop(now);
      this.stopActivePadSources(t);
    }
    this.transportPositionSec = position;
    return position;
  }

  stop() {
    const transport = Tone.getTransport();
    const now = Tone.now();
    transport.stop(now);
    this.transportPositionSec = 0;
    for (const t of this.tracks.values()) {
      t.player?.stop(now);
      this.stopActivePadSources(t);
    }
  }

  seconds() {
    return Tone.getTransport().state === "started"
      ? this.transportSecondsAt()
      : this.transportPositionSec;
  }

  isPlaying(): boolean {
    return Tone.getTransport().state === "started";
  }

  rescheduleTrack(id: TrackId) {
    const transport = Tone.getTransport();
    if (transport.state !== "started") return;
    const track = this.tracks.get(id);
    if (!track?.player || !track.buffer) return;
    const scheduleAt = this.scheduledTransportTime();
    const position = this.transportSecondsAt(scheduleAt);
    track.player.stop(scheduleAt);
    if (this.isCapturing(id)) return;
    const offset = track.trimInSec + position;
    const end = track.trimOutSec ?? track.buffer.duration;
    const duration = Math.max(0, end - track.trimInSec - position);
    if (duration > 0) {
      track.player.start(scheduleAt, offset, duration);
    }
  }

  projectDuration(): number {
    let max = 0;
    for (const t of this.tracks.values()) {
      if (!t.buffer) continue;
      const end = t.trimOutSec ?? t.buffer.duration;
      const dur = Math.max(0, end - t.trimInSec);
      if (dur > max) max = dur;
    }
    return max;
  }

  async seek(seconds: number) {
    await this.start();
    const transport = Tone.getTransport();
    const wasPlaying = transport.state === "started";
    const position = Math.max(0, seconds);
    const controlAt = Tone.now();
    for (const t of this.tracks.values()) {
      t.player?.stop(controlAt);
      this.stopActivePadSources(t);
    }
    transport.stop(controlAt);
    this.transportPositionSec = position;
    if (wasPlaying) {
      const restartAt = this.scheduledTransportTime();
      for (const t of this.tracks.values()) {
        if (this.isCapturing(t.id)) continue;
        if (!t.player || !t.buffer) continue;
        const offset = t.trimInSec + position;
        const end = t.trimOutSec ?? t.buffer.duration;
        const dur = Math.max(0, end - t.trimInSec - position);
        if (dur > 0) t.player.start(restartAt, offset, dur);
      }
      transport.start(restartAt, position);
    }
  }

  setBpm(bpm: number) {
    Tone.getTransport().bpm.value = bpm;
  }

  setTimeSignature(signature: TimeSignature) {
    this.timeSignature = { ...signature };
    Tone.getTransport().timeSignature = [
      signature.numerator,
      signature.denominator,
    ];
    if (this.metronomeOn) this.rebuildMetronomeLoop();
  }

  bpm() {
    return Tone.getTransport().bpm.value;
  }

  recordingStartOffsetFromToneNow() {
    return TRANSPORT_SCHEDULE_MARGIN_SEC + RECORDING_START_AHEAD_SEC;
  }

  playStartOffsetFromToneNow() {
    return TRANSPORT_SCHEDULE_MARGIN_SEC;
  }

  // ---- Metronome ----
  private ensureMetronomeSynth(): Tone.MembraneSynth {
    if (this.metronomeSynth) return this.metronomeSynth;
    const synth = new Tone.MembraneSynth({
      pitchDecay: 0.01,
      octaves: 2,
      envelope: { attack: 0.001, decay: 0.1, sustain: 0, release: 0.1 },
      volume: -10,
    });
    // Keep clicks on the same master/limiter/output-bridge path as tracks so
    // selected sinks and iOS recording routes hear the same signal.
    if (this.master) synth.connect(this.master);
    else synth.toDestination();
    this.metronomeSynth = synth;
    return synth;
  }

  setMetronome(enabled: boolean) {
    this.metronomeOn = enabled;
    if (enabled) {
      this.ensureMetronomeSynth();
      this.rebuildMetronomeLoop();
    } else {
      this.metronomeLoop?.dispose();
      this.metronomeLoop = null;
    }
  }

  private rebuildMetronomeLoop() {
    this.metronomeLoop?.dispose();
    const { numerator, denominator } = this.timeSignature;
    this.metronomeLoop = new Tone.Loop((time) => {
      const ticksPerPulse = Tone.getTransport().PPQ * (4 / denominator);
      const pulse = Math.round(
        Tone.getTransport().getTicksAtTime(time) / ticksPerPulse,
      );
      const note = pulse % numerator === 0 ? "C5" : "C4";
      this.metronomeSynth?.triggerAttackRelease(note, "16n", time);
    }, `${denominator}n`);
    this.metronomeLoop.start(0);
  }

  isMetronomeOn() {
    return this.metronomeOn;
  }

  tickClick(accent: boolean) {
    this.ensureMetronomeSynth().triggerAttackRelease(
      accent ? "C5" : "C4",
      "16n",
    );
  }

  // ---- Recording ----
  async listInputDevices(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === "audioinput");
  }

  async listOutputDevices(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === "audiooutput");
  }

  isOutputSelectionSupported(): boolean {
    if (typeof AudioContext !== "undefined") {
      const ctxSupport = typeof (
        AudioContext.prototype as unknown as { setSinkId?: unknown }
      ).setSinkId === "function";
      if (ctxSupport) return true;
    }
    if (typeof HTMLMediaElement !== "undefined") {
      return typeof (
        HTMLMediaElement.prototype as unknown as { setSinkId?: unknown }
      ).setSinkId === "function";
    }
    return false;
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    await this.start();
    const ctx = this.nativeCtx as AudioContext & {
      setSinkId?: (id: string) => Promise<void>;
    };
    const sinkId = deviceId === "default" ? "" : deviceId;
    // Prefer the AudioContext route when the browser exposes it — the mix
    // stays on the native destination and the bridge can stay muted.
    if (typeof ctx.setSinkId === "function") {
      await ctx.setSinkId(sinkId);
      this.activeSinkRoute = "ctx";
      // Bridge can sleep — restore the recording-only behavior.
      if (this.outputBridgeEl && this.outputBridgeRefs === 0) {
        this.outputBridgeEl.muted = true;
      }
      // Make sure native destination is audible.
      try {
        Tone.getDestination().mute = false;
      } catch {
        // ignore
      }
      return;
    }
    // Fallback: route through the bridge audio element. Requires the bridge
    // to be installed (engine.start sets it up), and HTMLMediaElement to
    // support setSinkId (Safari 17+, Chromium, etc.).
    const bridge = this.outputBridgeEl as HTMLAudioElement & {
      setSinkId?: (id: string) => Promise<void>;
    } | null;
    if (!bridge || typeof bridge.setSinkId !== "function") {
      throw new Error("Output device selection is not supported in this browser");
    }
    await bridge.setSinkId(sinkId);
    bridge.muted = false;
    try {
      await bridge.play();
    } catch (err) {
      // Keep the native destination audible if autoplay policy prevents the
      // selected sink from starting.
      bridge.muted = true;
      throw err;
    }
    // Silence the native destination so we don't double-play through the
    // browser's default speakers and the user's chosen sink.
    try {
      Tone.getDestination().mute = true;
    } catch {
      // ignore
    }
    this.activeSinkRoute = "bridge";
  }

  getOutputDeviceId(): string {
    if (this.activeSinkRoute === "bridge") {
      const bridge = this.outputBridgeEl as HTMLAudioElement & {
        sinkId?: string;
      } | null;
      const id = bridge?.sinkId ?? "";
      return id ? id : "default";
    }
    const ctx = this.nativeCtx as
      | (AudioContext & { sinkId?: string })
      | null;
    if (!ctx) return "default";
    const id = ctx.sinkId;
    return !id || id === "" ? "default" : id;
  }

  async requestMicPermission(): Promise<void> {
    // Triggers the OS prompt so subsequent enumerateDevices() returns labels.
    // Hint the high-fidelity record profile before the prompt so iOS doesn't
    // demote the audio session, then immediately revert to playback once
    // the probe stream is closed — we're not actually capturing here.
    setAudioSessionType("play-and-record");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } finally {
      this.syncAudioSessionType();
    }
  }

  private async openRecordingSession(
    trackId: TrackId,
    deviceId?: string,
    gainValue = 1,
    onInterrupted?: (interruption: RecordingInterruption) => void,
  ): Promise<RecordingSession> {
    const track = this.tracks.get(trackId);
    if (!track) throw new Error(`No track ${trackId}`);
    if (typeof MediaRecorder === "undefined") {
      throw new Error("MediaRecorder is not supported in this browser");
    }
    const audioSessionToken = this.acquireRecordingAudioSession();
    try {
      await this.start();
    } catch (err) {
      this.releaseRecordingAudioSession(audioSessionToken);
      throw err;
    }
    // Tell WebKit we are about to record. This selects the high-fidelity
    // play-and-record profile rather than the voice-call category that iOS
    // would otherwise default to (which forces the bottom mic and clamps
    // bandwidth to ~8 kHz).
    this.syncAudioSessionType();
    // Engage the output bridge before getUserMedia so the audio session is
    // established with the loud-speaker route already in place on iOS.
    this.enableOutputBridge();
    let bridgeOpen = true;
    const releaseBridgeOnError = (err: unknown) => {
      if (bridgeOpen) {
        this.disableOutputBridge();
        bridgeOpen = false;
      }
      this.releaseRecordingAudioSession(audioSessionToken);
      throw err;
    };
    // Disable browser DSP — AGC chases the backing track and pumps the
    // noise floor, while echoCancellation/noiseSuppression add latency
    // and color the signal. Fine for VOIP, bad for music. Wrap each
    // boolean in `{ exact: false }` so browsers that interpret the bare
    // false as "don't care" still definitively disable the processing.
    // Sample rate and channel count are expressed as `ideal` so devices
    // that can't hit 48 kHz (Bluetooth HFP mics top out at 16 kHz) still
    // produce a stream instead of NotReadableError.
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: { exact: false },
      noiseSuppression: { exact: false },
      autoGainControl: { exact: false },
      sampleRate: { ideal: 48_000 },
      channelCount: { ideal: 2 },
    };
    if (deviceId && deviceId !== "default") {
      audioConstraints.deviceId = { exact: deviceId };
    }
    const stream = await navigator.mediaDevices
      .getUserMedia({ audio: audioConstraints })
      .catch(releaseBridgeOnError) as MediaStream;
    const setupNodes: AudioNode[] = [];
    try {
    // iOS suspends the AudioContext when it switches the audio session to
    // "play and record" during getUserMedia.  Re-wake it here while we are
    // still inside the getUserMedia resolution chain (iOS treats this as an
    // extension of the original user gesture).
    if (this.nativeCtx && this.nativeCtx.state !== "running") {
      await this.nativeCtx.resume().catch(() => {});
    }
    // Probe the device's actual ceiling and force it. getCapabilities()
    // tells us the real maximum the OS will give us for this mic — for
    // the iPhone built-in mic that's 48 kHz stereo, for AirPods over HFP
    // it's 16 kHz mono (a hard Bluetooth-protocol limit), and for USB
    // interfaces it can be 96 kHz.  Try `exact` first so the device is
    // pushed to the top of its range; fall back to `ideal` so devices
    // that refuse to be pinned still produce a stream.
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      type SampleRateRange = { max?: number };
      type ChannelRange = { max?: number };
      const caps = (audioTrack.getCapabilities?.() ?? {}) as MediaTrackCapabilities & {
        sampleRate?: SampleRateRange;
        channelCount?: ChannelRange;
      };
      const targetRate = Math.max(caps.sampleRate?.max ?? 0, 48_000);
      const targetChannels = Math.min(2, caps.channelCount?.max ?? 2);
      try {
        await audioTrack.applyConstraints({
          sampleRate: { exact: targetRate },
          channelCount: { exact: targetChannels },
        });
      } catch {
        try {
          await audioTrack.applyConstraints({
            sampleRate: { ideal: targetRate },
            channelCount: { ideal: targetChannels },
          });
        } catch {
          // Stuck at whatever the OS opened the stream at.
        }
      }
    }
    const capturedSampleRate =
      audioTrack?.getSettings().sampleRate ?? this.context().sampleRate;

    // Some platforms (notably iOS Safari) suspend the AudioContext when a
    // mic stream opens. Resume here so playback of other tracks continues
    // through speakers/headphones during recording.
    if (this.nativeCtx && this.nativeCtx.state === "suspended") {
      try {
        await this.nativeCtx.resume();
      } catch {
        // ignore
      }
    }

    const ctx = this.context();
    const source = ctx.createMediaStreamSource(stream);
    setupNodes.push(source);
    const analyser = ctx.createAnalyser();
    setupNodes.push(analyser);
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    // Force the analyser to be pulled by the audio graph so it actually
    // updates its time-domain buffer (used by the live waveform).
    const sink = ctx.createGain();
    setupNodes.push(sink);
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    source.connect(analyser);
    analyser.connect(sink);

    // Recorder reads the raw mic stream — Web Audio is only used for the
    // level meter / live waveform tap above. Routing the recording through
    // the AudioContext would resample to its rate (24 kHz on iOS speaker
    // route), gutting the high-frequency content. Gain is applied on the
    // decoded buffer in finalizeSession instead, so we don't need a
    // brickwall limiter to catch peaks during capture.
    const mimeType = pickRecorderMimeType();
    const options: MediaRecorderOptions = {
      audioBitsPerSecond: DEFAULT_RECORDER_BITRATE,
    };
    if (mimeType) options.mimeType = mimeType;
    const recorder = new MediaRecorder(stream, options);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    // iOS Safari workaround: when getUserMedia is active the audio session
    // Speaker routing during recording is handled by the master output
    // bridge (engine.start installs it as an <audio> element consuming the
    // mix stream). The earlier mic-stream router was removed because
    // consuming the mic stream through an HTMLAudioElement on iOS can flip
    // the audio session into a low-rate voice profile that drags mic
    // capture down to ~16 kHz.
    const routerEl: HTMLAudioElement | null = null;

    let resolveStopped = () => {};
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    const session: RecordingSession = {
      trackId,
      audioSessionToken,
      stream,
      source,
      analyser,
      sink,
      inputGainValue: Math.max(0, gainValue),
      recorder,
      chunks,
      mimeType: recorder.mimeType || mimeType || "audio/webm",
      startedAt: ctx.currentTime,
      transportStartAt: null,
      capturedSampleRate,
      routerEl,
      expectedStop: false,
      interruptionReported: false,
      stopped,
      resolveStopped,
      cleanupInterruptionListeners: () => {},
    };
    const reportInterruption = (
      reason: RecordingInterruption["reason"],
      error?: Error,
    ) => {
      if (session.expectedStop || session.interruptionReported) return;
      session.interruptionReported = true;
      queueMicrotask(() => onInterrupted?.({ trackId, reason, error }));
    };
    const onTrackEnded = () => reportInterruption("input-ended");
    const onRecorderError = (event: Event) => {
      const recorderError = (event as Event & { error?: DOMException }).error;
      reportInterruption(
        "recorder-error",
        recorderError
          ? new Error(recorderError.message, { cause: recorderError })
          : new Error("The browser reported a recording error"),
      );
    };
    const onRecorderStop = () => {
      session.resolveStopped();
      reportInterruption("recorder-stopped");
    };
    audioTrack?.addEventListener("ended", onTrackEnded);
    recorder.addEventListener("error", onRecorderError);
    recorder.addEventListener("stop", onRecorderStop);
    session.cleanupInterruptionListeners = () => {
      audioTrack?.removeEventListener("ended", onTrackEnded);
      recorder.removeEventListener("error", onRecorderError);
      recorder.removeEventListener("stop", onRecorderStop);
    };
    return session;
    } catch (err) {
      for (const node of setupNodes.reverse()) {
        try {
          node.disconnect();
        } catch {
          // Ignore partially connected graph nodes.
        }
      }
      stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // Ignore a track that already ended during setup.
        }
      });
      if (bridgeOpen) {
        this.disableOutputBridge();
        bridgeOpen = false;
      }
      this.releaseRecordingAudioSession(audioSessionToken);
      throw err;
    }
  }

  capturedSampleRate(trackId: TrackId): number | null {
    const session =
      this.recording?.trackId === trackId
        ? this.recording
        : this.multiRecording.get(trackId);
    return session?.capturedSampleRate ?? null;
  }

  private startSession(session: RecordingSession) {
    // Don't pass a timeslice. With one, MediaRecorder fires `dataavailable`
    // every N ms with a chunk and we concatenate them via new Blob([...]) at
    // stop time — but on Safari/iOS the per-chunk MP4 fragments aren't
    // reliably concatenable (only the first carries the moov header), so the
    // decoder produces audible glitches at every boundary, heard as periodic
    // clicks/clipping. Letting the recorder buffer the whole session and
    // emit a single blob on stop keeps the container intact.
    session.startedAt = this.context().currentTime;
    session.recorder.start();
  }

  private async stopSessionRecorder(session: RecordingSession): Promise<void> {
    session.expectedStop = true;
    if (session.recorder.state !== "inactive") {
      try {
        session.recorder.stop();
      } catch {
        session.resolveStopped();
      }
    }
    await session.stopped;
  }

  private releaseSession(session: RecordingSession) {
    session.expectedStop = true;
    session.cleanupInterruptionListeners();
    disconnectSessionNodes(session);
    session.stream.getTracks().forEach((t) => t.stop());
    this.disableOutputBridge();
    this.releaseRecordingAudioSession(session.audioSessionToken);
  }

  private async decodeSession(session: RecordingSession): Promise<AudioBuffer | null> {
    if (session.chunks.length === 0) {
      throw Object.assign(new Error("Recording captured no audio"), {
        name: "EmptyRecordingError",
      });
    }
    const blob = new Blob(session.chunks, { type: session.mimeType });
    let buf: AudioBuffer;
    try {
      const arr = await blob.arrayBuffer();
      buf = await decodeRecording(arr, session.capturedSampleRate);
    } catch (err) {
      console.error("Failed to decode recording", err);
      throw Object.assign(
        new Error(
          err instanceof Error ? err.message : "Could not decode the recording",
        ),
        { name: "DecodeFailedError" },
      );
    }
    const scheduledLead = Math.max(
      0,
      (session.transportStartAt ?? session.startedAt) - session.startedAt,
    );
    if (!hasUsableRecordingAfterLead(buf.duration, scheduledLead)) {
      throw Object.assign(new Error("Recording captured no audio"), {
        name: "EmptyRecordingError",
      });
    }
    buf = trimBufferStart(buf, scheduledLead);
    buf = applyInputGain(buf, session.inputGainValue);

    // Return an unattached buffer. The state layer first saves the take, then
    // validates the project/track and swaps the engine plus metadata together
    // on its serialized commit boundary.
    return buf;
  }

  private async finalizeSession(session: RecordingSession): Promise<AudioBuffer | null> {
    await this.stopSessionRecorder(session);
    this.releaseSession(session);
    this.maybeRestorePlaybackSession();
    return this.decodeSession(session);
  }

  private abortAllRecording() {
    const sessions: RecordingSession[] = [];
    if (this.recording) sessions.push(this.recording);
    sessions.push(...this.multiRecording.values());
    this.recording = null;
    this.multiRecording.clear();
    for (const s of sessions) {
      s.expectedStop = true;
      s.cleanupInterruptionListeners();
      try {
        if (s.recorder.state !== "inactive") s.recorder.stop();
        else s.resolveStopped();
      } catch {
        s.resolveStopped();
      }
      disconnectSessionNodes(s);
      s.stream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          // ignore
        }
      });
      this.disableOutputBridge();
      this.releaseRecordingAudioSession(s.audioSessionToken);
    }
    if (sessions.length > 0) this.maybeRestorePlaybackSession();
  }

  // Switch the iOS audio session back to high-fidelity playback once no
  // session is left active. Guards against flipping while another track
  // is still recording in a multi-record run.
  private maybeRestorePlaybackSession() {
    this.syncAudioSessionType();
  }

  async startRecording(
    trackId: TrackId,
    deviceId?: string,
    inputGain = 1,
    signal?: AbortSignal,
    onInterrupted?: (interruption: RecordingInterruption) => void,
  ): Promise<void> {
    this.abortAllRecording();
    throwIfRecordingStartAborted(signal);
    const session = await this.openRecordingSession(
      trackId,
      deviceId,
      inputGain,
      onInterrupted,
    );
    try {
      throwIfRecordingStartAborted(signal);
      this.recording = session;
      this.startSession(session);
      // Start playback of any existing tracks so the user can record along to
      // them. Without this, single-track recording is silent against the mix.
      session.transportStartAt = await this.play(RECORDING_START_AHEAD_SEC);
      throwIfRecordingStartAborted(signal);
    } catch (err) {
      this.recording = null;
      this.releaseSession(session);
      this.maybeRestorePlaybackSession();
      this.stop();
      throw err;
    }
  }

  async startMultiRecording(
    requests: Array<{ trackId: TrackId; deviceId?: string; inputGain?: number }>,
    signal?: AbortSignal,
    onInterrupted?: (interruption: RecordingInterruption) => void,
    beforeStart?: () => Promise<void>,
  ): Promise<void> {
    this.abortAllRecording();
    throwIfRecordingStartAborted(signal);
    if (requests.length === 0) return;
    const sessions: RecordingSession[] = [];
    try {
      for (const r of requests) {
        sessions.push(
          await this.openRecordingSession(
            r.trackId,
            r.deviceId,
            r.inputGain ?? 1,
            onInterrupted,
          ),
        );
        // getUserMedia itself cannot be cancelled consistently across
        // browsers. Check immediately after each acquisition so Stop still
        // closes a stream that resolves after the user cancelled.
        throwIfRecordingStartAborted(signal);
      }
    } catch (err) {
      for (const s of sessions) {
        this.releaseSession(s);
      }
      this.maybeRestorePlaybackSession();
      throw err;
    }
    for (const s of sessions) this.multiRecording.set(s.trackId, s);
    // Always restart playback from the beginning when recording starts.
    // transport.pause() would keep the playhead at its current position:
    // if the user played all the way to the end of their tracks and then
    // pressed Record, transport.seconds could be past every track's end,
    // making dur = 0 for all of them and producing silence.
    // transport.stop() resets seconds to 0 so the offset calculation in
    // play() always yields a positive duration.
    this.stop();
    try {
      throwIfRecordingStartAborted(signal);
      await beforeStart?.();
      throwIfRecordingStartAborted(signal);
      for (const s of sessions) this.startSession(s);
      const transportStartAt = await this.play(RECORDING_START_AHEAD_SEC);
      for (const s of sessions) s.transportStartAt = transportStartAt;
      throwIfRecordingStartAborted(signal);
    } catch (err) {
      this.abortAllRecording();
      this.stop();
      throw err;
    }
  }

  async stopMultiRecording(): Promise<{
    results: Map<TrackId, AudioBuffer | null>;
    errors: Map<TrackId, Error>;
  }> {
    const results = new Map<TrackId, AudioBuffer | null>();
    const errors = new Map<TrackId, Error>();
    if (this.multiRecording.size === 0) return { results, errors };
    const sessions = [...this.multiRecording.values()];

    // Tell every recorder to stop before waiting for any decoding. Stopping
    // and decoding one session at a time lets the remaining recorders keep
    // capturing for the full decode duration, which produces misaligned takes.
    await Promise.all(sessions.map((session) => this.stopSessionRecorder(session)));
    for (const session of sessions) this.releaseSession(session);
    this.multiRecording.clear();
    this.maybeRestorePlaybackSession();
    this.pause();

    await Promise.all(
      sessions.map(async (session) => {
        try {
          results.set(session.trackId, await this.decodeSession(session));
        } catch (err) {
          errors.set(
            session.trackId,
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      }),
    );
    return { results, errors };
  }

  isMultiRecording() {
    return this.multiRecording.size > 0;
  }

  getRecordingAnalyser(trackId: TrackId): AnalyserNode | null {
    if (this.recording?.trackId === trackId) return this.recording.analyser;
    return this.multiRecording.get(trackId)?.analyser ?? null;
  }

  setRecordingInputGain(trackId: TrackId, value: number) {
    const session =
      this.recording?.trackId === trackId
        ? this.recording
        : this.multiRecording.get(trackId);
    if (!session) return;
    session.inputGainValue = Math.max(0, value);
  }

  async stopRecording(): Promise<AudioBuffer | null> {
    const session = this.recording;
    if (!session) return null;
    this.recording = null;
    const buffer = await this.finalizeSession(session);
    this.pause();
    return buffer;
  }

  isRecording() {
    return this.recording !== null;
  }

  recordingTrackId() {
    return this.recording?.trackId ?? null;
  }
}

let _engine: AudioEngine | null = null;
export function getEngine() {
  if (!_engine) _engine = new AudioEngine();
  return _engine;
}
