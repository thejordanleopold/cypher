import { create } from "zustand";
import { getEngine } from "@/audio/engine";
import { mixdown } from "@/audio/mixdown";
import { encodeBuffer, downloadBlob, type ExportFormat } from "@/audio/export";
import { audioBufferToWavBlob } from "@/audio/wav";
import {
  saveProject,
  loadProject,
  saveAudio,
  loadAudio,
  deleteAudio,
  listProjects,
  deleteProject as dbDeleteProject,
  duplicateProject,
  getCurrentProjectId,
  setCurrentProjectId,
  getOutputDeviceId,
  setOutputDeviceId,
  getDefaultInputDeviceId,
  setDefaultInputDeviceId,
  type PersistedProject,
  type PersistedTrack,
  type ProjectSummary,
} from "@/persistence/db";

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface Toast {
  id: number;
  variant: "info" | "warn" | "error";
  title: string;
  message?: string;
  ttlMs?: number;
}

let toastSeq = 0;

const DEFAULT_PROJECT_ID = "default";

export interface TrackState {
  id: string;
  name: string;
  hasAudio: boolean;
  fileName: string | null;
  durationSec: number;
  volume: number;
  pan: number;
  muted: boolean;
  soloed: boolean;
  bufferRevision: number;
  audioKey: string | null;
  trimInSec: number;
  trimOutSec: number | null;
  inputDeviceId: string;
  inputGain: number;
  armed: boolean;
  normalized: boolean;
  normalizationGain: number;
}

export const DEFAULT_INPUT_GAIN = 1;
export const MAX_INPUT_GAIN = 6;

interface CypherState {
  tracks: TrackState[];
  isPlaying: boolean;
  bpm: number;
  positionSec: number;
  metronomeOn: boolean;
  recordingTrackId: string | null;

  // Library
  currentProjectId: string;
  currentProjectName: string;
  projects: ProjectSummary[];
  isLoaded: boolean;
  refreshProjects: () => Promise<void>;
  createProject: (name?: string) => Promise<void>;
  openProject: (id: string) => Promise<void>;
  renameProject: (name: string) => Promise<void>;
  saveProjectAs: (name: string) => Promise<void>;
  deleteCurrentProject: () => Promise<void>;
  saveNow: () => Promise<void>;
  lastSavedAt: number | null;

  initProject: () => Promise<void>;
  addTrack: () => Promise<void>;
  removeTrack: (id: string) => Promise<void>;
  importFile: (id: string, file: File) => Promise<void>;
  setVolume: (id: string, v: number) => void;
  setPan: (id: string, p: number) => void;
  toggleMute: (id: string) => void;
  toggleSolo: (id: string) => void;
  setTrim: (id: string, inSec: number, outSec: number | null) => void;
  setInputDevice: (id: string, deviceId: string) => void;
  setInputGain: (id: string, gain: number) => void;
  inputDevices: MediaDeviceInfo[];
  refreshInputDevices: () => Promise<void>;
  defaultInputDeviceId: string;
  setDefaultInputDevice: (deviceId: string) => Promise<void>;

  outputDevices: MediaDeviceInfo[];
  currentOutputDeviceId: string;
  outputSelectable: boolean;
  refreshOutputDevices: () => Promise<void>;
  setOutputDevice: (deviceId: string) => Promise<void>;
  play: () => Promise<void>;
  pause: () => void;
  stop: () => void;
  seek: (seconds: number) => Promise<void>;
  setBpm: (bpm: number) => void;
  toggleMetronome: () => void;
  startRecording: (trackId: string) => Promise<void>;
  stopRecording: () => Promise<void>;
  toggleArm: (id: string) => void;
  toggleNormalize: (id: string) => void;
  isMultiRecording: boolean;

  countInBeats: number; // 0 = disabled, otherwise N beats of click before record
  setCountInBeats: (n: number) => void;
  countdownActive: boolean;
  countdownBeat: number;
  cancelCountdown: () => void;

  latencyOffsetMs: number;
  setLatencyOffsetMs: (ms: number) => void;
  calibrateLatency: (deviceId: string) => Promise<void>;
  isCalibrating: boolean;
  startArmedRecording: () => Promise<void>;
  stopArmedRecording: () => Promise<void>;

  exportProgress: number | null;
  exportMix: (format: ExportFormat) => Promise<void>;
  exportStems: (format: ExportFormat) => Promise<void>;

  toasts: Toast[];
  pushToast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;
}

let trackCounter = 0;
const nextId = () => `t${++trackCounter}`;

let initialized = false;
let initInFlight: Promise<void> | null = null;

