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
  type PersistedProject,
  type PersistedTrack,
  type ProjectSummary,
} from "@/persistence/db";

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

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
  armed: boolean;
}

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
  inputDevices: MediaDeviceInfo[];
  refreshInputDevices: () => Promise<void>;
  play: () => Promise<void>;
  pause: () => void;
  stop: () => void;
  seek: (seconds: number) => Promise<void>;
  setBpm: (bpm: number) => void;
  toggleMetronome: () => void;
  startRecording: (trackId: string) => Promise<void>;
  stopRecording: () => Promise<void>;
  toggleArm: (id: string) => void;
  isMultiRecording: boolean;
  startArmedRecording: () => Promise<void>;
  stopArmedRecording: () => Promise<void>;

  exportProgress: number | null;
  exportMix: (format: ExportFormat) => Promise<void>;
  exportStems: (format: ExportFormat) => Promise<void>;
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
  isMultiRecording: false,
  currentProjectId: DEFAULT_PROJECT_ID,
  currentProjectName: "Untitled",
  projects: [],
  isLoaded: false,
  lastSavedAt: null,

  initProject: async () => {
    if (initInFlight) return initInFlight;
    if (initialized && get().tracks.length > 0) return;
    initInFlight = (async () => {
      const savedId = (await getCurrentProjectId()) ?? DEFAULT_PROJECT_ID;
      await loadProjectIntoEngine(savedId, set);
      await get().refreshProjects();
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
    set((s) => ({ tracks: [...s.tracks, emptyTrack(id, name)] }));
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
    const t = get().tracks.find((x) => x.id === trackId);
    await getEngine().startRecording(trackId, t?.inputDeviceId);
    set({ recordingTrackId: trackId, isMultiRecording: false });
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

  startArmedRecording: async () => {
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
      await getEngine().startMultiRecording(
        targets.map((t) => ({ trackId: t.id, deviceId: t.inputDeviceId })),
      );
      set({ isMultiRecording: true, isPlaying: true, recordingTrackId: null });
    } else {
      // All tracks already have audio; just play.
      await getEngine().play();
      set({ isPlaying: true });
    }
  },

  stopArmedRecording: async () => {
    const results = await getEngine().stopMultiRecording();
    set({ isMultiRecording: false, isPlaying: false });
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
      set((s) => ({
        tracks: s.tracks.map((t) => {
          const u = updates.get(t.id);
          if (!u) return t;
          return {
            ...t,
            hasAudio: true,
            fileName: "Recording",
            durationSec: u.duration,
            bufferRevision: t.bufferRevision + 1,
            audioKey: u.audioKey,
            trimInSec: 0,
            trimOutSec: null,
          };
        }),
      }));
      schedulePersist(get());
    }
  },

  stopRecording: async () => {
    const id = get().recordingTrackId;
    const buf = await getEngine().stopRecording();
    set({ recordingTrackId: null });
    if (id && buf) {
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
                fileName: "Recording",
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
    armed: false,
  };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingFlush: (() => Promise<void>) | null = null;

interface PersistInput {
  currentProjectId: string;
  currentProjectName: string;
  tracks: TrackState[];
  bpm: number;
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
      armed: t.armed,
    })),
    createdAt: 0, // filled in by flush — preserves existing createdAt if present.
    updatedAt: Date.now(),
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
      armed: pt.armed ?? false,
    });
  }
  await setCurrentProjectId(id);
  set({
    tracks: restored,
    bpm: persisted.bpm,
    currentProjectId: id,
    currentProjectName: persisted.name,
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
  });
  await flushPersist();
}

function applyMixState(tracks: TrackState[]) {
  const anySoloed = tracks.some((t) => t.soloed);
  const engine = getEngine();
  for (const t of tracks) {
    const audible = anySoloed ? t.soloed && !t.muted : !t.muted;
    engine.setMute(t.id, !audible);
  }
}
