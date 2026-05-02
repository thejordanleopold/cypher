import * as Tone from "tone";

export type TrackId = string;

export interface Track {
  id: TrackId;
  name: string;
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
}

interface RecordingSession {
  trackId: TrackId;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  sink: GainNode;
  inputGainValue: number;
  recorder: MediaRecorder;
  chunks: Blob[];
  mimeType: string;
  startedAt: number;
  capturedSampleRate: number;
  routerEl: HTMLAudioElement | null;
}

const DEFAULT_RECORDER_BITRATE = 512_000;
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

function createIosRouter(stream: MediaStream): HTMLAudioElement | null {
  if (typeof document === "undefined") return null;
  try {
    const el = document.createElement("audio");
    el.muted = true;
    el.autoplay = true;
    el.setAttribute("playsinline", "");
    el.setAttribute("webkit-playsinline", "");
    el.srcObject = stream;
    el.style.position = "fixed";
    el.style.width = "0";
    el.style.height = "0";
    el.style.opacity = "0";
    el.style.pointerEvents = "none";
    document.body.appendChild(el);
    el.play().catch(() => {
      // Autoplay may be blocked off-gesture; the muted hint usually allows
      // it, but failures here are non-fatal — we still capture audio.
    });
    return el;
  } catch {
    return null;
  }
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
  private limiter: Tone.Limiter | null = null;
  private tracks = new Map<TrackId, Track>();
  private started = false;
  private nativeCtx: AudioContext | null = null;
  private recording: RecordingSession | null = null;
  private multiRecording = new Map<TrackId, RecordingSession>();
  private metronomeSynth: Tone.MembraneSynth | null = null;
  private metronomeLoop: Tone.Loop | null = null;
  private metronomeOn = false;
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

  async start() {
    // Idempotent. Safe to call from any user gesture or even non-gesture
    // contexts — if the AudioContext was created suspended (which is the
    // case on iOS Safari until a real user gesture arrives), we'll attempt
    // to resume it on every call. Subsequent calls inside a real gesture
    // will succeed where earlier ones silently no-op'd.
    if (!this.nativeCtx) {
      this.nativeCtx = new AudioContext({ latencyHint: "interactive" });
      Tone.setContext(this.nativeCtx);
    }
    if (this.nativeCtx.state === "suspended") {
      try {
        await this.nativeCtx.resume();
      } catch {
        // Will retry on the next call (likely from a user gesture).
      }
    }
    if (!this.started) {
      // Create the graph nodes synchronously — Tone constructors are safe on
      // a suspended context. Only await Tone.start() once the context is
      // actually running (post-gesture), otherwise it blocks forever and
      // stalls callers like initProject.
      this.master = new Tone.Gain(1);
      this.limiter = new Tone.Limiter(-1);
      this.master.connect(this.limiter);
      this.limiter.toDestination();
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
    // Only unmute on browsers without ctx.setSinkId — i.e. iOS Safari, where
    // ctx.destination gets routed away during recording. On desktop and
    // Android Chrome, ctx.destination keeps working through the recording
    // session, so leaving the bridge muted avoids a double-output.
    const ctx = this.nativeCtx as AudioContext & {
      setSinkId?: (id: string) => Promise<void>;
    };
    const desktopRouteWorks = typeof ctx.setSinkId === "function";
    if (!desktopRouteWorks) {
      this.outputBridgeEl.muted = false;
      this.outputBridgeEl.play().catch(() => {
        // ignore — already playing or autoplay-blocked
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

  async addTrack(id: TrackId, name: string): Promise<Track> {
    await this.start();
    const gain = new Tone.Gain(1);
    const panner = new Tone.Panner(0);
    gain.connect(panner);
    if (this.master) panner.connect(this.master);
    const track: Track = {
      id,
      name,
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
    };
    this.tracks.set(id, track);
    return track;
  }

  removeTrack(id: TrackId) {
    const t = this.tracks.get(id);
    if (!t) return;
    t.player?.dispose();
    t.gain.dispose();
    t.panner.dispose();
    this.tracks.delete(id);
  }

  clearAllTracks() {
    this.abortAllRecording();
    Tone.getTransport().stop();
    for (const t of this.tracks.values()) {
      t.player?.dispose();
      t.gain.dispose();
      t.panner.dispose();
    }
    this.tracks.clear();
  }

  async loadFileToTrack(id: TrackId, file: File): Promise<AudioBuffer> {
    const t = this.tracks.get(id);
    if (!t) throw new Error(`No track ${id}`);
    const arrayBuf = await file.arrayBuffer();
    const audioBuf = await this.context().decodeAudioData(arrayBuf.slice(0));
    t.player?.dispose();
    const player = new Tone.Player(audioBuf);
    player.connect(t.gain);
    t.player = player;
    t.buffer = audioBuf;
    t.trimInSec = 0;
    t.trimOutSec = null;
    return audioBuf;
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

  async play() {
    await this.start();
    const transport = Tone.getTransport();
    if (transport.state === "started") return;
    const now = Tone.now() + 0.05;
    for (const t of this.tracks.values()) {
      // Don't sound a track that's actively being recorded — the previous
      // take would otherwise play back through the speaker and bleed into
      // the mic, fighting the new take we're trying to capture.
      if (this.isCapturing(t.id)) continue;
      if (t.player && t.buffer) {
        const offset = t.trimInSec + transport.seconds;
        const end = t.trimOutSec ?? t.buffer.duration;
        const dur = Math.max(0, end - t.trimInSec - transport.seconds);
        if (dur > 0) t.player.start(now, offset, dur);
      }
    }
    transport.start(now);
  }

  pause() {
    const transport = Tone.getTransport();
    transport.pause();
    for (const t of this.tracks.values()) t.player?.stop();
  }

  stop() {
    const transport = Tone.getTransport();
    transport.stop();
    for (const t of this.tracks.values()) t.player?.stop();
  }

  seconds() {
    return Tone.getTransport().seconds;
  }

  isPlaying(): boolean {
    return Tone.getTransport().state === "started";
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
    for (const t of this.tracks.values()) t.player?.stop();
    transport.pause();
    transport.seconds = Math.max(0, seconds);
    if (wasPlaying) {
      const now = Tone.now() + 0.05;
      for (const t of this.tracks.values()) {
        if (this.isCapturing(t.id)) continue;
        if (!t.player || !t.buffer) continue;
        const offset = t.trimInSec + transport.seconds;
        const end = t.trimOutSec ?? t.buffer.duration;
        const dur = Math.max(0, end - t.trimInSec - transport.seconds);
        if (dur > 0) t.player.start(now, offset, dur);
      }
      transport.start(now);
    }
  }

  setBpm(bpm: number) {
    Tone.getTransport().bpm.value = bpm;
  }

  bpm() {
    return Tone.getTransport().bpm.value;
  }

  // ---- Metronome ----
  setMetronome(enabled: boolean) {
    this.metronomeOn = enabled;
    if (enabled) {
      if (!this.metronomeSynth) {
        this.metronomeSynth = new Tone.MembraneSynth({
          pitchDecay: 0.01,
          octaves: 2,
          envelope: { attack: 0.001, decay: 0.1, sustain: 0, release: 0.1 },
          volume: -10,
        }).toDestination();
      }
      if (!this.metronomeLoop) {
        let beat = 0;
        this.metronomeLoop = new Tone.Loop((time) => {
          const note = beat % 4 === 0 ? "C5" : "C4";
          this.metronomeSynth?.triggerAttackRelease(note, "16n", time);
          beat++;
        }, "4n");
      }
      this.metronomeLoop.start(0);
    } else {
      this.metronomeLoop?.stop();
    }
  }

  isMetronomeOn() {
    return this.metronomeOn;
  }

  tickClick(accent: boolean) {
    if (!this.metronomeSynth) {
      this.metronomeSynth = new Tone.MembraneSynth({
        pitchDecay: 0.01,
        octaves: 2,
        envelope: { attack: 0.001, decay: 0.1, sustain: 0, release: 0.1 },
        volume: -10,
      }).toDestination();
    }
    this.metronomeSynth.triggerAttackRelease(accent ? "C5" : "C4", "16n");
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
      bridge.play();
    } catch {
      // ignore — autoplay race
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
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  }

  private async openRecordingSession(
    trackId: TrackId,
    deviceId?: string,
    gainValue = 1,
  ): Promise<RecordingSession> {
    await this.start();
    const track = this.tracks.get(trackId);
    if (!track) throw new Error(`No track ${trackId}`);
    if (typeof MediaRecorder === "undefined") {
      throw new Error("MediaRecorder is not supported in this browser");
    }
    // Engage the output bridge before getUserMedia so the audio session is
    // established with the loud-speaker route already in place on iOS.
    this.enableOutputBridge();
    let bridgeOpen = true;
    const releaseBridgeOnError = (err: unknown) => {
      if (bridgeOpen) {
        this.disableOutputBridge();
        bridgeOpen = false;
      }
      throw err;
    };
    // Disable browser DSP — AGC chases the backing track and pumps the
    // noise floor, while echoCancellation/noiseSuppression add latency
    // and color the signal. Fine for VOIP, bad for music. Sample rate
    // and channel count are expressed as `ideal` so devices that can't
    // hit 48 kHz (Bluetooth HFP mics top out at 16 kHz) still produce
    // a stream instead of NotReadableError.
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: { ideal: 48_000 },
      channelCount: { ideal: 2 },
    };
    if (deviceId && deviceId !== "default") {
      audioConstraints.deviceId = { exact: deviceId };
    }
    const stream = await navigator.mediaDevices
      .getUserMedia({ audio: audioConstraints })
      .catch(releaseBridgeOnError) as MediaStream;
    // iOS suspends the AudioContext when it switches the audio session to
    // "play and record" during getUserMedia.  Re-wake it here while we are
    // still inside the getUserMedia resolution chain (iOS treats this as an
    // extension of the original user gesture).
    if (this.nativeCtx && this.nativeCtx.state !== "running") {
      await this.nativeCtx.resume().catch(() => {});
    }
    // Some browsers honor a follow-up applyConstraints when they ignored
    // the initial ideal hint, so push once more before we start.
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      try {
        await audioTrack.applyConstraints({
          sampleRate: { ideal: 48_000 },
          channelCount: { ideal: 2 },
        });
      } catch {
        // Device can't move; the rate we already have stands.
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
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    // Force the analyser to be pulled by the audio graph so it actually
    // updates its time-domain buffer (used by the live waveform).
    const sink = ctx.createGain();
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

    return {
      trackId,
      stream,
      source,
      analyser,
      sink,
      inputGainValue: Math.max(0, gainValue),
      recorder,
      chunks,
      mimeType: recorder.mimeType || mimeType || "audio/webm",
      startedAt: ctx.currentTime,
      capturedSampleRate,
      routerEl,
    };
  }

  capturedSampleRate(trackId: TrackId): number | null {
    const session =
      this.recording?.trackId === trackId
        ? this.recording
        : this.multiRecording.get(trackId);
    return session?.capturedSampleRate ?? null;
  }

  private startSession(session: RecordingSession) {
    // 100 ms timeslice flushes data periodically so a forced abort still
    // surfaces something usable, and reduces final-blob assembly cost.
    session.recorder.start(100);
  }

  private async finalizeSession(session: RecordingSession): Promise<AudioBuffer | null> {
    if (session.recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        session.recorder.onstop = () => resolve();
        try {
          session.recorder.stop();
        } catch {
          resolve();
        }
      });
    }
    disconnectSessionNodes(session);
    session.stream.getTracks().forEach((t) => t.stop());
    this.disableOutputBridge();

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
    buf = applyInputGain(buf, session.inputGainValue);

    const track = this.tracks.get(session.trackId);
    if (track) {
      track.player?.dispose();
      const player = new Tone.Player(buf);
      player.connect(track.gain);
      track.player = player;
      track.buffer = buf;
      track.trimInSec = 0;
      track.trimOutSec = null;
    }
    return buf;
  }

  private abortAllRecording() {
    const sessions: RecordingSession[] = [];
    if (this.recording) sessions.push(this.recording);
    sessions.push(...this.multiRecording.values());
    this.recording = null;
    this.multiRecording.clear();
    for (const s of sessions) {
      try {
        if (s.recorder.state !== "inactive") s.recorder.stop();
      } catch {
        // ignore
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
    }
  }

  async startRecording(
    trackId: TrackId,
    deviceId?: string,
    inputGain = 1,
  ): Promise<void> {
    this.abortAllRecording();
    const session = await this.openRecordingSession(
      trackId,
      deviceId,
      inputGain,
    );
    this.recording = session;
    // Start playback of any existing tracks so the user can record along to
    // them. Without this, single-track recording is silent against the mix.
    await this.play();
    this.startSession(session);
  }

  async startMultiRecording(
    requests: Array<{ trackId: TrackId; deviceId?: string; inputGain?: number }>,
  ): Promise<void> {
    this.abortAllRecording();
    if (requests.length === 0) return;
    const sessions: RecordingSession[] = [];
    try {
      for (const r of requests) {
        sessions.push(
          await this.openRecordingSession(r.trackId, r.deviceId, r.inputGain ?? 1),
        );
      }
    } catch (err) {
      for (const s of sessions) {
        disconnectSessionNodes(s);
        s.stream.getTracks().forEach((t) => t.stop());
      }
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
    const transport = Tone.getTransport();
    transport.stop();
    for (const t of this.tracks.values()) t.player?.stop();
    await this.play();
    for (const s of sessions) this.startSession(s);
  }

  async stopMultiRecording(): Promise<{
    results: Map<TrackId, AudioBuffer | null>;
    errors: Map<TrackId, Error>;
  }> {
    const results = new Map<TrackId, AudioBuffer | null>();
    const errors = new Map<TrackId, Error>();
    if (this.multiRecording.size === 0) return { results, errors };
    const sessions = [...this.multiRecording.values()];
    this.multiRecording.clear();
    for (const s of sessions) {
      try {
        results.set(s.trackId, await this.finalizeSession(s));
      } catch (err) {
        errors.set(
          s.trackId,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }
    this.pause();
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
    return this.finalizeSession(session);
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