export const useCypher = create<CypherState>((set, get) => ({
  tracks: [],
  isPlaying: false,
  bpm: 120,
  positionSec: 0,
  metronomeOn: false,
  recordingTrackId: null,
  exportProgress: null,
  inputDevices: [],
  defaultInputDeviceId: "default",
  outputDevices: [],
  currentOutputDeviceId: "default",
  outputSelectable: false,
  isMultiRecording: false,
  currentProjectId: DEFAULT_PROJECT_ID,
  currentProjectName: "Untitled",
  projects: [],
  isLoaded: false,
  lastSavedAt: null,
  toasts: [],
  countInBeats: 0,
  countdownActive: false,
  countdownBeat: 0,
  latencyOffsetMs: 0,
  isCalibrating: false,

  setCountInBeats: (n) => set({ countInBeats: Math.max(0, Math.min(8, n)) }),
  cancelCountdown: () => {
    countInCancelled = true;
  },
  setLatencyOffsetMs: (ms) =>
    set({ latencyOffsetMs: Math.max(-200, Math.min(500, Math.round(ms))) }),

  calibrateLatency: async (deviceId) => {
    if (get().isCalibrating) return;
    set({ isCalibrating: true });
    try {
      const ms = await measureLatency(deviceId);
      if (ms !== null) {
        set({ latencyOffsetMs: ms });
        get().pushToast({
          variant: "info",
          title: `Calibrated: ${ms} ms latency`,
          message:
            "Future recordings will be shifted earlier by this amount so they line up with playback.",
          ttlMs: 6000,
        });
      } else {
        get().pushToast({
          variant: "warn",
          title: "Calibration failed",
          message:
            "Couldn't detect the click in the mic input. Make sure your phone speaker (or headphone leak) is loud enough for the mic to hear it, and try again.",
          ttlMs: 8000,
        });
      }
    } finally {
      set({ isCalibrating: false });
    }
  },

  pushToast: (t) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, ...t }] }));
    const ttl = t.ttlMs ?? 6000;
    if (ttl > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
      }, ttl);
    }
  },
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),

  initProject: async () => {
    if (initInFlight) return initInFlight;
    if (initialized && get().tracks.length > 0) return;
    initInFlight = (async () => {
      const savedId = (await getCurrentProjectId()) ?? DEFAULT_PROJECT_ID;
      await loadProjectIntoEngine(savedId, set);
      await get().refreshProjects();
      // Restore the previously chosen output device, if any. Best-effort:
      // a device id from a previous session may no longer be present (USB
      // unplugged, headphones gone), in which case setSinkId fails and we
      // silently fall back to the system default.
      const savedOutput = await getOutputDeviceId();
      if (savedOutput && getEngine().isOutputSelectionSupported()) {
        try {
          await getEngine().setOutputDevice(savedOutput);
          set({
            currentOutputDeviceId: savedOutput,
            outputSelectable: true,
          });
        } catch {
          // ignore; fall back to default
        }
      } else {
        set({ outputSelectable: getEngine().isOutputSelectionSupported() });
      }
      const savedInput = await getDefaultInputDeviceId();
      if (savedInput) set({ defaultInputDeviceId: savedInput });
      // Hot-plugging headphones / AirPods should make them show up in the
      // mic picker without the user having to reopen anything.
      if (
        typeof navigator !== "undefined" &&
        navigator.mediaDevices?.addEventListener
      ) {
        navigator.mediaDevices.addEventListener("devicechange", () => {
          useCypher.getState().refreshInputDevices();
          useCypher.getState().refreshOutputDevices();
        });
      }
      initialized = true;
    })();
    try {
      await initInFlight;
    } finally {
      initInFlight = null;
    }
  },

  refreshProjects: async () => {
    const projects = await listProjects();
    set({ projects });
  },

  createProject: async (name = "Untitled") => {
    const id = makeId();
    await switchToProject(id, name, /* initialTracks */ true, set);
    await get().refreshProjects();
  },

  openProject: async (id) => {
    if (id === get().currentProjectId) return;
    await loadProjectIntoEngine(id, set);
    await get().refreshProjects();
  },

  renameProject: async (name) => {
    set({ currentProjectName: name });
    schedulePersist(get());
    // Reflect immediately in summaries.
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === s.currentProjectId ? { ...p, name } : p,
      ),
    }));
  },

  saveProjectAs: async (name) => {
    const sourceId = get().currentProjectId;
    // Flush pending auto-save first so the duplicate captures the latest.
    await flushPersist();
    const newId = makeId();
    const copy = await duplicateProject(sourceId, newId, name);
    if (!copy) return;
    await setCurrentProjectId(newId);
    set({ currentProjectId: newId, currentProjectName: name });
    await get().refreshProjects();
  },

  saveNow: async () => {
    await flushPersist();
    set({ lastSavedAt: Date.now() });
  },

  deleteCurrentProject: async () => {
    const id = get().currentProjectId;
    await dbDeleteProject(id);
    // Open another project, or create a fresh one.
    const remaining = await listProjects();
    if (remaining.length > 0) {
      await loadProjectIntoEngine(remaining[0].id, set);
    } else {
      await switchToProject(DEFAULT_PROJECT_ID, "Untitled", true, set);
    }
    await get().refreshProjects();
  },

  addTrack: async () => {
    const id = nextId();
    const name = `Track ${get().tracks.length + 1}`;
    await getEngine().addTrack(id, name);
    const t = emptyTrack(id, name);
    t.inputDeviceId = get().defaultInputDeviceId;
    set((s) => ({ tracks: [...s.tracks, t] }));
    schedulePersist(get());
  },

  removeTrack: async (id) => {
    const t = get().tracks.find((x) => x.id === id);
    getEngine().removeTrack(id);
    if (t?.audioKey) await deleteAudio(t.audioKey);
    set((s) => ({ tracks: s.tracks.filter((x) => x.id !== id) }));
    schedulePersist(get());
  },

  importFile: async (id, file) => {
    const buf = await getEngine().loadFileToTrack(id, file);
    const prev = get().tracks.find((t) => t.id === id);
    if (prev?.audioKey) await deleteAudio(prev.audioKey);
    const audioKey = `audio:${get().currentProjectId}:${id}:${Date.now()}`;
    await saveAudio(audioKey, audioBufferToWavBlob(buf));
    set((s) => ({
      tracks: s.tracks.map((t) =>
        t.id === id
          ? {
              ...t,
              hasAudio: true,
              fileName: file.name,
              durationSec: buf.duration,
              bufferRevision: t.bufferRevision + 1,
              audioKey,
              trimInSec: 0,
              trimOutSec: null,
            }
          : t,
      ),
    }));
    schedulePersist(get());
  },

  setVolume: (id, v) => {
    getEngine().setVolume(id, v);
    set((s) => ({
      tracks: s.tracks.map((t) => (t.id === id ? { ...t, volume: v } : t)),
    }));
    schedulePersist(get());
  },

  setPan: (id, p) => {
    getEngine().setPan(id, p);
    set((s) => ({
      tracks: s.tracks.map((t) => (t.id === id ? { ...t, pan: p } : t)),
    }));
    schedulePersist(get());
  },

  toggleMute: (id) => {
    const t = get().tracks.find((x) => x.id === id);
    if (!t) return;
    const muted = !t.muted;
    set((s) => ({
      tracks: s.tracks.map((x) => (x.id === id ? { ...x, muted } : x)),
    }));
    applyMixState(get().tracks);
    schedulePersist(get());
  },

  setInputDevice: (id, deviceId) => {
    set((s) => ({
      tracks: s.tracks.map((t) =>
        t.id === id ? { ...t, inputDeviceId: deviceId } : t,
      ),
    }));
    schedulePersist(get());
  },

  setInputGain: (id, gain) => {
    const clamped = Math.max(0, Math.min(MAX_INPUT_GAIN, gain));
    getEngine().setRecordingInputGain(id, clamped);
    set((s) => ({
      tracks: s.tracks.map((t) =>
        t.id === id ? { ...t, inputGain: clamped } : t,
      ),
    }));
    schedulePersist(get());
  },

  setDefaultInputDevice: async (deviceId) => {
    await setDefaultInputDeviceId(deviceId);
    set((s) => ({
      defaultInputDeviceId: deviceId,
      tracks: s.tracks.map((t) => ({ ...t, inputDeviceId: deviceId })),
    }));
    schedulePersist(get());
  },

  refreshInputDevices: async () => {
    const engine = getEngine();
    let devices = await engine.listInputDevices();
    // If labels are blank, we lack permission — request once and re-enumerate.
    if (devices.length > 0 && devices.every((d) => !d.label)) {
      try {
        await engine.requestMicPermission();
        devices = await engine.listInputDevices();
      } catch {
        // User denied; keep unlabeled list.
      }
    }
    set({ inputDevices: devices });
  },

  refreshOutputDevices: async () => {
    const engine = getEngine();
    const supported = engine.isOutputSelectionSupported();
    if (!supported) {
      set({ outputSelectable: false, outputDevices: [] });
      return;
    }
    const devices = await engine.listOutputDevices();
    set({
      outputSelectable: true,
      outputDevices: devices,
      currentOutputDeviceId: engine.getOutputDeviceId(),
    });
  },

  setOutputDevice: async (deviceId) => {
    try {
      await getEngine().setOutputDevice(deviceId);
      await setOutputDeviceId(deviceId);
      set({ currentOutputDeviceId: deviceId });
    } catch (err) {
      get().pushToast({
        variant: "error",
        title: "Couldn't switch output",
        message:
          err instanceof Error ? err.message : "Output selection failed",
      });
    }
  },

  setTrim: (id, inSec, outSec) => {
    getEngine().setTrim(id, inSec, outSec);
    set((s) => ({
      tracks: s.tracks.map((t) =>
        t.id === id ? { ...t, trimInSec: inSec, trimOutSec: outSec } : t,
      ),
    }));
    schedulePersist(get());
  },

  toggleSolo: (id) => {
    const t = get().tracks.find((x) => x.id === id);
    if (!t) return;
    const soloed = !t.soloed;
    set((s) => ({
      tracks: s.tracks.map((x) => (x.id === id ? { ...x, soloed } : x)),
    }));
    applyMixState(get().tracks);
    schedulePersist(get());
  },

  play: async () => {
    await getEngine().play();
    set({ isPlaying: true });
  },

  pause: () => {
    getEngine().pause();
    set({ isPlaying: false });
  },

  stop: () => {
    getEngine().stop();
    set({ isPlaying: false, positionSec: 0 });
  },

  seek: async (seconds) => {
    await getEngine().seek(seconds);
    set({ positionSec: seconds });
  },

  setBpm: (bpm) => {
    getEngine().setBpm(bpm);
    set({ bpm });
    schedulePersist(get());
  },

  toggleMetronome: () => {
    const next = !get().metronomeOn;
    getEngine().setMetronome(next);
    set({ metronomeOn: next });
  },

  startRecording: async (trackId) => {
    // Kick the AudioContext awake inside the user gesture; once we await
    // anything (enumerateDevices, getUserMedia) iOS Safari treats it as
    // out-of-gesture and refuses to resume.
    void getEngine().start();
    await maybeWarnAboutBluetoothMic(get().pushToast);
    const t = get().tracks.find((x) => x.id === trackId);
    try {
      await getEngine().startRecording(
        trackId,
        t?.inputDeviceId,
        t?.inputGain ?? DEFAULT_INPUT_GAIN,
      );
      set({ recordingTrackId: trackId, isMultiRecording: false });
      maybeWarnAboutLowSampleRate(
        getEngine().capturedSampleRate(trackId),
        get().pushToast,
      );
    } catch (err) {
      get().pushToast(toastFromMicError(err));
    }
  },

  exportMix: async (format) => {
    set({ exportProgress: 0 });
    try {
      const buf = await mixdown(getEngine().getTracks());
      const blob = await encodeBuffer(buf, format, (p) =>
        set({ exportProgress: p }),
      );
      const projectName = get().currentProjectName.replace(/[^\w-]+/g, "_");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      downloadBlob(blob, `${projectName}-${stamp}.${format}`);
    } finally {
      set({ exportProgress: null });
    }
  },

  exportStems: async (format) => {
    const engine = getEngine();
    const playable = engine.getTracks().filter((t) => t.buffer);
    if (playable.length === 0) return;
    const projectName = get().currentProjectName.replace(/[^\w-]+/g, "_");
    set({ exportProgress: 0 });
    try {
      for (let i = 0; i < playable.length; i++) {
        const t = playable[i];
        const stemBuf = await mixdown([t]);
        const baseFraction = i / playable.length;
        const blob = await encodeBuffer(stemBuf, format, (p) =>
          set({ exportProgress: baseFraction + p / playable.length }),
        );
        const safeName = t.name.replace(/[^\w-]+/g, "_");
        downloadBlob(blob, `${projectName}-${safeName}.${format}`);
      }
    } finally {
      set({ exportProgress: null });
    }
  },

  toggleArm: (id) => {
    set((s) => ({
      tracks: s.tracks.map((t) =>
        t.id === id ? { ...t, armed: !t.armed } : t,
      ),
    }));
  },

  toggleNormalize: (id) => {
    const t = get().tracks.find((x) => x.id === id);
    if (!t || !t.hasAudio) return;
    const engine = getEngine();
    if (t.normalized) {
      // Revert to the original signal level.
      engine.setNormalizationGain(id, 1);
      set((s) => ({
        tracks: s.tracks.map((x) =>
          x.id === id ? { ...x, normalized: false, normalizationGain: 1 } : x,
        ),
      }));
      return;
    }
    const peak = engine.bufferPeak(id);
    if (peak <= 0) return;
    // Target -1 dBFS so a toggle followed by a quick volume nudge can't
    // overshoot 0 dBFS and hard-clip the limiter.
    const target = 0.89;
    const gain = Math.min(20, target / peak);
    engine.setNormalizationGain(id, gain);
    set((s) => ({
      tracks: s.tracks.map((x) =>
        x.id === id ? { ...x, normalized: true, normalizationGain: gain } : x,
      ),
    }));
  },

  startArmedRecording: async () => {
    // Kick the AudioContext awake inside the user gesture; once we await
    // anything (enumerateDevices, getUserMedia) iOS Safari treats it as
    // out-of-gesture and refuses to resume.
    void getEngine().start();
    await maybeWarnAboutBluetoothMic(get().pushToast);
    const beats = get().countInBeats;
    if (beats > 0) {
      const ok = await runCountIn(beats, get().bpm, set);
      if (!ok) return; // user cancelled
    }
    const all = get().tracks;
    let targets = all.filter((t) => t.armed);
    // If the user hasn't armed anything, default to all empty tracks so
    // pressing the master record on a fresh project Just Works without
    // overwriting any imported/recorded audio.
    if (targets.length === 0) targets = all.filter((t) => !t.hasAudio);
    // Reflect auto-arming in the UI so the user can see what's recording.
    if (targets.length > 0) {
      const ids = new Set(targets.map((t) => t.id));
      set((s) => ({
        tracks: s.tracks.map((t) =>
          ids.has(t.id) ? { ...t, armed: true } : t,
        ),
      }));
    }
    if (targets.length > 0) {
      try {
        await getEngine().startMultiRecording(
          targets.map((t) => ({
            trackId: t.id,
            deviceId: t.inputDeviceId,
            inputGain: t.inputGain,
          })),
        );
        set({ isMultiRecording: true, isPlaying: true, recordingTrackId: null });
        const rates = targets
          .map((t) => getEngine().capturedSampleRate(t.id))
          .filter((r): r is number => typeof r === "number");
        if (rates.length > 0) {
          maybeWarnAboutLowSampleRate(Math.min(...rates), get().pushToast);
        }
      } catch (err) {
        // Roll back any auto-arm we did so the user isn't stuck in an armed state.
        set((s) => ({
          tracks: s.tracks.map((t) => ({ ...t, armed: false })),
        }));
        get().pushToast(toastFromMicError(err));
      }
    } else {
      // All tracks already have audio; just play.
      await getEngine().play();
      set({ isPlaying: true });
    }
  },

  stopArmedRecording: async () => {
    let results = new Map<string, AudioBuffer | null>();
    let errors = new Map<string, Error>();
    try {
      const out = await getEngine().stopMultiRecording();
      results = out.results;
      errors = out.errors;
    } catch (err) {
      get().pushToast(toastFromCaptureError(err));
    }
    set({ isMultiRecording: false, isPlaying: false });
    for (const [trackId, err] of errors) {
      const t = get().tracks.find((x) => x.id === trackId);
      const toast = toastFromCaptureError(err);
      get().pushToast({
        ...toast,
        title: t ? `${t.name}: ${toast.title}` : toast.title,
      });
    }
    const updates = new Map<string, { audioKey: string; duration: number }>();
    for (const [trackId, buf] of results) {
      if (!buf) continue;
      const prev = get().tracks.find((t) => t.id === trackId);
      if (prev?.audioKey) await deleteAudio(prev.audioKey);
      const audioKey = `audio:${get().currentProjectId}:${trackId}:${Date.now()}`;
      await saveAudio(audioKey, audioBufferToWavBlob(buf));
      updates.set(trackId, { audioKey, duration: buf.duration });
    }
    if (updates.size > 0) {
      const latencySec = get().latencyOffsetMs / 1000;
      for (const [trackId, u] of updates) {
        const trimIn = Math.max(0, Math.min(u.duration, latencySec));
        getEngine().setTrim(trackId, trimIn, null);
      }
      set((s) => ({
        tracks: s.tracks.map((t) => {
          const u = updates.get(t.id);
          if (!u) return t;
          const trimIn = Math.max(0, Math.min(u.duration, latencySec));
          return {
            ...t,
            hasAudio: true,
            fileName: "Recording",
            durationSec: u.duration,
            bufferRevision: t.bufferRevision + 1,
            audioKey: u.audioKey,
            trimInSec: trimIn,
            trimOutSec: null,
          };
        }),
      }));
      schedulePersist(get());
    }
  },

  stopRecording: async () => {
    const id = get().recordingTrackId;
    let buf: AudioBuffer | null = null;
    try {
      buf = await getEngine().stopRecording();
    } catch (err) {
      get().pushToast(toastFromCaptureError(err));
    }
    set({ recordingTrackId: null });
    if (id && buf) {
      const prev = get().tracks.find((t) => t.id === id);
      if (prev?.audioKey) await deleteAudio(prev.audioKey);
      const audioKey = `audio:${get().currentProjectId}:${id}:${Date.now()}`;
      await saveAudio(audioKey, audioBufferToWavBlob(buf));
      const latencySec = get().latencyOffsetMs / 1000;
      const trimIn = Math.max(0, Math.min(buf.duration, latencySec));
      getEngine().setTrim(id, trimIn, null);
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === id
            ? {
                ...t,
                hasAudio: true,
                fileName: "Recording",
                durationSec: buf.duration,
                bufferRevision: t.bufferRevision + 1,
                audioKey,
                trimInSec: trimIn,
                trimOutSec: null,
              }
            : t,
        ),
      }));
      schedulePersist(get());
    }
  },
}));

