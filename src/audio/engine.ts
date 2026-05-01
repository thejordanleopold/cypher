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
}

interface RecordingSession {
  trackId: TrackId;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  inputGain: GainNode;
  limiter: DynamicsCompressorNode;
  analyser: AnalyserNode;
  streamDest: MediaStreamAudioDestinationNode;
  recorder: MediaRecorder;
  chunks: Blob[];
  mimeType: string;
  startedAt: number;
}

const DEFAULT_RECORDER_BITRATE = 192_000;

function disconnectSessionNodes(session: RecordingSession) {
  for (const node of [
    session.analyser,
    session.limiter,
    session.inputGain,
    session.streamDest,
    session.source,
  ]) {
    try {
      node.disconnect();
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
      await Tone.start();
      this.master = new Tone.Gain(1);
      this.limiter = new Tone.Limiter(-1);
      this.master.connect(this.limiter);
      this.limiter.toDestination();
      this.started = true;
    }
  }

  isStarted() {
    return this.started;
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

  setVolume(id: TrackId, v: number) {
    const t = this.tracks.get(id);
    if (!t) return;
    t.volume = v;
    t.gain.gain.rampTo(t.muted ? 0 : v, 0.01);
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
    t.gain.gain.rampTo(muted ? 0 : t.volume, 0.01);
  }

  getTracks(): Track[] {
    return [...this.tracks.values()];
  }

  getTrack(id: TrackId) {
    return this.tracks.get(id);
  }

  async play() {
    await this.start();
    const transport = Tone.getTransport();
    if (transport.state === "started") return;
    const now = Tone.now() + 0.05;
    for (const t of this.tracks.values()) {
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
    if (typeof AudioContext === "undefined") return false;
    return (
      typeof (
        AudioContext.prototype as unknown as { setSinkId?: unknown }
      ).setSinkId === "function"
    );
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    await this.start();
    const ctx = this.nativeCtx as AudioContext & {
      setSinkId?: (id: string) => Promise<void>;
    };
    if (typeof ctx.setSinkId !== "function") {
      throw new Error("Output device selection is not supported in this browser");
    }
    await ctx.setSinkId(deviceId === "default" ? "" : deviceId);
  }

  getOutputDeviceId(): string {
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
    // Browser AGC tends to chase the backing track and pump the noise floor,
    // so we leave it off and apply our own gain + soft limiter below. We
    // also disable echoCancellation/noiseSuppression because they add
    // latency and color the signal — fine for VOIP, bad for music.
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    };
    if (deviceId && deviceId !== "default") {
      audioConstraints.deviceId = { exact: deviceId };
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
    });

    const ctx = this.context();
    const source = ctx.createMediaStreamSource(stream);
    const inputGain = ctx.createGain();
    inputGain.gain.value = Math.max(0, gainValue);
    // Soft brickwall: catches the peaks that the boosted gain would
    // otherwise clip, without audibly squashing the signal.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    const streamDest = ctx.createMediaStreamDestination();
    source.connect(inputGain);
    inputGain.connect(limiter);
    limiter.connect(analyser);
    analyser.connect(streamDest);

    const mimeType = pickRecorderMimeType();
    const options: MediaRecorderOptions = {
      audioBitsPerSecond: DEFAULT_RECORDER_BITRATE,
    };
    if (mimeType) options.mimeType = mimeType;
    const recorder = new MediaRecorder(streamDest.stream, options);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    return {
      trackId,
      stream,
      source,
      inputGain,
      limiter,
      analyser,
      streamDest,
      recorder,
      chunks,
      mimeType: recorder.mimeType || mimeType || "audio/webm",
      startedAt: ctx.currentTime,
    };
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

    if (session.chunks.length === 0) {
      throw Object.assign(new Error("Recording captured no audio"), {
        name: "EmptyRecordingError",
      });
    }
    const blob = new Blob(session.chunks, { type: session.mimeType });
    let buf: AudioBuffer;
    try {
      const arr = await blob.arrayBuffer();
      buf = await this.context().decodeAudioData(arr.slice(0));
    } catch (err) {
      console.error("Failed to decode recording", err);
      throw Object.assign(
        new Error(
          err instanceof Error ? err.message : "Could not decode the recording",
        ),
        { name: "DecodeFailedError" },
      );
    }

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
    session.inputGain.gain.setTargetAtTime(
      Math.max(0, value),
      session.inputGain.context.currentTime,
      0.01,
    );
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
