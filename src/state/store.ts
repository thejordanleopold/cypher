import { create } from "zustand";
import { getEngine } from "@/audio/engine";
import { mixdown, type MixTrack } from "@/audio/mixdown";
import { encodeBuffer, downloadBlob, type ExportFormat } from "@/audio/export";
import { audioBufferToWavBlob } from "@/audio/wav";
import {
  saveProject,
  loadProject,
  saveAudio,
  loadAudio,
  deleteAudio,
  listAudioKeysForProject,
  makeAudioKey,
  makePadAudioKey,
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
  type PersistedSamplerPad,
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

export type TrackKind = "audio" | "sampler";

export const SAMPLER_BANK_COUNT = 4;
export const SAMPLER_BANK_SIZE = 8;
export const SAMPLER_PAD_COUNT = SAMPLER_BANK_COUNT * SAMPLER_BANK_SIZE; // 32 total

export interface SamplerPadState {
  hasAudio: boolean;
  fileName: string | null;
  durationSec: number;
  audioKey: string | null;
  bufferRevision: number;
}

export interface SamplerEvent {
  padIdx: number;
  timeSec: number;
}

export interface TrackState {
  id: string;
  name: string;
  kind: TrackKind;
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
  pads: SamplerPadState[];
  // Sampler pattern recording — session-only (not persisted to IndexedDB).
  samplerRecArmed: boolean;
  samplerPattern: SamplerEvent[];
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
  isDemoMode: boolean;
  refreshProjects: () => Promise<void>;
  createProject: (name?: string) => Promise<void>;
  startDemo: () => Promise<void>;
  openProject: (id: string) => Promise<void>;
  renameProject: (name: string) => Promise<void>;
  saveProjectAs: (name: string) => Promise<void>;
  deleteCurrentProject: () => Promise<void>;
  saveNow: () => Promise<void>;
  lastSavedAt: number | null;

  initProject: () => Promise<void>;
  addTrack: (kind?: TrackKind) => Promise<void>;
  removeTrack: (id: string) => Promise<void>;
  reorderTracks: (fromIdx: number, toIdx: number) => void;
  importFile: (id: string, file: File) => Promise<void>;
  loadPadSample: (trackId: string, padIdx: number, file: File) => Promise<void>;
  clearPadSample: (trackId: string, padIdx: number) => Promise<void>;
  triggerPad: (trackId: string, padIdx: number) => Promise<void>;
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
  armSamplerRecord: (id: string) => void;
  clearSamplerPattern: (id: string) => void;

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

  // Undo / redo. Covers parameter changes (volume, pan, mute, solo, trim,
  // normalize, input gain, BPM), track removal, recording, and file import.
  // Track add and project rename are NOT in history. Audio blobs are kept
  // alive while referenced by current state or any snapshot; gcOrphanedAudio
  // sweeps the rest.
  undoStack: HistorySnapshot[];
  redoStack: HistorySnapshot[];
  undo: () => Promise<void>;
  redo: () => Promise<void>;

  toasts: Toast[];
  pushToast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;
}

interface HistorySnapshot {
  tracks: TrackState[];
  bpm: number;
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
  isDemoMode: false,
  lastSavedAt: null,
  toasts: [],
  countInBeats: 0,
  countdownActive: false,
  countdownBeat: 0,
  latencyOffsetMs: 0,
  isCalibrating: false,
  undoStack: [],
  redoStack: [],

  undo: async () => {
    if (historyApplyInFlight) return;
    historyApplyInFlight = true;
    try {
      const s = get();
      if (s.undoStack.length === 0) return;
      const prev = s.undoStack[s.undoStack.length - 1];
      set({
        undoStack: s.undoStack.slice(0, -1),
        redoStack: [...s.redoStack, captureHistorySnapshot(s)],
      });
      await applyHistorySnapshot(prev);
      resetHistoryCoalesce();
      // No GC: undo just shuffles snapshots between stacks, so the union
      // of referenced audio keys is unchanged.
    } finally {
      historyApplyInFlight = false;
    }
  },

  redo: async () => {
    if (historyApplyInFlight) return;
    historyApplyInFlight = true;
    try {
      const s = get();
      if (s.redoStack.length === 0) return;
      const next = s.redoStack[s.redoStack.length - 1];
      set({
        undoStack: [...s.undoStack, captureHistorySnapshot(s)],
        redoStack: s.redoStack.slice(0, -1),
      });
      await applyHistorySnapshot(next);
      resetHistoryCoalesce();
    } finally {
      historyApplyInFlight = false;
    }
  },

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
      installLifecycleHooks();
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
    await switchToProject(id, name, /* initialTracks */ false, set);
    set({ isDemoMode: false });
    await get().refreshProjects();
  },

  startDemo: async () => {
    void getEngine().start();
    const id = makeId();
    await switchToProject(id, "Demo", false, set);
    set({ isDemoMode: true });
    await get().refreshProjects();

    const audioId = nextId();
    await getEngine().addTrack(audioId, "Track 1", "audio");
    const audioT = emptyTrack(audioId, "Track 1", "audio");
    audioT.inputDeviceId = get().defaultInputDeviceId;
    set((s) => ({ tracks: [...s.tracks, audioT] }));

    const samplerId = nextId();
    await getEngine().addTrack(samplerId, "Drum Kit", "sampler");
    const samplerT = emptyTrack(samplerId, "Drum Kit", "sampler");
    set((s) => ({ tracks: [...s.tracks, samplerT] }));

    schedulePersist(get());

    const DEMO_PADS: Array<{ url: string; name: string }> = [
      { url: "/demo/neptunes-80.wav",   name: "[CC] Neptunes (80).wav" },
      { url: "/demo/bang-bang-808.wav", name: "Bang Bang 808.wav" },
      { url: "/demo/desire-clap.wav",   name: "Desire Clap.wav" },
      { url: "/demo/tr808hh1.wav",      name: "TR808HH1.WAV" },
      { url: "/demo/clap-yikes.wav",    name: "Clap (Yikes).wav" },
      { url: "/demo/kanye-vox.wav",     name: "Kanye Vox.wav" },
    ];

    for (let i = 0; i < DEMO_PADS.length; i++) {
      const { url, name } = DEMO_PADS[i];
      try {
        const resp = await fetch(url);
        const blob = await resp.blob();
        const file = new File([blob], name, { type: "audio/wav" });
        await get().loadPadSample(samplerId, i, file);
      } catch {
        // skip failed pad, continue loading the rest
      }
    }
  },

  openProject: async (id) => {
    if (id === get().currentProjectId) return;
    await loadProjectIntoEngine(id, set);
    set({ isDemoMode: false });
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
      await switchToProject(DEFAULT_PROJECT_ID, "Untitled", false, set);
    }
    await get().refreshProjects();
  },

  addTrack: async (kind: TrackKind = "audio") => {
    const id = nextId();
    const baseName = kind === "sampler" ? "Sampler" : "Track";
    const name = `${baseName} ${get().tracks.length + 1}`;
    await getEngine().addTrack(id, name, kind);
    const t = emptyTrack(id, name, kind);
    t.inputDeviceId = get().defaultInputDeviceId;
    set((s) => ({ tracks: [...s.tracks, t] }));
    schedulePersist(get());
  },

  loadPadSample: async (trackId, padIdx, file) => {
    const track = get().tracks.find((t) => t.id === trackId);
    if (!track || track.kind !== "sampler") return;
    // Wake the AudioContext before decoding. iOS Safari leaves the context
    // suspended until a user gesture; `decodeAudioData` works on a suspended
    // context, but addTrack defers Tone.start() and we want a fully-running
    // graph the moment the pad is triggered.
    await getEngine().start();
    pushHistory(get(), `padSample:${trackId}:${padIdx}`);
    let buf: AudioBuffer;
    try {
      buf = await getEngine().loadFileToPad(trackId, padIdx, file);
    } catch (err) {
      const name = err instanceof Error ? err.name : "Error";
      const msg = err instanceof Error ? err.message : String(err);
      throw Object.assign(
        new Error(
          name === "EncodingError" || /decode/i.test(msg)
            ? "Couldn't decode that file. Try a WAV, MP3, or M4A."
            : msg,
        ),
        { name },
      );
    }
    const audioKey = makePadAudioKey(get().currentProjectId, trackId, padIdx);
    await saveAudio(audioKey, audioBufferToWavBlob(buf));
    set((s) => ({
      tracks: s.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const pads = t.pads.slice();
        pads[padIdx] = {
          hasAudio: true,
          fileName: file.name,
          durationSec: buf.duration,
          audioKey,
          bufferRevision: (pads[padIdx]?.bufferRevision ?? 0) + 1,
        };
        return { ...t, pads };
      }),
    }));
    // Flush immediately rather than wait for the 400 ms autosave debounce.
    // The audio blob is already in IDB; if the user reloads the page (or
    // backgrounds the app on mobile, where pagehide doesn't reliably wait
    // for async IDB writes) before the project metadata flushes, the pad's
    // audioKey reference is lost and the blob looks empty on next load.
    schedulePersist(get());
    await flushPersist();
  },

  clearPadSample: async (trackId, padIdx) => {
    const track = get().tracks.find((t) => t.id === trackId);
    if (!track || track.kind !== "sampler") return;
    if (!track.pads[padIdx]?.hasAudio) return;
    pushHistory(get(), `padClear:${trackId}:${padIdx}`);
    getEngine().setPadBuffer(trackId, padIdx, null);
    set((s) => ({
      tracks: s.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const pads = t.pads.slice();
        pads[padIdx] = emptyPad();
        return { ...t, pads };
      }),
    }));
    schedulePersist(get());
    await flushPersist();
  },

  triggerPad: async (trackId, padIdx) => {
    // Wake the AudioContext from inside the user gesture before doing
    // anything else — iOS Safari treats post-await work as out-of-gesture.
    await getEngine().start();
    getEngine().triggerPad(trackId, padIdx);
    // Record the hit if this sampler is armed and transport is rolling.
    const s = get();
    const track = s.tracks.find((t) => t.id === trackId);
    if (track?.samplerRecArmed && s.isPlaying) {
      const timeSec = getEngine().seconds();
      set((s2) => ({
        tracks: s2.tracks.map((t) =>
          t.id === trackId
            ? { ...t, samplerPattern: [...t.samplerPattern, { padIdx, timeSec }] }
            : t,
        ),
      }));
    }
  },

  removeTrack: async (id) => {
    pushHistory(get(), `removeTrack:${id}`);
    getEngine().removeTrack(id);
    // Don't delete the audio blob here — a snapshot in undoStack still
    // references it. gcOrphanedAudio() cleans up once nothing does.
    set((s) => ({ tracks: s.tracks.filter((x) => x.id !== id) }));
    schedulePersist(get());
  },

  reorderTracks: (fromIdx, toIdx) => {
    pushHistory(get(), "reorderTracks");
    set((s) => {
      const arr = [...s.tracks];
      const [item] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, item);
      return { tracks: arr };
    });
    schedulePersist(get());
  },

  importFile: async (id, file) => {
    pushHistory(get(), `importFile:${id}`);
    const buf = await getEngine().loadFileToTrack(id, file);
    const audioKey = makeAudioKey(get().currentProjectId, id);
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
    pushHistory(get(), `volume:${id}`);
    getEngine().setVolume(id, v);
    set((s) => ({
      tracks: s.tracks.map((t) => (t.id === id ? { ...t, volume: v } : t)),
    }));
    schedulePersist(get());
  },

  setPan: (id, p) => {
    pushHistory(get(), `pan:${id}`);
    getEngine().setPan(id, p);
    set((s) => ({
      tracks: s.tracks.map((t) => (t.id === id ? { ...t, pan: p } : t)),
    }));
    schedulePersist(get());
  },

  toggleMute: (id) => {
    const t = get().tracks.find((x) => x.id === id);
    if (!t) return;
    pushHistory(get(), `mute:${id}`);
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
    pushHistory(get(), `inputGain:${id}`);
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
    // Strictly read-only: enumerate whatever the platform exposes without
    // calling getUserMedia. Even a quick "permission probe" via
    // getUserMedia({audio:true}) flips iOS Safari from a Playback audio
    // session into PlayAndRecord — that demotes already-playing audio
    // to a lower-quality voice profile and re-routes output. Any actual
    // permission prompt must be triggered explicitly by the user (e.g.
    // hitting record, or the explicit "Grant mic access" button in the
    // input picker), never as a side effect of opening menus.
    const engine = getEngine();
    const devices = await engine.listInputDevices();
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
    pushHistory(get(), `trim:${id}`);
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
    pushHistory(get(), `solo:${id}`);
    const soloed = !t.soloed;
    set((s) => ({
      tracks: s.tracks.map((x) => (x.id === id ? { ...x, soloed } : x)),
    }));
    applyMixState(get().tracks);
    schedulePersist(get());
  },

  play: async () => {
    // Schedule sampler patterns before starting the transport so the Part
    // is ready to fire. Skip if already playing to avoid destroying in-flight Parts.
    if (!get().isPlaying) {
      for (const t of get().tracks) {
        if (t.kind !== "sampler") continue;
        if (t.samplerPattern.length > 0) {
          // Always schedule existing patterns — armed tracks overdub on top
          // (Part-triggered hits go through engine directly, not re-recorded).
          getEngine().setSamplerPattern(t.id, t.samplerPattern);
        } else if (t.samplerRecArmed) {
          // Armed with no recorded events yet — ensure no stale Part lingers.
          getEngine().clearSamplerPart(t.id);
        }
      }
    }
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
    pushHistory(get(), "bpm");
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
    // Capture the latest unsaved edits in the project before mixing — exports
    // should reflect what's on screen even if the autosave debounce hasn't fired.
    await flushPersist();
    set({ exportProgress: 0 });
    try {
      const mixTracks = collectMixTracks({ includeMuted: false });
      if (mixTracks.length === 0) {
        get().pushToast({
          variant: "warn",
          title: "Nothing to export",
          message:
            "Add audio to a track (record or import a file), then try again.",
          ttlMs: 6000,
        });
        return;
      }
      const buf = await mixdown(mixTracks);
      const blob = await encodeBuffer(buf, format, (p) =>
        set({ exportProgress: p }),
      );
      downloadBlob(blob, exportFilename(get().currentProjectName, format));
    } catch (err) {
      get().pushToast({
        variant: "error",
        title: "Export failed",
        message: err instanceof Error ? err.message : String(err),
        ttlMs: 8000,
      });
    } finally {
      set({ exportProgress: null });
    }
  },

  exportStems: async (format) => {
    await flushPersist();
    const stems = collectStems();
    if (stems.length === 0) {
      get().pushToast({
        variant: "warn",
        title: "Nothing to export",
        message:
          "Add audio to a track (record or import a file), then try again.",
        ttlMs: 6000,
      });
      return;
    }
    const projectName = get().currentProjectName.replace(/[^\w-]+/g, "_");
    set({ exportProgress: 0 });
    try {
      for (let i = 0; i < stems.length; i++) {
        const stem = stems[i];
        const stemBuf = await mixdown([stem.track]);
        const baseFraction = i / stems.length;
        const blob = await encodeBuffer(stemBuf, format, (p) =>
          set({ exportProgress: baseFraction + p / stems.length }),
        );
        const safeName = stem.name.replace(/[^\w-]+/g, "_") || `track-${i + 1}`;
        downloadBlob(blob, `${projectName}-${safeName}.${format}`);
      }
    } catch (err) {
      get().pushToast({
        variant: "error",
        title: "Stem export failed",
        message: err instanceof Error ? err.message : String(err),
        ttlMs: 8000,
      });
    } finally {
      set({ exportProgress: null });
    }
  },

  toggleArm: (id) => {
    set((s) => ({
      tracks: s.tracks.map((t) =>
        t.id === id && t.kind !== "sampler" ? { ...t, armed: !t.armed } : t,
      ),
    }));
  },

  toggleNormalize: (id) => {
    const t = get().tracks.find((x) => x.id === id);
    if (!t || !t.hasAudio) return;
    pushHistory(get(), `normalize:${id}`);
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

  armSamplerRecord: (id) => {
    set((s) => ({
      tracks: s.tracks.map((t) =>
        t.id === id && t.kind === "sampler"
          ? { ...t, samplerRecArmed: !t.samplerRecArmed }
          : t,
      ),
    }));
  },

  clearSamplerPattern: (id) => {
    getEngine().clearSamplerPart(id);
    set((s) => ({
      tracks: s.tracks.map((t) =>
        t.id === id ? { ...t, samplerPattern: [] } : t,
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
    // Sampler tracks aren't recordable — they hold per-pad samples loaded
    // by the user, not a single timeline buffer.
    const recordable = all.filter((t) => t.kind !== "sampler");
    let targets = recordable.filter((t) => t.armed);
    // If the user hasn't armed anything, default to all empty tracks so
    // pressing the master record on a fresh project Just Works without
    // overwriting any imported/recorded audio.
    if (targets.length === 0) targets = recordable.filter((t) => !t.hasAudio);
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
      // Schedule sampler patterns before the transport starts so they play
      // back in sync during the take. Armed samplers with existing patterns
      // overdub — new hits append while the old pattern plays back.
      for (const t of get().tracks) {
        if (t.kind !== "sampler") continue;
        if (t.samplerPattern.length > 0) {
          getEngine().setSamplerPattern(t.id, t.samplerPattern);
        } else if (t.samplerRecArmed) {
          getEngine().clearSamplerPart(t.id);
        }
      }
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
    if (results.size > 0) {
      // Snapshot the pre-recording state before any tracks get their new
      // buffers so the user can undo the entire take in one step. Previous
      // audio keys stay in IndexedDB so they're still loadable on undo.
      pushHistory(get(), `recording:${[...results.keys()].sort().join(",")}`);
    }
    for (const [trackId, buf] of results) {
      if (!buf) continue;
      const audioKey = makeAudioKey(get().currentProjectId, trackId);
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
      pushHistory(get(), `recording:${id}`);
      const audioKey = makeAudioKey(get().currentProjectId, id);
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

function emptyPad(): SamplerPadState {
  return {
    hasAudio: false,
    fileName: null,
    durationSec: 0,
    audioKey: null,
    bufferRevision: 0,
  };
}

function emptyPads(): SamplerPadState[] {
  return Array.from({ length: SAMPLER_PAD_COUNT }, emptyPad);
}

function emptyTrack(
  id: string,
  name: string,
  kind: TrackKind = "audio",
): TrackState {
  return {
    id,
    name,
    kind,
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
    pads: kind === "sampler" ? emptyPads() : [],
    samplerRecArmed: false,
    samplerPattern: [],
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
      kind: t.kind,
      pads: t.kind === "sampler"
        ? t.pads.map<PersistedSamplerPad>((p) => ({
            audioKey: p.audioKey,
            fileName: p.fileName,
            durationSec: p.durationSec,
          }))
        : undefined,
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

// ---- Undo / redo ----

const MAX_HISTORY = 50;
// Same-action edits within this window are coalesced into a single history
// entry — dragging a volume slider would otherwise generate dozens of
// snapshots and force the user to undo dozens of times to back out one move.
const HISTORY_COALESCE_MS = 800;
let lastHistoryAction = "";
let lastHistoryTime = 0;
let historyApplyInFlight = false;

function captureHistorySnapshot(state: CypherState): HistorySnapshot {
  // TrackState is mostly primitives plus the pads array, which we deep-clone
  // so a snapshot can't be mutated by later pad edits.
  return {
    bpm: state.bpm,
    tracks: state.tracks.map((t) => ({
      ...t,
      pads: t.pads.map((p) => ({ ...p })),
    })),
  };
}

function pushHistory(state: CypherState, action: string) {
  const now = Date.now();
  if (action === lastHistoryAction && now - lastHistoryTime < HISTORY_COALESCE_MS) {
    lastHistoryTime = now;
    return;
  }
  const snap = captureHistorySnapshot(state);
  let needsGc = false;
  useCypher.setState((s) => {
    needsGc = s.redoStack.length > 0;
    const stack = [...s.undoStack, snap];
    if (stack.length > MAX_HISTORY) {
      stack.shift();
      needsGc = true;
    }
    return { undoStack: stack, redoStack: [] };
  });
  lastHistoryAction = action;
  lastHistoryTime = now;
  if (needsGc) void gcOrphanedAudio();
}

function resetHistoryCoalesce() {
  lastHistoryAction = "";
  lastHistoryTime = 0;
}

async function restoreTrackAudio(trackId: string, audioKey: string, fileName: string | null) {
  const blob = await loadAudio(audioKey);
  if (!blob) return false;
  const file = new File([blob], fileName ?? "audio.wav", { type: blob.type });
  try {
    await getEngine().loadFileToTrack(trackId, file);
    return true;
  } catch {
    return false;
  }
}

async function applyHistorySnapshot(snap: HistorySnapshot) {
  const engine = getEngine();
  engine.setBpm(snap.bpm);

  const currentTracks = useCypher.getState().tracks;
  const snapById = new Map(snap.tracks.map((t) => [t.id, t]));
  const currById = new Map(currentTracks.map((t) => [t.id, t]));

  for (const cur of currentTracks) {
    if (!snapById.has(cur.id)) engine.removeTrack(cur.id);
  }

  // Add and reload audio for all tracks in parallel — each track is keyed
  // by id and the final setState rebuilds the whole list, so order
  // doesn't matter.
  await Promise.all(
    snap.tracks.map(async (snapT) => {
      if (!engine.getTrack(snapT.id)) {
        await engine.addTrack(snapT.id, snapT.name, snapT.kind);
      }
      const cur = currById.get(snapT.id);
      if (cur?.audioKey !== snapT.audioKey && snapT.audioKey) {
        await restoreTrackAudio(snapT.id, snapT.audioKey, snapT.fileName);
      }
      if (snapT.kind === "sampler") {
        engine.clearAllPads(snapT.id);
        await Promise.all(
          snapT.pads.map(async (p, i) => {
            if (!p.audioKey) return;
            const blob = await loadAudio(p.audioKey);
            if (!blob) return;
            const arr = await blob.arrayBuffer();
            try {
              const buf = await engine.context().decodeAudioData(arr.slice(0));
              engine.setPadBuffer(snapT.id, i, buf);
            } catch {
              // Ignore unreadable pad samples — pad UI will reflect missing audio.
            }
          }),
        );
      }
    }),
  );

  for (const snapT of snap.tracks) {
    engine.setVolume(snapT.id, snapT.volume);
    engine.setPan(snapT.id, snapT.pan);
    if (snapT.audioKey) engine.setTrim(snapT.id, snapT.trimInSec, snapT.trimOutSec);
    engine.setNormalizationGain(
      snapT.id,
      snapT.normalized ? snapT.normalizationGain : 1,
    );
  }

  // Bump bufferRevision so the waveform re-reads from the engine.
  const revBase = Date.now();
  useCypher.setState({
    bpm: snap.bpm,
    tracks: snap.tracks.map((t, i) => ({
      ...t,
      bufferRevision: revBase + i,
      pads: t.pads.map((p, j) => ({
        ...p,
        bufferRevision: revBase + i * 1000 + j,
      })),
    })),
  });
  applyMixState(useCypher.getState().tracks);
  schedulePersist(useCypher.getState());
}

async function gcOrphanedAudio() {
  const projectId = useCypher.getState().currentProjectId;
  try {
    const all = await listAudioKeysForProject(projectId);
    // Re-read state AFTER the IDB query so any audio key persisted by an
    // in-flight recording/import (and added to store state during the
    // await) shows up as referenced and isn't deleted as an orphan.
    const s = useCypher.getState();
    if (s.currentProjectId !== projectId) return; // project changed mid-flight
    const referenced = new Set<string>();
    const collect = (snap: {
      tracks: {
        audioKey: string | null;
        pads?: { audioKey: string | null }[];
      }[];
    }) => {
      for (const t of snap.tracks) {
        if (t.audioKey) referenced.add(t.audioKey);
        if (t.pads) {
          for (const p of t.pads) if (p.audioKey) referenced.add(p.audioKey);
        }
      }
    };
    collect({ tracks: s.tracks });
    s.undoStack.forEach(collect);
    s.redoStack.forEach(collect);
    const orphans = all.filter((k) => !referenced.has(k));
    await Promise.all(orphans.map(deleteAudio));
  } catch {
    // best-effort cleanup
  }
}

// Build a list of MixTrack values for export. Pulls volume/pan/trim/normalization
// from the user-facing store state (so solo isn't interpreted as mute) and the
// audio buffer from the engine.
function collectMixTracks(opts: { includeMuted: boolean }): MixTrack[] {
  const engine = getEngine();
  const state = useCypher.getState();
  const out: MixTrack[] = [];
  for (const s of state.tracks) {
    if (!opts.includeMuted && s.muted) continue;
    const e = engine.getTrack(s.id);
    if (!e?.buffer) continue;
    out.push({
      buffer: e.buffer,
      volume: s.volume,
      pan: s.pan,
      trimInSec: s.trimInSec,
      trimOutSec: s.trimOutSec,
      normalizationGain: s.normalizationGain,
    });
  }
  return out;
}

function collectStems(): Array<{ name: string; track: MixTrack }> {
  const engine = getEngine();
  const state = useCypher.getState();
  const stems: Array<{ name: string; track: MixTrack }> = [];
  for (const s of state.tracks) {
    const e = engine.getTrack(s.id);
    if (!e?.buffer) continue;
    stems.push({
      name: s.name,
      track: {
        buffer: e.buffer,
        volume: s.volume,
        pan: s.pan,
        trimInSec: s.trimInSec,
        trimOutSec: s.trimOutSec,
        normalizationGain: s.normalizationGain,
      },
    });
  }
  return stems;
}

function exportFilename(projectName: string, format: ExportFormat): string {
  const safeName = projectName.replace(/[^\w-]+/g, "_") || "cypher";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${safeName}-${stamp}.${format}`;
}

// Flush on page hide/close so users don't lose the last few edits while the
// autosave debounce is still waiting. visibilitychange fires reliably on
// mobile when the tab is backgrounded; beforeunload covers desktop close.
let lifecycleHooksInstalled = false;
function installLifecycleHooks() {
  if (lifecycleHooksInstalled) return;
  if (typeof window === "undefined" || typeof document === "undefined") return;
  lifecycleHooksInstalled = true;
  const flush = () => {
    void flushPersist();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  // pagehide is more reliable than beforeunload on mobile Safari, but cover
  // both for desktop browsers that don't fire pagehide for normal closes.
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
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
    // No record under this id — create a fresh empty project. Start with no
    // tracks so the user picks Audio vs Sampler from the Add Track menu
    // instead of getting two surprise audio tracks pre-populated.
    await switchToProject(id, "Untitled", false, set);
    return;
  }

  await engine.start();
  engine.setBpm(persisted.bpm);
  const restored: TrackState[] = [];
  for (const pt of persisted.tracks) {
    const numericId = Number(pt.id.replace(/^t/, "")) || 0;
    if (numericId > trackCounter) trackCounter = numericId;
    const kind: TrackKind = pt.kind === "sampler" ? "sampler" : "audio";
    await engine.addTrack(pt.id, pt.name, kind);
    engine.setVolume(pt.id, pt.volume);
    engine.setPan(pt.id, pt.pan);
    const hasAudio = pt.audioKey
      ? await restoreTrackAudio(pt.id, pt.audioKey, pt.fileName)
      : false;
    if (hasAudio) {
      engine.setTrim(pt.id, pt.trimInSec ?? 0, pt.trimOutSec ?? null);
    }
    const bufferRevision = hasAudio ? 1 : 0;
    let pads: SamplerPadState[] = [];
    if (kind === "sampler") {
      const persistedPads = pt.pads ?? [];
      pads = emptyPads();
      for (let i = 0; i < pads.length; i++) {
        const pp = persistedPads[i];
        if (!pp?.audioKey) continue;
        const blob = await loadAudio(pp.audioKey);
        if (!blob) continue;
        try {
          const arr = await blob.arrayBuffer();
          const buf = await engine.context().decodeAudioData(arr.slice(0));
          engine.setPadBuffer(pt.id, i, buf);
          pads[i] = {
            hasAudio: true,
            fileName: pp.fileName,
            durationSec: pp.durationSec,
            audioKey: pp.audioKey,
            bufferRevision: 1,
          };
        } catch {
          // Leave as empty; user can reload the sample.
        }
      }
    }
    restored.push({
      id: pt.id,
      name: pt.name,
      kind,
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
      pads,
      samplerRecArmed: false,
      samplerPattern: [],
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
    undoStack: [],
    redoStack: [],
  });
  resetHistoryCoalesce();
  applyMixState(restored);
  void gcOrphanedAudio();
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
    undoStack: [],
    redoStack: [],
  });
  resetHistoryCoalesce();
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