function emptyTrack(id: string, name: string): TrackState {
  return {
    id,
    name,
    hasAudio: false,
    fileName: null,
    durationSec: 0,
    volume: 1,
    pan: 0,
    muted: false,
    soloed: false,
    bufferRevision: 0,
    audioKey: null,
    trimInSec: 0,
    trimOutSec: null,
    inputDeviceId: "default",
    inputGain: DEFAULT_INPUT_GAIN,
    armed: false,
    normalized: false,
    normalizationGain: 1,
  };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingFlush: (() => Promise<void>) | null = null;

interface PersistInput {
  currentProjectId: string;
  currentProjectName: string;
  tracks: TrackState[];
  bpm: number;
  latencyOffsetMs: number;
  countInBeats: number;
}

function buildPersisted(state: PersistInput): PersistedProject {
  return {
    id: state.currentProjectId,
    name: state.currentProjectName,
    bpm: state.bpm,
    tracks: state.tracks.map<PersistedTrack>((t) => ({
      id: t.id,
      name: t.name,
      fileName: t.fileName,
      hasAudio: t.hasAudio,
      durationSec: t.durationSec,
      volume: t.volume,
      pan: t.pan,
      muted: t.muted,
      soloed: t.soloed,
      audioKey: t.audioKey,
      trimInSec: t.trimInSec,
      trimOutSec: t.trimOutSec,
      inputDeviceId: t.inputDeviceId,
      inputGain: t.inputGain,
      armed: t.armed,
      normalized: t.normalized,
      normalizationGain: t.normalizationGain,
    })),
    createdAt: 0, // filled in by flush — preserves existing createdAt if present.
    updatedAt: Date.now(),
    latencyOffsetMs: state.latencyOffsetMs,
    countInBeats: state.countInBeats,
  };
}

function schedulePersist(state: PersistInput) {
  const flush = async () => {
    const built = buildPersisted(state);
    const existing = await loadProject(built.id);
    built.createdAt = existing?.createdAt ?? Date.now();
    await saveProject(built);
    useCypher.setState({ lastSavedAt: built.updatedAt });
  };
  pendingFlush = flush;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const f = pendingFlush;
    pendingFlush = null;
    if (f) await f();
  }, 400);
}

async function flushPersist() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const f = pendingFlush;
  pendingFlush = null;
  if (f) await f();
}

type Setter = {
  (
    partial:
      | Partial<CypherState>
      | ((s: CypherState) => Partial<CypherState>),
  ): void;
};

async function loadProjectIntoEngine(id: string, set: Setter) {
  const engine = getEngine();
  await flushPersist();
  engine.clearAllTracks();
  trackCounter = 0;

  const persisted = await loadProject(id);
  if (!persisted) {
    // No record under this id — create a fresh empty project.
    await switchToProject(id, "Untitled", true, set);
    return;
  }

  await engine.start();
  engine.setBpm(persisted.bpm);
  const restored: TrackState[] = [];
  for (const pt of persisted.tracks) {
    const numericId = Number(pt.id.replace(/^t/, "")) || 0;
    if (numericId > trackCounter) trackCounter = numericId;
    await engine.addTrack(pt.id, pt.name);
    engine.setVolume(pt.id, pt.volume);
    engine.setPan(pt.id, pt.pan);
    let hasAudio = false;
    let bufferRevision = 0;
    if (pt.audioKey) {
      const blob = await loadAudio(pt.audioKey);
      if (blob) {
        const file = new File([blob], pt.fileName ?? "audio.wav", {
          type: blob.type,
        });
        try {
          await engine.loadFileToTrack(pt.id, file);
          hasAudio = true;
          bufferRevision = 1;
        } catch {
          // Decoding failed; keep track but mark no audio.
        }
      }
    }
    if (hasAudio) {
      engine.setTrim(pt.id, pt.trimInSec ?? 0, pt.trimOutSec ?? null);
    }
    restored.push({
      id: pt.id,
      name: pt.name,
      hasAudio,
      fileName: pt.fileName,
      durationSec: pt.durationSec,
      volume: pt.volume,
      pan: pt.pan,
      muted: pt.muted,
      soloed: pt.soloed,
      bufferRevision,
      audioKey: pt.audioKey,
      trimInSec: pt.trimInSec ?? 0,
      trimOutSec: pt.trimOutSec ?? null,
      inputDeviceId: pt.inputDeviceId ?? "default",
      inputGain: pt.inputGain ?? DEFAULT_INPUT_GAIN,
      armed: pt.armed ?? false,
      normalized: pt.normalized ?? false,
      normalizationGain: pt.normalizationGain ?? 1,
    });
    if (hasAudio && pt.normalized && pt.normalizationGain && pt.normalizationGain !== 1) {
      engine.setNormalizationGain(pt.id, pt.normalizationGain);
    }
  }
  await setCurrentProjectId(id);
  set({
    tracks: restored,
    bpm: persisted.bpm,
    currentProjectId: id,
    currentProjectName: persisted.name,
    latencyOffsetMs: persisted.latencyOffsetMs ?? 0,
    countInBeats: persisted.countInBeats ?? 0,
    isPlaying: false,
    isMultiRecording: false,
    recordingTrackId: null,
    isLoaded: true,
  });
  applyMixState(restored);
}

async function switchToProject(
  id: string,
  name: string,
  withInitialTracks: boolean,
  set: Setter,
) {
  const engine = getEngine();
  await flushPersist();
  engine.clearAllTracks();
  trackCounter = 0;
  await engine.start();
  engine.setBpm(120);

  const tracks: TrackState[] = [];
  if (withInitialTracks) {
    const a = nextId();
    const b = nextId();
    await engine.addTrack(a, "Track 1");
    await engine.addTrack(b, "Track 2");
    tracks.push(emptyTrack(a, "Track 1"), emptyTrack(b, "Track 2"));
  }
  await setCurrentProjectId(id);
  set({
    tracks,
    bpm: 120,
    currentProjectId: id,
    currentProjectName: name,
    isPlaying: false,
    isMultiRecording: false,
    recordingTrackId: null,
    isLoaded: true,
  });
  schedulePersist({
    currentProjectId: id,
    currentProjectName: name,
    tracks,
    bpm: 120,
    latencyOffsetMs: 0,
    countInBeats: 0,
  });
  await flushPersist();
}

/**
 * Plays a series of short clicks to the speaker and records the mic at the
 * same time. Cross-correlates the recorded buffer against the expected
 * click times to estimate the round-trip latency in milliseconds.
 *
 * Best-effort. Requires getUserMedia permission. Returns null if the click
 * couldn't be detected (mic too quiet, headphones isolating the speaker, etc).
 */
async function measureLatency(deviceId: string): Promise<number | null> {
  const ctx = new AudioContext({ latencyHint: "interactive" });
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      // ignore
    }
  }
  const sampleRate = ctx.sampleRate;
  const beatMs = 500;
  const beats = 4;
  const totalSec = (beats * beatMs) / 1000 + 0.5;
  const totalSamples = Math.ceil(totalSec * sampleRate);

  let stream: MediaStream | null = null;
  let recorderSamples: Float32Array;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId === "default" ? undefined : { exact: deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    // Schedule N click bursts.
    const clickTimes: number[] = [];
    const startAt = ctx.currentTime + 0.2;
    for (let i = 0; i < beats; i++) {
      const at = startAt + i * (beatMs / 1000);
      clickTimes.push(at);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 1000;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(1, at + 0.001);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.04);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.05);
    }
    recorderSamples = await captureViaMediaRecorder(stream, totalSec);
    // Detect click peaks in recorded audio.
    const sampleClickWindow = Math.floor(0.06 * sampleRate);
    const peaks: number[] = [];
    let i = 0;
    const threshold = 0.1;
    while (i < recorderSamples.length) {
      const v = Math.abs(recorderSamples[i]);
      if (v > threshold) {
        // Find the local max in the next ~20 ms.
        let bestIdx = i;
        let bestVal = v;
        const windowEnd = Math.min(
          recorderSamples.length,
          i + Math.floor(0.02 * sampleRate),
        );
        for (let j = i + 1; j < windowEnd; j++) {
          if (Math.abs(recorderSamples[j]) > bestVal) {
            bestVal = Math.abs(recorderSamples[j]);
            bestIdx = j;
          }
        }
        peaks.push(bestIdx / sampleRate);
        i = bestIdx + sampleClickWindow;
      } else {
        i++;
      }
    }
    if (peaks.length < 2) return null;
    // Average the per-click delay (peak time minus click schedule time relative
    // to when recording started — we assume recorder started ~0 s into the buffer).
    let totalDelayMs = 0;
    let count = 0;
    for (let i = 0; i < Math.min(peaks.length, clickTimes.length); i++) {
      const expected = clickTimes[i] - startAt; // 0, 0.5, 1.0, ...
      const observed = peaks[i];
      const delayMs = (observed - expected) * 1000;
      if (delayMs > 0 && delayMs < 600) {
        totalDelayMs += delayMs;
        count++;
      }
    }
    if (count === 0) return null;
    return Math.round(totalDelayMs / count);
  } catch (err) {
    console.error("Latency calibration failed", err);
    return null;
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
    try {
      await ctx.close();
    } catch {
      // ignore
    }
  }
}

async function captureViaMediaRecorder(
  stream: MediaStream,
  durationSec: number,
): Promise<Float32Array> {
  const types = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/aac",
  ];
  const mime =
    types.find((t) => MediaRecorder.isTypeSupported(t)) ?? "audio/webm";
  const rec = new MediaRecorder(stream, { mimeType: mime });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data?.size > 0) chunks.push(e.data);
  };
  rec.start(50);
  await new Promise((r) => setTimeout(r, durationSec * 1000));
  await new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
    rec.stop();
  });
  const blob = new Blob(chunks, { type: mime });
  const ctx = new AudioContext();
  const arr = await blob.arrayBuffer();
  const buf = await ctx.decodeAudioData(arr);
  await ctx.close();
  return buf.getChannelData(0);
}

let countInCancelled = false;

async function runCountIn(
  beats: number,
  bpm: number,
  set: Setter,
): Promise<boolean> {
  const engine = getEngine();
  await engine.start();
  countInCancelled = false;
  const beatMs = 60_000 / bpm;
  for (let i = 0; i < beats; i++) {
    if (countInCancelled) {
      set({ countdownActive: false, countdownBeat: 0 });
      return false;
    }
    set({ countdownActive: true, countdownBeat: i + 1 });
    engine.tickClick(i % 4 === 0);
    await new Promise((r) => setTimeout(r, beatMs));
  }
  set({ countdownActive: false, countdownBeat: 0 });
  return true;
}

let lowRateWarnShown = false;
const LOW_RATE_THRESHOLD_HZ = 32_000;

function maybeWarnAboutLowSampleRate(
  rate: number | null,
  pushToast: (t: Omit<Toast, "id">) => void,
) {
  if (lowRateWarnShown) return;
  if (typeof rate !== "number" || rate <= 0) return;
  if (rate >= LOW_RATE_THRESHOLD_HZ) return;
  lowRateWarnShown = true;
  const isHfp = rate <= 16_000;
  pushToast({
    variant: "warn",
    title: `Capturing at ${(rate / 1000).toFixed(1)} kHz`,
    message: isHfp
      ? "AirPods and other Bluetooth headsets max out at 16 kHz when used as a mic — that's a hardware limit. Plug in wired headphones or use the built-in mic for full-bandwidth audio."
      : "The OS handed us a low sample rate, usually because the speaker route is active. Plug in wired headphones, or pick a different mic in the picker, to get full quality.",
    ttlMs: 12_000,
  });
}

let bluetoothWarnShown = false;
const BLUETOOTH_PATTERN = /(bluetooth|airpods|beats|earbuds|wireless|hands.?free|sony|bose|jbl)/i;

async function maybeWarnAboutBluetoothMic(
  pushToast: (t: Omit<Toast, "id">) => void,
) {
  if (bluetoothWarnShown) return;
  try {
    const outputs = await getEngine().listOutputDevices();
    const inputs = await getEngine().listInputDevices();
    const btOutput = outputs.find(
      (d) => d.label && BLUETOOTH_PATTERN.test(d.label),
    );
    const btInput = inputs.find(
      (d) => d.label && BLUETOOTH_PATTERN.test(d.label),
    );
    // If we see a Bluetooth output but no matching Bluetooth input,
    // the headset is in A2DP-only mode — mic falls back to phone.
    if (btOutput && !btInput) {
      bluetoothWarnShown = true;
      pushToast({
        variant: "warn",
        title: "Bluetooth headset detected",
        message: `${btOutput.label} is your output, but iOS/Android won't expose its mic to web apps. Recording will use the phone's built-in mic. For clean overdubs, switch to wired headphones.`,
        ttlMs: 12000,
      });
    }
  } catch {
    // enumerateDevices can throw before permission is granted; ignore.
  }
}

function toastFromMicError(err: unknown): Omit<Toast, "id"> {
  const name = err instanceof Error ? err.name : "Error";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      variant: "error",
      title: "Mic permission denied",
      message:
        "Cypher can't record without mic access. Open your browser settings → Site settings → Microphone, then reload.",
      ttlMs: 12000,
    };
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return {
      variant: "error",
      title: "Mic not found",
      message:
        "The selected mic isn't available. Pick a different one with the 🎤 button on the track.",
      ttlMs: 10000,
    };
  }
  if (name === "NotReadableError") {
    return {
      variant: "error",
      title: "Mic is in use elsewhere",
      message:
        "Another app is holding the microphone. Close it (or another browser tab) and try again.",
      ttlMs: 10000,
    };
  }
  return {
    variant: "error",
    title: "Recording failed",
    message: err instanceof Error ? err.message : "Unknown error",
    ttlMs: 8000,
  };
}

function toastFromCaptureError(err: unknown): Omit<Toast, "id"> {
  const name = err instanceof Error ? err.name : "Error";
  if (name === "EmptyRecordingError") {
    return {
      variant: "warn",
      title: "No audio captured",
      message:
        "Nothing was recorded. Check the mic level and that the right input is selected.",
      ttlMs: 8000,
    };
  }
  if (name === "DecodeFailedError") {
    return {
      variant: "error",
      title: "Recording could not be decoded",
      message:
        "The captured audio file was unreadable. This is rare on iOS with very short clips — try recording for at least a second.",
      ttlMs: 10000,
    };
  }
  return {
    variant: "error",
    title: "Recording failed",
    message: err instanceof Error ? err.message : String(err),
    ttlMs: 8000,
  };
}

function applyMixState(tracks: TrackState[]) {
  const anySoloed = tracks.some((t) => t.soloed);
  const engine = getEngine();
  for (const t of tracks) {
    const audible = anySoloed ? t.soloed && !t.muted : !t.muted;
    engine.setMute(t.id, !audible);
  }
}
