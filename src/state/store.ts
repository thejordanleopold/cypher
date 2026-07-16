import { create } from "zustand";
import {
  getEngine,
  type RecordingInterruption,
} from "@/audio/engine";
import { mixdown, type MixTrack } from "@/audio/mixdown";
import { encodeBuffer, downloadBlob, type ExportFormat } from "@/audio/export";
import { audioBufferToWavBlob } from "@/audio/wav";
import {
  canRunTransport,
  clampProjectTime,
  hasSamplerCaptureSource,
  projectDuration,
  sanitizeSamplerEvent,
} from "@/audio/project-time";
import {
  DEFAULT_TIME_SIGNATURE,
  isSignatureAccent,
  sanitizeTimeSignature,
  signaturePulseMs,
  type TimeSignature,
} from "@/audio/time-signature";
import { getBasePath } from "@/base-path";
import {
  saveProjectIfRevision,
  loadProject,
  saveAudio,
  clearPendingAudioForProject,
  loadAudio,
  deleteAudio,
  makeAudioKey,
  makePadAudioKey,
  listProjects,
  createProjectAndSetCurrent,
  deleteProject as dbDeleteProject,
  cleanupDeletedProjectAudio,
  duplicateProject,
  compactProject as dbCompactProject,
  materializeRecoveryProject,
  getCurrentProjectId,
  setCurrentProjectId,
  getOutputDeviceId,
  setOutputDeviceId,
  getDefaultInputDeviceId,
  setDefaultInputDeviceId,
  type PersistedProject,
  type PersistedSamplerEvent,
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
  // Sampler pattern recording. The armed flag is session-only; events are
  // persisted and rendered into exports.
  samplerRecArmed: boolean;
  samplerPattern: SamplerEvent[];
}

export const DEFAULT_INPUT_GAIN = 1;
export const MAX_INPUT_GAIN = 6;

interface CypherState {
  tracks: TrackState[];
  isPlaying: boolean;
  bpm: number;
  timeSignature: TimeSignature;
  positionSec: number;
  metronomeOn: boolean;
  recordingTrackId: string | null;

  // Library
  currentProjectId: string;
  currentProjectName: string;
  projects: ProjectSummary[];
  isLoaded: boolean;
  loadError: string | null;
  isDemoMode: boolean;
  refreshProjects: () => Promise<void>;
  createProject: (name?: string) => Promise<void>;
  startDemo: () => Promise<void>;
  openProject: (id: string) => Promise<void>;
  renameProject: (name: string) => Promise<void>;
  saveProjectAs: (name: string) => Promise<void>;
  compactCurrentProject: () => Promise<void>;
  restoreRecoveryBackup: (key: string) => Promise<boolean>;
  deleteRecoveryBackup: (key: string) => Promise<boolean>;
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
  setTimeSignature: (signature: TimeSignature) => void;
  toggleMetronome: () => void;
  startRecording: (trackId: string) => Promise<void>;
  stopRecording: () => Promise<void>;
  isStartingRecording: boolean;
  isFinalizingRecording: boolean;
  toggleArm: (id: string) => void;
  toggleNormalize: (id: string) => void;
  isMultiRecording: boolean;
  armSamplerRecord: (id: string) => void;
  clearSamplerPattern: (id: string) => Promise<void>;

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
  // Project rename is not in history. Audio blobs are kept
  // alive while referenced by current state or any snapshot.
  undoStack: HistorySnapshot[];
  redoStack: HistorySnapshot[];
  isApplyingHistory: boolean;
  undo: () => Promise<void>;
  redo: () => Promise<void>;

  toasts: Toast[];
  pushToast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;
}

interface HistorySnapshot {
  tracks: TrackState[];
  bpm: number;
  timeSignature: TimeSignature;
}

let trackCounter = 0;
const nextId = () => `t${++trackCounter}`;

let initialized = false;
let initInFlight: Promise<void> | null = null;
let recordingStartInFlight: Promise<void> | null = null;
let recordingStopInFlight: Promise<void> | null = null;
let recordingInterruptionInFlight: Promise<void> | null = null;
let recordingStartAbortController: AbortController | null = null;
let recordingStartGeneration = 0;
let countInCancelled = false;
const activeMultiRecordingTrackIds = new Set<string>();
const trimRescheduleTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

interface ProjectIdentity {
  id: string;
  epoch: number;
}

interface RecordingStartAttempt {
  generation: number;
  controller: AbortController;
}

function beginRecordingStartAttempt(): RecordingStartAttempt {
  const controller = new AbortController();
  recordingStartGeneration += 1;
  recordingStartAbortController = controller;
  countInCancelled = false;
  return { generation: recordingStartGeneration, controller };
}

function isRecordingStartAttemptCurrent(
  attempt: RecordingStartAttempt,
  project: ProjectIdentity,
) {
  return (
    recordingStartGeneration === attempt.generation &&
    recordingStartAbortController === attempt.controller &&
    !attempt.controller.signal.aborted &&
    isProjectIdentityCurrent(project)
  );
}

function cancelPendingRecordingStart() {
  recordingStartGeneration += 1;
  countInCancelled = true;
  recordingStartAbortController?.abort();
}

function handleRecordingInterruption(
  project: ProjectIdentity,
  mode: "single" | "multi",
  interruption: RecordingInterruption,
) {
  if (recordingInterruptionInFlight) return;
  const operation = (async () => {
    // An input can disappear in the narrow window after MediaRecorder starts
    // but before the start action publishes its Zustand flags. Let that action
    // finish first so the existing finalizer captures the right track ids.
    const starting = recordingStartInFlight;
    if (starting) await starting.catch(() => {});
    if (!isProjectIdentityCurrent(project)) return;

    const state = useCypher.getState();
    const trackName =
      state.tracks.find((track) => track.id === interruption.trackId)?.name ??
      "Recording input";
    let finalized = false;
    if (mode === "multi" && state.isMultiRecording) {
      finalized = true;
      await state.stopArmedRecording();
    } else if (
      mode === "single" &&
      state.recordingTrackId === interruption.trackId
    ) {
      finalized = true;
      await state.stopRecording();
    }
    if (!finalized || !isProjectIdentityCurrent(project)) return;

    const reason =
      interruption.reason === "input-ended"
        ? "The microphone disconnected or permission was revoked."
        : interruption.error?.message ?? "The browser stopped the recorder.";
    useCypher.getState().pushToast({
      variant: "warn",
      title: `${trackName} stopped unexpectedly`,
      message: `${reason} The partial take was saved when possible.`,
      ttlMs: 8000,
    });
  })();
  recordingInterruptionInFlight = operation;
  void operation
    .finally(() => {
      if (recordingInterruptionInFlight === operation) {
        recordingInterruptionInFlight = null;
      }
    })
    .catch(() => {});
}

// Long-running decode/record operations capture this identity before their
// first await. A project transition advances the epoch so stale completions
// cannot attach audio or state to whichever project happens to be current.
let projectEpoch = 0;
let projectTransitioning = false;
let recordingStartBlockCount = 0;
let projectOperationTail: Promise<void> = Promise.resolve();
// History snapshots cover the whole project, so every sampler participating
// in one overdub pass must share a single grouping marker.
let samplerHistoryProjectId: string | null = null;
// Newly saved blobs live here until their short metadata/engine commit lands.
// GC treats them as roots so a simultaneous edit cannot sweep the blob during
// the detached decode/save window.
const pendingAudioKeys = new Set<string>();
const audioReplacementTokens = new Map<string, symbol>();

function trackAudioTarget(projectId: string, trackId: string) {
  return `${projectId}\u0000track\u0000${trackId}`;
}

function padAudioTarget(projectId: string, trackId: string, padIdx: number) {
  return `${projectId}\u0000pad\u0000${trackId}\u0000${padIdx}`;
}

function beginAudioReplacement(target: string) {
  const token = Symbol(target);
  audioReplacementTokens.set(target, token);
  return token;
}

function isCurrentAudioReplacement(target: string, token: symbol) {
  return audioReplacementTokens.get(target) === token;
}

function invalidateAudioReplacement(target: string) {
  audioReplacementTokens.set(target, Symbol(`${target}:invalidated`));
}

function finishAudioReplacement(target: string, token: symbol) {
  if (isCurrentAudioReplacement(target, token)) {
    audioReplacementTokens.delete(target);
  }
}

/**
 * Serialize every operation that can rebuild or replace the singleton audio
 * graph. Epoch checks fence stale leaf operations; this lock prevents two
 * legitimate project loaders from interleaving destructive engine mutations.
 */
async function withProjectOperation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = projectOperationTail;
  let release!: () => void;
  projectOperationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function supportsCrossTabProjectStorageLease() {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.locks?.request === "function"
  );
}

async function withProjectStorageLease<T>(
  projectId: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!supportsCrossTabProjectStorageLease()) return operation();
  return navigator.locks.request(
    `cypher:project-storage:${projectId}`,
    { mode: "exclusive" },
    operation,
  );
}

interface ProjectSessionLease {
  projectId: string;
  release: () => void;
  ready: Promise<void>;
  finished: Promise<unknown>;
}

const projectSessionLeases = new Map<string, ProjectSessionLease>();

function projectSessionLockName(projectId: string) {
  return `cypher:project-session:${projectId}`;
}

function projectCompactionAttemptLockName(projectId: string) {
  return `cypher:project-compaction-attempt:${projectId}`;
}

async function releaseProjectSessionLease(projectId: string) {
  const lease = projectSessionLeases.get(projectId);
  if (!lease) return;
  if (projectSessionLeases.get(projectId) === lease) {
    projectSessionLeases.delete(projectId);
  }
  lease.release();
  await lease.finished.catch(() => {});
}

async function releaseOtherProjectSessionLeases(projectId: string) {
  await Promise.all(
    [...projectSessionLeases.keys()]
      .filter((candidate) => candidate !== projectId)
      .map((candidate) => releaseProjectSessionLease(candidate)),
  );
}

async function holdProjectSessionLease(projectId: string) {
  if (!supportsCrossTabProjectStorageLease()) return;
  for (;;) {
    const existing = projectSessionLeases.get(projectId);
    if (existing) {
      // Map presence alone is not ownership: the shared request may still be
      // queued behind another tab's exclusive delete/compaction operation.
      // Every caller must wait for that exact lease to enter its callback.
      await existing.ready;
      if (projectSessionLeases.get(projectId) === existing) return;
      continue;
    }

    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    let acquisitionFailed!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      acquired = resolve;
      acquisitionFailed = reject;
    });
    const finished = navigator.locks.request(
      projectSessionLockName(projectId),
      { mode: "shared" },
      async () => {
        acquired();
        await released;
      },
    );
    // A document can become ineligible for Web Locks while its request is
    // queued. Propagate that failure to every acquisition waiter; otherwise
    // the callback never runs and project startup/navigation hangs forever.
    void finished.catch(acquisitionFailed);
    const lease: ProjectSessionLease = {
      projectId,
      release,
      ready,
      finished,
    };
    projectSessionLeases.set(projectId, lease);
    try {
      await ready;
    } catch (error) {
      if (projectSessionLeases.get(projectId) === lease) {
        projectSessionLeases.delete(projectId);
      }
      release();
      await finished.catch(() => {});
      throw error;
    }
    // A concurrent project switch may have released/replaced this request
    // while it was queued. Loop until this caller observes a live owned lease.
    if (projectSessionLeases.get(projectId) === lease) return;
    release();
    await finished.catch(() => {});
  }
}

async function withExclusiveProjectSession<T>(
  projectId: string,
  operation: () => Promise<T>,
): Promise<{ acquired: boolean; value?: T }> {
  if (!supportsCrossTabProjectStorageLease()) return { acquired: false };
  // Serialize the entire shared→exclusive→shared upgrade. Without this outer
  // mutex, two tabs clicking Compact together could both drop their shared
  // roots before either performs its ifAvailable check.
  return navigator.locks.request(
    projectCompactionAttemptLockName(projectId),
    { mode: "exclusive" },
    async () => {
      const shouldReacquire = projectSessionLeases.has(projectId);
      if (shouldReacquire) await releaseProjectSessionLease(projectId);
      try {
        return await navigator.locks.request(
          projectSessionLockName(projectId),
          { mode: "exclusive", ifAvailable: true },
          async (lock) =>
            lock
              ? { acquired: true, value: await operation() }
              : { acquired: false },
        );
      } finally {
        if (
          shouldReacquire &&
          useCypher.getState().currentProjectId === projectId
        ) {
          await holdProjectSessionLease(projectId);
        }
      }
    },
  );
}

const PROJECT_COORDINATION_CHANNEL = "cypher:project-coordination";
let projectCoordinationChannel: BroadcastChannel | null = null;

function installProjectCoordinationChannel() {
  if (
    projectCoordinationChannel ||
    typeof BroadcastChannel === "undefined"
  ) {
    return;
  }
  projectCoordinationChannel = new BroadcastChannel(
    PROJECT_COORDINATION_CHANNEL,
  );
  projectCoordinationChannel.addEventListener("message", (event) => {
    const data = event.data as {
      type?: unknown;
      projectId?: unknown;
      sourceSessionId?: unknown;
    };
    if (
      data.type !== "project-compacted" ||
      typeof data.projectId !== "string" ||
      data.sourceSessionId === getRecoverySessionId() ||
      data.projectId !== useCypher.getState().currentProjectId
    ) {
      return;
    }

    const hadPendingChanges =
      dirtyPersistSnapshot?.state.currentProjectId === data.projectId;
    const pendingPreserved =
      !hadPendingChanges || writeRecoverySnapshot();
    if (hadPendingChanges && pendingPreserved) discardPendingPersist(false);
    getEngine().stop();
    useCypher.setState({
      isPlaying: false,
      positionSec: 0,
      undoStack: [],
      redoStack: [],
      isLoaded: false,
      loadError: hadPendingChanges && pendingPreserved
        ? "This project was compacted in another tab. Your pending changes were preserved. Retry to reopen the compacted project."
        : hadPendingChanges
          ? "This project was compacted in another tab. Browser recovery storage is unavailable, so keep this tab open and Retry to preserve your pending changes."
          : "This project was compacted in another tab. Retry to reopen the compacted project.",
    });
  });
}

function broadcastProjectCompacted(projectId: string, updatedAt: number) {
  installProjectCoordinationChannel();
  projectCoordinationChannel?.postMessage({
    type: "project-compacted",
    projectId,
    updatedAt,
    sourceSessionId: getRecoverySessionId(),
  });
}

function captureProjectIdentity(state: Pick<CypherState, "currentProjectId">): ProjectIdentity | null {
  if (projectTransitioning) return null;
  return { id: state.currentProjectId, epoch: projectEpoch };
}

function isProjectIdentityCurrent(
  identity: ProjectIdentity,
  state: Pick<CypherState, "currentProjectId"> = useCypher.getState(),
) {
  return (
    !projectTransitioning &&
    identity.epoch === projectEpoch &&
    identity.id === state.currentProjectId
  );
}

function beginProjectTransition() {
  projectEpoch += 1;
  projectTransitioning = true;
  cancelPendingRecordingStart();
  samplerHistoryProjectId = null;
  activeMultiRecordingTrackIds.clear();
  audioReplacementTokens.clear();
  for (const timer of trimRescheduleTimers.values()) clearTimeout(timer);
  trimRescheduleTimers.clear();
  // A transition hides the current project immediately, so clear any
  // session-only countdown state at the same boundary.
  useCypher.setState({ countdownActive: false, countdownBeat: 0 });
  return projectEpoch;
}

function hasActiveProjectCapture(state = useCypher.getState()) {
  return (
    state.recordingTrackId !== null ||
    state.isMultiRecording ||
    state.isStartingRecording ||
    state.isFinalizingRecording
  );
}

function warnProjectTransitionDuringCapture(action: string) {
  useCypher.getState().pushToast({
    variant: "warn",
    title: "Finish recording first",
    message: `Stop or cancel the active take before ${action}.`,
  });
}

async function withRecordingStartBlocked<T>(operation: () => Promise<T>) {
  recordingStartBlockCount += 1;
  try {
    return await operation();
  } finally {
    recordingStartBlockCount -= 1;
  }
}

function completeProjectTransition(epoch: number) {
  if (projectEpoch === epoch) projectTransitioning = false;
}

export const useCypher = create<CypherState>((set, get) => ({
  tracks: [],
  isPlaying: false,
  bpm: 120,
  timeSignature: { ...DEFAULT_TIME_SIGNATURE },
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
  isStartingRecording: false,
  isFinalizingRecording: false,
  currentProjectId: DEFAULT_PROJECT_ID,
  currentProjectName: "Untitled",
  projects: [],
  isLoaded: false,
  loadError: null,
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
  isApplyingHistory: false,

  undo: async () => {
    // Undo is a semantic fence: detached decodes/saves initiated before this
    // click must not land afterward and silently reverse the restored state.
    audioReplacementTokens.clear();
    historyApplicationCount += 1;
    set({ isApplyingHistory: true });
    try {
      const leaseProjectId = get().currentProjectId;
      await withProjectStorageLease(leaseProjectId, () =>
        withProjectOperation(async () => {
          const s = get();
          const project = captureProjectIdentity(s);
          if (
            !project ||
            project.id !== leaseProjectId ||
            s.undoStack.length === 0
          ) {
            return;
          }
        const prev = s.undoStack[s.undoStack.length - 1];
        const current = captureHistorySnapshot(s);
        try {
          await applyHistorySnapshot(prev, project);
        } catch (error) {
          // Snapshot application can involve several IndexedDB reads. Keep
          // the history entry in place and best-effort restore the graph if a
          // read/decode fails partway through.
          await applyHistorySnapshot(current, project, true).catch(() => {});
          get().pushToast({
            variant: "error",
            title: "Undo failed",
            message: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        set({
          undoStack: s.undoStack.slice(0, -1),
          redoStack: [...s.redoStack, current],
        });
          resetSamplerHistoryGrouping();
        }),
      );
      // No GC: undo just shuffles snapshots between stacks, so the union
      // of referenced audio keys is unchanged.
    } finally {
      historyApplicationCount -= 1;
      if (historyApplicationCount === 0) set({ isApplyingHistory: false });
    }
  },

  redo: async () => {
    audioReplacementTokens.clear();
    historyApplicationCount += 1;
    set({ isApplyingHistory: true });
    try {
      const leaseProjectId = get().currentProjectId;
      await withProjectStorageLease(leaseProjectId, () =>
        withProjectOperation(async () => {
          const s = get();
          const project = captureProjectIdentity(s);
          if (
            !project ||
            project.id !== leaseProjectId ||
            s.redoStack.length === 0
          ) {
            return;
          }
        const next = s.redoStack[s.redoStack.length - 1];
        const current = captureHistorySnapshot(s);
        try {
          await applyHistorySnapshot(next, project);
        } catch (error) {
          await applyHistorySnapshot(current, project, true).catch(() => {});
          get().pushToast({
            variant: "error",
            title: "Redo failed",
            message: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        set({
          undoStack: [...s.undoStack, current],
          redoStack: s.redoStack.slice(0, -1),
        });
          resetSamplerHistoryGrouping();
        }),
      );
    } finally {
      historyApplicationCount -= 1;
      if (historyApplicationCount === 0) set({ isApplyingHistory: false });
    }
  },

  setCountInBeats: (n) => {
    set({ countInBeats: Math.max(0, Math.min(8, n)) });
    schedulePersist(get());
  },
  cancelCountdown: () => {
    cancelPendingRecordingStart();
    set({ countdownActive: false, countdownBeat: 0 });
  },
  setLatencyOffsetMs: (ms) => {
    set({ latencyOffsetMs: Math.max(-200, Math.min(500, Math.round(ms))) });
    schedulePersist(get());
  },

  calibrateLatency: async (deviceId) => {
    if (get().isCalibrating) return;
    const project = captureProjectIdentity(get());
    if (!project) return;
    set({ isCalibrating: true });
    try {
      const ms = await measureLatency(deviceId);
      if (!isProjectIdentityCurrent(project)) return;
      if (ms !== null) {
        set({ latencyOffsetMs: ms });
        schedulePersist(get());
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
      if (isProjectIdentityCurrent(project)) set({ isCalibrating: false });
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
    if (initialized && get().isLoaded) return;
    initInFlight = (async () => {
      const storedProjectId = await getCurrentProjectId();
      const savedId = storedProjectId ?? DEFAULT_PROJECT_ID;
      await holdProjectSessionLease(savedId);
      const recoveryWarning = await withProjectStorageLease(savedId, () =>
        recoverProjectSnapshot(savedId),
      );
      // Older builds could commit the current-project pointer just before a
      // crash without ever creating its project row. Once the shared session
      // lease is held, a still-matching pointer proves this is a stranded
      // creation rather than a cooperating delete that is still in flight.
      const savedProject = await loadProject(savedId);
      const pointerStillMatches =
        (await getCurrentProjectId()) === storedProjectId;
      const shouldCreateMissingProject =
        storedProjectId === undefined ||
        (!savedProject && pointerStillMatches);
      await loadProjectIntoEngine(
        savedId,
        set,
        shouldCreateMissingProject,
      );
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
      void retryPendingRecoveryCleanup();
      initialized = true;
      if (recoveryWarning) {
        get().pushToast({
          variant: "warn",
          title: "Pending changes need review",
          message: recoveryWarning,
          ttlMs: 10_000,
        });
      }
    })();
    try {
      await initInFlight;
    } catch (error) {
      // Failures that happen before loadProjectIntoEngine (notably a blocked
      // IndexedDB upgrade) still need to leave the splash screen with an
      // actionable Retry path.
      set({ isLoaded: false, loadError: projectLoadError(error) });
      throw error;
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
    await holdProjectSessionLease(id);
    try {
      await withProjectOperation(async () => {
        if (hasActiveProjectCapture()) {
          warnProjectTransitionDuringCapture("creating a project");
          await releaseProjectSessionLease(id);
          return;
        }
        await withRecordingStartBlocked(() =>
          switchToProjectUnlocked(id, name, /* initialTracks */ false, set),
        );
        set({ isDemoMode: false });
        await get().refreshProjects();
      });
    } catch (error) {
      if (get().currentProjectId !== id) await releaseProjectSessionLease(id);
      throw error;
    }
  },

  startDemo: async () => {
    const id = makeId();
    await holdProjectSessionLease(id);
    try {
      await withProjectStorageLease(id, () =>
        withProjectOperation(async () => {
        if (hasActiveProjectCapture()) {
          warnProjectTransitionDuringCapture("starting the demo");
          await releaseProjectSessionLease(id);
          return;
        }
        void getEngine().start();
        await withRecordingStartBlocked(() =>
          switchToProjectUnlocked(id, "Demo", false, set),
        );
      const project = captureProjectIdentity(get());
      if (!project) return;
      // Keep the shell gated until the demo graph, metadata, and samples all
      // refer to the same project. The local operation lock prevents a queued
      // Open/New/Delete action from interleaving this bootstrap, while the
      // cross-tab storage lease keeps compaction away from prepared blobs.
      set({ isDemoMode: true, isLoaded: false, loadError: null });

      try {
        const samplerId = nextId();
        await getEngine().addTrack(samplerId, "Drum Kit", "sampler");
        if (!isProjectIdentityCurrent(project)) return;
        const samplerT = emptyTrack(samplerId, "Drum Kit", "sampler");
        set((s) => ({ tracks: [...s.tracks, samplerT] }));

        const audioId = nextId();
        await getEngine().addTrack(audioId, "Track 1", "audio");
        if (!isProjectIdentityCurrent(project)) return;
        const audioT = emptyTrack(audioId, "Track 1", "audio");
        audioT.inputDeviceId = get().defaultInputDeviceId;
        set((s) => ({ tracks: [...s.tracks, audioT] }));
        schedulePersist(get());

        const basePath = getBasePath();
        const demoPads: Array<{ url: string; name: string }> = [
          { url: `${basePath}/demo/neptunes-80.wav`, name: "[CC] Neptunes (80).wav" },
          { url: `${basePath}/demo/bang-bang-808.wav`, name: "Bang Bang 808.wav" },
          { url: `${basePath}/demo/desire-clap.wav`, name: "Desire Clap.wav" },
          { url: `${basePath}/demo/tr808hh1.wav`, name: "TR808HH1.WAV" },
          { url: `${basePath}/demo/clap-yikes.wav`, name: "Clap (Yikes).wav" },
          { url: `${basePath}/demo/kanye-vox.wav`, name: "Kanye Vox.wav" },
        ];

        for (let i = 0; i < demoPads.length; i++) {
          if (!isProjectIdentityCurrent(project)) return;
          const { url, name } = demoPads[i];
          try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`Demo sample request failed (${resp.status})`);
            const blob = await resp.blob();
            const file = new File([blob], name, { type: "audio/wav" });
            // Demo bootstrap already owns the project-operation lock, so use
            // the same prepare/commit boundary inline instead of calling the
            // public action (which acquires that lock for its commit).
            const buf = await getEngine().decodeFile(file);
            const audioKey = makePadAudioKey(project.id, samplerId, i);
            await saveAudio(audioKey, audioBufferToWavBlob(buf));
            pendingAudioKeys.add(audioKey);
            try {
              if (!isProjectIdentityCurrent(project)) {
                await deleteAudio(audioKey);
                return;
              }
              getEngine().setPadBuffer(samplerId, i, buf);
              set((s) => ({
                tracks: s.tracks.map((track) => {
                  if (track.id !== samplerId) return track;
                  const pads = track.pads.slice();
                  pads[i] = {
                    hasAudio: true,
                    fileName: name,
                    durationSec: buf.duration,
                    audioKey,
                    bufferRevision: (pads[i]?.bufferRevision ?? 0) + 1,
                  };
                  return { ...track, pads };
                }),
              }));
              // Each durable blob must immediately have recoverable metadata;
              // the final demo flush may never run if the tab is killed.
              schedulePersist(get());
            } finally {
              pendingAudioKeys.delete(audioKey);
            }
          } catch {
            // A missing optional demo pad should not prevent the rest loading.
          }
        }
        if (!isProjectIdentityCurrent(project)) return;
        schedulePersist(get());
        await flushPersist();
        await get().refreshProjects();
        set({ isLoaded: true, loadError: null });
      } catch (error) {
        if (isProjectIdentityCurrent(project)) {
          set({ isLoaded: true, loadError: projectLoadError(error) });
        }
        throw error;
      }
        }),
      );
    } catch (error) {
      if (get().currentProjectId !== id) {
        await releaseProjectSessionLease(id);
      }
      throw error;
    }
  },

  openProject: async (id) => {
    if (id === get().currentProjectId) return;
    await holdProjectSessionLease(id);
    try {
      await withProjectOperation(async () => {
        if (id === get().currentProjectId) return;
        // A project transition ahead of this queued operation may have
        // released our speculative destination lease. Re-acquire it inside
        // the serialized boundary before recovery reads any source blobs.
        await holdProjectSessionLease(id);
        if (hasActiveProjectCapture()) {
          warnProjectTransitionDuringCapture("opening another project");
          await releaseProjectSessionLease(id);
          return;
        }
        const recoveryWarning = await withRecordingStartBlocked(async () => {
          const warning = await withProjectStorageLease(id, () =>
            recoverProjectSnapshot(id),
          );
          await loadProjectIntoEngineUnlocked(id, set);
          return warning;
        });
        set({ isDemoMode: false });
        await get().refreshProjects();
        if (recoveryWarning) {
          get().pushToast({
            variant: "warn",
            title: "Pending changes need review",
            message: recoveryWarning,
            ttlMs: 10_000,
          });
        }
      });
    } catch (error) {
      if (get().currentProjectId !== id) await releaseProjectSessionLease(id);
      throw error;
    }
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
    const newId = makeId();
    await holdProjectSessionLease(newId);
    try {
      await withProjectOperation(async () => {
      // Another queued transition can release speculative destination leases.
      // Pin this copy's id again at the point where the serialized operation
      // actually begins, so releaseOtherProjectSessionLeases retains it.
      await holdProjectSessionLease(newId);
      if (hasActiveProjectCapture()) {
        warnProjectTransitionDuringCapture("saving a project copy");
        await releaseProjectSessionLease(newId);
        return;
      }
      const { sourceId, sourceRevision, transition } =
        await withRecordingStartBlocked(async () => {
          const sourceId = get().currentProjectId;
          // Persist a fresh snapshot even when no autosave is pending. Some
          // project settings may be the only thing changed since the last save.
          schedulePersist(get());
          await flushPersist();
          const sourceRevision = persistedProjectRevisions.get(sourceId);
          const transition = beginProjectTransition();
          return { sourceId, sourceRevision, transition };
        });
      set({ isLoaded: false, loadError: null });
      try {
        const copy = await duplicateProject(
          sourceId,
          newId,
          name,
          sourceRevision ?? undefined,
        );
        if (!copy) throw new Error("The source project no longer exists.");
        persistedProjectRevisions.set(copy.id, copy.updatedAt);
        if (transition !== projectEpoch) return;

        const copiedById = new Map(
          copy.tracks.map((track) => [track.id, track]),
        );
        const tracks = get().tracks.map((track) => {
          const copied = copiedById.get(track.id);
          if (!copied) return track;
          return {
            ...track,
            audioKey: copied.audioKey,
            pads: track.pads.map((pad, index) => ({
              ...pad,
              audioKey: copied.pads?.[index]?.audioKey ?? null,
            })),
          };
        });

        await setCurrentProjectId(newId);
        if (transition !== projectEpoch) return;
        await releaseOtherProjectSessionLeases(newId);
        set({
          tracks,
          bpm: copy.bpm,
          timeSignature: sanitizeTimeSignature(copy.timeSignature),
          currentProjectId: newId,
          currentProjectName: copy.name,
          latencyOffsetMs: copy.latencyOffsetMs ?? 0,
          countInBeats: copy.countInBeats ?? 0,
          isLoaded: true,
          loadError: null,
          undoStack: [],
          redoStack: [],
          lastSavedAt: copy.updatedAt,
        });
        resetHistoryCoalesce();
        completeProjectTransition(transition);
        schedulePersist(get());
        await flushPersist();
        void gcOrphanedAudio();
        await get().refreshProjects();
      } catch (error) {
        if (transition === projectEpoch) set({ isLoaded: true });
        throw error;
      } finally {
        // If duplication failed, leave the source project usable while still
        // invalidating media operations that began before Save As.
        completeProjectTransition(transition);
      }
      });
    } catch (error) {
      if (get().currentProjectId !== newId) {
        await releaseProjectSessionLease(newId);
      }
      throw error;
    }
  },

  compactCurrentProject: async () => {
    if (
      get().recordingTrackId !== null ||
      get().isMultiRecording ||
      get().isStartingRecording ||
      get().isFinalizingRecording
    ) {
      get().pushToast({
        variant: "warn",
        title: "Finish recording first",
        message: "Stop or cancel the active take before compacting storage.",
      });
      return;
    }
    const sourceId = get().currentProjectId;
    if (!supportsCrossTabProjectStorageLease()) {
      get().pushToast({
        variant: "warn",
        title: "Compaction unavailable",
        message:
          "This browser cannot coordinate project storage safely across tabs. Save as a new project, then delete the old copy instead.",
      });
      return;
    }
    const session = await withExclusiveProjectSession(sourceId, () =>
      withProjectStorageLease(sourceId, () =>
        withProjectOperation(async () => {
        if (get().currentProjectId !== sourceId) return;
        if (
          get().recordingTrackId !== null ||
          get().isMultiRecording ||
          get().isStartingRecording ||
          get().isFinalizingRecording
        ) {
          get().pushToast({
            variant: "warn",
            title: "Finish recording first",
            message: "Stop or cancel the active take before compacting storage.",
          });
          return;
        }
        // Hide/epoch-fence the editor synchronously before the first await.
        // Otherwise an edit can capture revision R while IndexedDB is
        // committing compaction R+1, manufacturing a same-tab CAS conflict
        // and a false recovered branch.
        set({ isLoaded: false, loadError: null });
        const transition = beginProjectTransition();
        schedulePersist(get(), true);
        getEngine().stop();
        set({ isPlaying: false });
        try {
          // Commit the latest full snapshot before pinning the revision that
          // the atomic compaction transaction is allowed to sweep.
          await flushPersist();
          const sourceRevision = persistedProjectRevisions.get(sourceId);
          if (typeof sourceRevision !== "number") {
            throw new Error("The current project has not finished saving yet.");
          }

          removeRetiredLegacyRecoveryEntriesUnderExclusiveSession(
            sourceId,
            false,
          );
          const protectedRecoveryAudio = recoveryAudioReferences(sourceId);
          const result = await dbCompactProject(
            sourceId,
            sourceRevision,
            protectedRecoveryAudio,
          );
          try {
            removeRetiredLegacyRecoveryEntriesUnderExclusiveSession(sourceId);
          } catch {
            // The metadata/audio compaction already committed. A stale
            // retirement marker is harmless and can be retried later.
          }
          persistedProjectRevisions.set(sourceId, result.project.updatedAt);
          lastDirtyAt = Math.max(lastDirtyAt, result.project.updatedAt);
          set({
            undoStack: [],
            redoStack: [],
            lastSavedAt: result.project.updatedAt,
          });
          resetHistoryCoalesce();
          broadcastProjectCompacted(sourceId, result.project.updatedAt);
          await get().refreshProjects().catch(() => {});
          get().pushToast({
            variant: "info",
            title: "Project storage compacted",
            message:
              result.removedAudioCount === 0
                ? "No unused takes were found. Undo history was cleared."
                : `${result.removedAudioCount} unused ${
                    result.removedAudioCount === 1 ? "take was" : "takes were"
                  } removed. Undo history was cleared.`,
          });
        } catch (error) {
          if (
            transition === projectEpoch &&
            get().loadError !== null &&
            dirtyPersistSnapshot?.state.currentProjectId === sourceId
          ) {
            // The scheduled preflight save reported while the transition gate
            // was active, so its first journal attempt was intentionally
            // blocked. End the gate and publish the full snapshot now.
            completeProjectTransition(transition);
            reportPersistFailure(error);
          }
          get().pushToast({
            variant: "error",
            title: "Compaction failed",
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          if (transition === projectEpoch) {
            completeProjectTransition(transition);
            if (get().loadError === null) set({ isLoaded: true });
          }
        }
        }),
      ),
    );
    if (!session.acquired) {
      get().pushToast({
        variant: "warn",
        title: "Close other project tabs",
        message:
          "This project is active in another tab. Close that tab, then run compaction again so none of its audio references are removed.",
      });
    }
  },

  restoreRecoveryBackup: async (key) => {
    if (
      typeof localStorage === "undefined" ||
      !key.startsWith(RECOVERY_CONFLICT_PREFIX)
    ) {
      return false;
    }
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return false;
      const parsed = JSON.parse(raw) as { project?: unknown };
      const keyProjectId = projectIdFromRecoveryConflictKey(key);
      if (
        !isPersistedProject(parsed.project) ||
        keyProjectId !== parsed.project.id
      ) {
        throw new Error("The backup metadata is not valid.");
      }
      const recoveryProject = parsed.project;
      const newId = makeId();
      const recoveredName = `${recoveryProject.name} (Recovered backup)`;
      const cleanup = await withProjectStorageLease(recoveryProject.id, async () => {
        // Conflict keys are immutable. If the user removed this entry from
        // another tab before the copy begins, do not create a duplicate.
        if (localStorage.getItem(key) !== raw) {
          throw new Error("This recovery backup changed or was already removed.");
        }
        await materializeRecoveryProject(
          recoveryProject,
          newId,
          recoveredName,
        );
        await clearPendingAudioForProject(recoveryProject).catch(() => {});
        let backupRemoved = false;
        let cleanupKey: string | null = null;
        try {
          // Publish an immutable retry handle before removing the final
          // recovery key. A crash or transient IDB failure can then never
          // strand the deleted source prefix with no discoverable owner.
          cleanupKey = publishRecoveryCleanup(recoveryProject.id);
          localStorage.removeItem(key);
          backupRemoved = localStorage.getItem(key) === null;
        } catch {
          // The independent project copy is already durable. Keep the visible
          // backup so the user can retry deleting it later.
        }
        let sourceCleaned = true;
        if (backupRemoved && cleanupKey) {
          try {
            await completePublishedRecoveryCleanup(
              recoveryProject.id,
              cleanupKey,
            );
          } catch {
            sourceCleaned = false;
          }
        }
        return { backupRemoved, sourceCleaned };
      });
      await get().refreshProjects().catch(() => {});
      get().pushToast({
        variant:
          cleanup.backupRemoved && cleanup.sourceCleaned ? "info" : "warn",
        title: "Recovery backup restored",
        message:
          cleanup.backupRemoved && cleanup.sourceCleaned
            ? `“${recoveredName}” is now available in the project library.`
            : cleanup.backupRemoved
              ? `“${recoveredName}” was restored. Original recovery storage cleanup will retry automatically.`
              : `“${recoveredName}” was restored, but the original backup could not be removed. You can retry deleting it from this menu.`,
      });
      return true;
    } catch (error) {
      get().pushToast({
        variant: "error",
        title: "Recovery failed",
        message:
          error instanceof Error ? error.message : "The backup could not be restored.",
      });
      return false;
    }
  },

  deleteRecoveryBackup: async (key) => {
    if (typeof localStorage === "undefined") return false;
    const projectId = projectIdFromRecoveryConflictKey(key);
    if (!projectId) return false;
    try {
      return await withProjectStorageLease(projectId, async () => {
        if (localStorage.getItem(key) === null) return true;
        const cleanupKey = publishRecoveryCleanup(projectId);
        localStorage.removeItem(key);
        if (localStorage.getItem(key) !== null) {
          throw new Error("The recovery backup could not be removed.");
        }
        try {
          await completePublishedRecoveryCleanup(projectId, cleanupKey);
        } catch {
          get().pushToast({
            variant: "warn",
            title: "Backup deleted",
            message:
              "The backup was removed. Source-audio cleanup will retry automatically.",
          });
          return true;
        }
        get().pushToast({
          variant: "info",
          title: "Recovery backup deleted",
        });
        return true;
      });
    } catch (error) {
      get().pushToast({
        variant: "error",
        title: "Backup delete failed",
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  },

  saveNow: async () => {
    schedulePersist(get());
    await flushPersist();
    set({ lastSavedAt: Date.now() });
  },

  deleteCurrentProject: async () => {
    if (
      get().recordingTrackId !== null ||
      get().isMultiRecording ||
      get().isStartingRecording ||
      get().isFinalizingRecording
    ) {
      get().pushToast({
        variant: "warn",
        title: "Finish recording first",
        message: "Stop or cancel the active take before deleting this project.",
      });
      return;
    }
    const id = get().currentProjectId;
    const deleteOperation = (canRetireMutableJournals: boolean) =>
      withProjectStorageLease(id, () =>
        withProjectOperation(async () => {
      if (get().currentProjectId !== id) return;
      if (
        get().recordingTrackId !== null ||
        get().isMultiRecording ||
        get().isStartingRecording ||
        get().isFinalizingRecording
      ) {
        get().pushToast({
          variant: "warn",
          title: "Finish recording first",
          message: "Stop or cancel the active take before deleting this project.",
        });
        return;
      }
      const transition = beginProjectTransition();
      let deletionCommitted = false;
      let preparedRecovery: PreparedDeletionRecovery | null = null;
      set({ isLoaded: false, loadError: null });
      try {
        // A timer may already own a pending save. Wait for it before deleting
        // so it cannot recreate the project afterward.
        discardPendingPersist();
        await waitForPersistIdle();
        preparedRecovery = prepareRecoveryForProjectDeletion(id);
        const fallbackProjectId = await dbDeleteProject(
          id,
          preparedRecovery.protectedAudioKeys,
        );
        deletionCommitted = true;
        persistedProjectRevisions.delete(id);
        const retiredLegacyKeys = new Set(
          preparedRecovery.retiredLegacyJournalKeys,
        );
        let cleanupKey: string | null = null;
        if (canRetireMutableJournals && retiredLegacyKeys.size > 0) {
          try {
            // These exact legacy values were already copied/promoted and were
            // intentionally excluded from duplicate conflict backups. Publish
            // a retryable audio-cleanup handle before removing their last
            // source metadata roots.
            cleanupKey = publishRecoveryCleanup(id);
          } catch {
            // Keep retired legacy roots when cleanup cannot be made retryable.
          }
        }
        for (const entry of preparedRecovery.journalEntries) {
          retirePreparedRecoveryEntryAfterExclusiveDelete(
            id,
            entry,
            canRetireMutableJournals &&
              (!retiredLegacyKeys.has(entry.key) || cleanupKey !== null),
          );
        }
        if (
          canRetireMutableJournals &&
          (retiredLegacyKeys.size === 0 || cleanupKey !== null)
        ) {
          try {
            removeRetiredLegacyRecoveryEntriesUnderExclusiveSession(id);
          } catch {
            // Journal removal above already committed; stale retirement
            // metadata is harmless and must not undo a successful deletion.
          }
        }
        if (cleanupKey) {
          try {
            await completePublishedRecoveryCleanup(id, cleanupKey);
          } catch {
            // The immutable cleanup handle is retried during a future startup.
          }
        }
        // Open another project, or create a fresh one.
        if (fallbackProjectId) {
          await holdProjectSessionLease(fallbackProjectId);
          await loadProjectIntoEngineUnlocked(fallbackProjectId, set);
        } else {
          // Always use an unowned identity. Reusing any known id here can
          // deadlock two concurrent deletions: each tab may hold one project's
          // exclusive lock while trying to acquire the other's shared lease.
          const replacementId = makeId();
          await switchToProjectUnlocked(
            replacementId,
            "Untitled",
            false,
            set,
          );
        }
        await get().refreshProjects();
      } catch (error) {
        if (!deletionCommitted) {
          rollbackPreparedDeletionRecovery(preparedRecovery);
        }
        if (deletionCommitted) {
          // The authoritative metadata and blobs are already gone. A failed
          // nested fallback loader advances the project epoch itself, so this
          // recovery must not depend on the now-superseded outer transition.
          // Project operations are serialized, and the fresh switch creates
          // its own epoch fence before it writes any replacement UI state.
          await switchToProjectUnlocked(
            makeId(),
            "Untitled",
            false,
            set,
          );
          set({ isDemoMode: false });
          await get().refreshProjects().catch(() => {});
          get().pushToast({
            variant: "warn",
            title: "Project deleted",
            message:
              "The library couldn't be refreshed, so a new project was opened.",
          });
          return;
        }
        if (transition === projectEpoch) {
          completeProjectTransition(transition);
          set({ isLoaded: true, loadError: null });
          // The failed transaction rolled back atomically. Re-queue the UI
          // snapshot because discardPendingPersist intentionally cleared it.
          schedulePersist(get());
          get().pushToast({
            variant: "error",
            title: "Delete failed",
            message: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        throw error;
      } finally {
        completeProjectTransition(transition);
      }
        }),
      );
    const session = supportsCrossTabProjectStorageLease()
      ? await withExclusiveProjectSession(id, () => deleteOperation(true))
      : { acquired: true, value: await deleteOperation(false) };
    if (!session.acquired) {
      get().pushToast({
        variant: "warn",
        title: "Close other project tabs",
        message:
          "This project is active in another tab. Close that tab before deleting it so pending work is not lost.",
      });
    }
  },

  addTrack: async (kind: TrackKind = "audio") => {
    await withProjectOperation(async () => {
      const project = captureProjectIdentity(get());
      if (!project) return;
      const id = nextId();
      const baseName = kind === "sampler" ? "Sampler" : "Track";
      const name = `${baseName} ${get().tracks.length + 1}`;
      await getEngine().addTrack(id, name, kind);
      if (!isProjectIdentityCurrent(project)) return;
      const t = emptyTrack(id, name, kind);
      t.inputDeviceId = get().defaultInputDeviceId;
      // History snapshots replace the complete track list. Recording the
      // structural add prevents Undo of an older mix edit from unexpectedly
      // deleting a track that did not have its own history boundary.
      pushHistory(get(), `addTrack:${id}`);
      set((s) => ({ tracks: [...s.tracks, t] }));
      // A newly-created engine track starts audible by default. Reapply the
      // aggregate solo mask so it cannot leak through while another track is
      // soloed.
      applyMixState(get().tracks);
      schedulePersist(get());
    });
  },

  loadPadSample: async (trackId, padIdx, file) => {
    const project = captureProjectIdentity(get());
    if (!project) return;
    const track = get().tracks.find((t) => t.id === trackId);
    if (!track || track.kind !== "sampler") return;
    const replacementTarget = padAudioTarget(project.id, trackId, padIdx);
    const replacementToken = beginAudioReplacement(replacementTarget);
    try {
      // Wake the AudioContext before decoding. iOS Safari leaves the context
      // suspended until a user gesture; invoking start() here preserves that
      // activation even though the detached decode finishes asynchronously.
      const startPromise = getEngine().start();
      let buf: AudioBuffer;
      try {
        await startPromise;
        buf = await getEngine().decodeFile(file);
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
      if (
        !isProjectIdentityCurrent(project) ||
        !isCurrentAudioReplacement(replacementTarget, replacementToken)
      ) {
        return;
      }
      const audioKey = makePadAudioKey(project.id, trackId, padIdx);
      await withProjectStorageLease(project.id, async () => {
        await saveAudio(audioKey, audioBufferToWavBlob(buf));
        pendingAudioKeys.add(audioKey);
        let committed = false;
        try {
          await withProjectOperation(async () => {
          const currentTrack = get().tracks.find((t) => t.id === trackId);
          if (
            !isProjectIdentityCurrent(project) ||
            !isCurrentAudioReplacement(replacementTarget, replacementToken) ||
            !currentTrack ||
            currentTrack.kind !== "sampler" ||
            !getEngine().getTrack(trackId)
          ) {
            return;
          }

          // Capture history only after decode and durable blob storage succeed.
          // The short FIFO commit keeps Undo, concurrent loads, and transitions
          // ordered without holding the project lock during a long decode.
          getEngine().setPadBuffer(trackId, padIdx, buf);
          pushHistory(get(), `padSample:${trackId}:${padIdx}`);
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
          committed = true;
          reconcileTransportAfterDurationChange();
          // Flush immediately rather than wait for the 400 ms autosave debounce.
          // The audio blob is already in IDB; if the user reloads the page (or
          // backgrounds the app on mobile, where pagehide doesn't reliably wait
          // for async IDB writes) before the project metadata flushes, the pad's
          // audioKey reference is lost and the blob looks empty on next load.
          schedulePersist(get());
            await flushPersist();
          });
        } finally {
          pendingAudioKeys.delete(audioKey);
          if (!committed) await deleteAudio(audioKey).catch(() => {});
        }
      });
    } finally {
      finishAudioReplacement(replacementTarget, replacementToken);
    }
  },

  clearPadSample: async (trackId, padIdx) => {
    const track = get().tracks.find((t) => t.id === trackId);
    if (!track || track.kind !== "sampler") return;
    invalidateAudioReplacement(
      padAudioTarget(get().currentProjectId, trackId, padIdx),
    );
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
    reconcileTransportAfterDurationChange();
    schedulePersist(get());
    await flushPersist();
  },

  triggerPad: async (trackId, padIdx) => {
    const project = captureProjectIdentity(get());
    if (!project) return;
    // Wake the AudioContext from inside the user gesture before doing
    // anything else — iOS Safari treats post-await work as out-of-gesture.
    await getEngine().start();
    if (!isProjectIdentityCurrent(project)) return;
    getEngine().triggerPad(trackId, padIdx);
    // Record the hit if this sampler is armed and transport is rolling.
    const s = get();
    const track = s.tracks.find((t) => t.id === trackId);
    if (track?.samplerRecArmed && s.isPlaying) {
      const event = sanitizeSamplerEvent(
        { padIdx, timeSec: getEngine().seconds() },
        SAMPLER_PAD_COUNT,
      );
      if (!event || !track.pads[event.padIdx]?.hasAudio) return;
      // Pattern commits are serialized so fast pad rolls cannot overwrite one
      // another. Publish the complete next state before scheduling its write;
      // every autosave/recovery snapshot now sees the same event list as the
      // UI, and Undo queues behind the durable flush held by this operation.
      let applied = false;
      try {
        await withProjectOperation(async () => {
          if (!isProjectIdentityCurrent(project)) return;
          const current = get();
          const currentTrack = current.tracks.find((t) => t.id === trackId);
          if (!currentTrack || currentTrack.kind !== "sampler") return;
          if (samplerHistoryProjectId !== project.id) {
            pushHistory(current, "samplerRecord");
            samplerHistoryProjectId = project.id;
          }
          set((currentState) => ({
            tracks: currentState.tracks.map((candidate) =>
              candidate.id === trackId
                ? {
                    ...candidate,
                    samplerPattern: [...candidate.samplerPattern, event],
                  }
                : candidate,
            ),
          }));
          applied = true;
          schedulePersist(get());
          await flushPersist();
        });
      } catch (error) {
        if (isProjectIdentityCurrent(project)) {
          if (applied) {
            set((currentState) => ({
              tracks: currentState.tracks.map((candidate) =>
                candidate.id === trackId
                  ? {
                      ...candidate,
                      samplerPattern: candidate.samplerPattern.filter(
                        (candidateEvent) => candidateEvent !== event,
                      ),
                    }
                  : candidate,
              ),
            }));
            schedulePersist(get());
            await flushPersist().catch(() => {});
          }
          get().pushToast({
            variant: "error",
            title: "Pattern wasn't saved",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  },

  removeTrack: async (id) => {
    const projectId = get().currentProjectId;
    invalidateAudioReplacement(trackAudioTarget(projectId, id));
    for (let padIdx = 0; padIdx < SAMPLER_PAD_COUNT; padIdx += 1) {
      invalidateAudioReplacement(padAudioTarget(projectId, id, padIdx));
    }
    pushHistory(get(), `removeTrack:${id}`);
    getEngine().removeTrack(id);
    // Don't delete the audio blob here — a snapshot in undoStack may still
    // reference it. Project deletion removes all owned blobs atomically.
    set((s) => ({ tracks: s.tracks.filter((x) => x.id !== id) }));
    // Removing the final soloed track changes every survivor's effective
    // mute state, so reconcile the whole graph rather than only deleting the
    // removed node.
    applyMixState(get().tracks);
    reconcileTransportAfterDurationChange();
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
    const project = captureProjectIdentity(get());
    if (!project || !get().tracks.some((track) => track.id === id)) return;
    const replacementTarget = trackAudioTarget(project.id, id);
    const replacementToken = beginAudioReplacement(replacementTarget);
    try {
      // Decode and persist into a fresh key without touching the live graph.
      // The graph/state swap happens atomically on the project FIFO below.
      const buf = await getEngine().decodeFile(file);
      if (
        !isProjectIdentityCurrent(project) ||
        !isCurrentAudioReplacement(replacementTarget, replacementToken)
      ) {
        return;
      }
      const audioKey = makeAudioKey(project.id, id);
      await withProjectStorageLease(project.id, async () => {
        await saveAudio(audioKey, audioBufferToWavBlob(buf));
        pendingAudioKeys.add(audioKey);
        let committed = false;
        try {
          await withProjectOperation(async () => {
          const currentTrack = get().tracks.find((track) => track.id === id);
          if (
            !isProjectIdentityCurrent(project) ||
            !isCurrentAudioReplacement(replacementTarget, replacementToken) ||
            !currentTrack ||
            !getEngine().getTrack(id)
          ) {
            return;
          }

          getEngine().setTrackBuffer(id, buf);
          pushHistory(get(), `importFile:${id}`);
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
                    normalized: false,
                    normalizationGain: 1,
                  }
                : t,
            ),
          }));
          committed = true;
          if (get().isPlaying) getEngine().rescheduleTrack(id);
          reconcileTransportAfterDurationChange();
          schedulePersist(get());
            await flushPersist();
          });
        } finally {
          pendingAudioKeys.delete(audioKey);
          if (!committed) await deleteAudio(audioKey).catch(() => {});
        }
      });
    } finally {
      finishAudioReplacement(replacementTarget, replacementToken);
    }
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
    const project = captureProjectIdentity(get());
    pushHistory(get(), `trim:${id}`);
    getEngine().setTrim(id, inSec, outSec);
    set((s) => ({
      tracks: s.tracks.map((t) =>
        t.id === id ? { ...t, trimInSec: inSec, trimOutSec: outSec } : t,
      ),
    }));
    if (project && get().isPlaying) {
      const timerKey = trackAudioTarget(project.id, id);
      const previous = trimRescheduleTimers.get(timerKey);
      if (previous) clearTimeout(previous);
      trimRescheduleTimers.set(
        timerKey,
        setTimeout(() => {
          trimRescheduleTimers.delete(timerKey);
          if (isProjectIdentityCurrent(project) && get().isPlaying) {
            getEngine().rescheduleTrack(id);
          }
        }, 80),
      );
    }
    reconcileTransportAfterDurationChange();
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
    await withProjectOperation(async () => {
      const project = captureProjectIdentity(get());
      if (!project) return;
      // Do not start an unbounded silent transport. A zero-length project can
      // occur on a fresh project, after destructive edits, or when every clip
      // is trimmed to zero.
      if (!canRunTransport(get().tracks)) {
        getEngine().stop();
        if (isProjectIdentityCurrent(project)) {
          set({ isPlaying: false, positionSec: 0 });
        }
        return;
      }
      const duration = projectDuration(get().tracks);
      if (
        !hasSamplerCaptureSource(get().tracks) &&
        getEngine().seconds() >= duration
      ) {
        getEngine().stop();
        set({ isPlaying: false, positionSec: 0 });
      }
      // Schedule sampler patterns before starting the transport so the Part
      // is ready to fire. Skip if already playing to avoid destroying in-flight Parts.
      if (!get().isPlaying) {
        resetSamplerHistoryGrouping();
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
      if (isProjectIdentityCurrent(project)) set({ isPlaying: true });
    });
  },

  pause: () => {
    const positionSec = getEngine().pause();
    set({ isPlaying: false, positionSec });
  },

  stop: () => {
    // Stop is also the cancellation boundary for count-in and any pending
    // getUserMedia/setup work. A stream that resolves after this click is
    // released instead of beginning a take.
    cancelPendingRecordingStart();
    getEngine().stop();
    set({
      isPlaying: false,
      positionSec: 0,
      countdownActive: false,
      countdownBeat: 0,
    });
  },

  seek: async (seconds) => {
    await withProjectOperation(async () => {
      const project = captureProjectIdentity(get());
      if (!project) return;
      const nextPosition = clampProjectTime(seconds, projectDuration(get().tracks));
      await getEngine().seek(nextPosition);
      if (isProjectIdentityCurrent(project)) set({ positionSec: nextPosition });
    });
  },

  setBpm: (bpm) => {
    const nextBpm = Math.max(40, Math.min(240, Math.round(bpm)));
    pushHistory(get(), "bpm");
    const engine = getEngine();
    const wasPlaying = get().isPlaying;
    const position = wasPlaying ? engine.seconds() : 0;
    engine.setBpm(nextBpm);
    set({ bpm: nextBpm });
    // Tone.Part converts numeric seconds to transport ticks when constructed.
    // Rebuild after a tempo change so persisted/exported absolute seconds and
    // live sampler playback remain identical.
    for (const track of get().tracks) {
      if (track.kind === "sampler" && track.samplerPattern.length > 0) {
        engine.setSamplerPattern(track.id, track.samplerPattern);
      }
    }
    if (wasPlaying) {
      // Numeric Part times are converted to ticks at the new BPM. Restart the
      // rolling transport from the same absolute project second so its tick
      // origin and the rebuilt Parts use the same conversion.
      void engine.seek(position);
    }
    schedulePersist(get());
  },

  setTimeSignature: (signature) => {
    const next = sanitizeTimeSignature(signature);
    pushHistory(get(), "timeSignature");
    getEngine().setTimeSignature(next);
    set({ timeSignature: next });
    schedulePersist(get());
  },

  toggleMetronome: () => {
    const next = !get().metronomeOn;
    getEngine().setMetronome(next);
    set({ metronomeOn: next });
  },

  startRecording: (trackId) => {
    if (recordingStartBlockCount > 0) return Promise.resolve();
    if (recordingStartInFlight) return recordingStartInFlight;
    const attempt = beginRecordingStartAttempt();
    set({ isStartingRecording: true });
    const operation = (async () => {
      const project = captureProjectIdentity(get());
      if (!project) return;
      // Kick the AudioContext awake inside the user gesture; once we await
      // anything (enumerateDevices, getUserMedia) iOS Safari treats it as
      // out-of-gesture and refuses to resume.
      void getEngine().start();
      await maybeWarnAboutBluetoothMic(get().pushToast);
      if (!isRecordingStartAttemptCurrent(attempt, project)) return;
      const t = get().tracks.find((x) => x.id === trackId);
      if (!t) return;
      try {
        await getEngine().startRecording(
          trackId,
          t.inputDeviceId,
          t.inputGain ?? DEFAULT_INPUT_GAIN,
          attempt.controller.signal,
          (interruption) =>
            handleRecordingInterruption(project, "single", interruption),
        );
        if (!isRecordingStartAttemptCurrent(attempt, project)) {
          await getEngine().stopRecording().catch(() => null);
          return;
        }
        resetSamplerHistoryGrouping();
        set({
          recordingTrackId: trackId,
          isMultiRecording: false,
          isPlaying: true,
        });
        maybeWarnAboutLowSampleRate(
          getEngine().capturedSampleRate(trackId),
          get().pushToast,
        );
      } catch (err) {
        if (isRecordingStartAttemptCurrent(attempt, project)) {
          get().pushToast(toastFromMicError(err));
        }
      }
    })();
    recordingStartInFlight = operation;
    void operation
      .finally(() => {
        if (recordingStartInFlight === operation) {
          recordingStartInFlight = null;
          if (recordingStartAbortController === attempt.controller) {
            recordingStartAbortController = null;
          }
          set({ isStartingRecording: false });
        }
      })
      .catch(() => {});
    return operation;
  },

  exportMix: async (format) => {
    const project = captureProjectIdentity(get());
    if (!project) return;
    const projectName = get().currentProjectName;
    // Capture the latest unsaved edits in the project before mixing — exports
    // should reflect what's on screen even if the autosave debounce hasn't fired.
    await flushPersist();
    if (!isProjectIdentityCurrent(project)) return;
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
      const blob = await encodeBuffer(buf, format, (p) => {
        if (isProjectIdentityCurrent(project)) set({ exportProgress: p });
      });
      downloadBlob(blob, exportFilename(projectName, format));
      get().pushToast({
        variant: "info",
        title: "Export ready",
        message: `Your ${format.toUpperCase()} mixdown was created.`,
        ttlMs: 5000,
      });
    } catch (err) {
      get().pushToast({
        variant: "error",
        title: "Export failed",
        message: err instanceof Error ? err.message : String(err),
        ttlMs: 8000,
      });
    } finally {
      if (isProjectIdentityCurrent(project)) set({ exportProgress: null });
    }
  },

  exportStems: async (format) => {
    const project = captureProjectIdentity(get());
    if (!project) return;
    await flushPersist();
    if (!isProjectIdentityCurrent(project)) return;
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
        const blob = await encodeBuffer(stemBuf, format, (p) => {
          if (isProjectIdentityCurrent(project)) {
            set({ exportProgress: baseFraction + p / stems.length });
          }
        });
        const safeName = stem.name.replace(/[^\w-]+/g, "_") || `track-${i + 1}`;
        downloadBlob(blob, `${projectName}-${safeName}.${format}`);
      }
      get().pushToast({
        variant: "info",
        title: "Stems ready",
        message: `${stems.length} ${format.toUpperCase()} stem${stems.length === 1 ? " was" : "s were"} created.`,
        ttlMs: 5000,
      });
    } catch (err) {
      get().pushToast({
        variant: "error",
        title: "Stem export failed",
        message: err instanceof Error ? err.message : String(err),
        ttlMs: 8000,
      });
    } finally {
      if (isProjectIdentityCurrent(project)) set({ exportProgress: null });
    }
  },

  toggleArm: (id) => {
    set((s) => ({
      tracks: s.tracks.map((t) =>
        t.id === id && t.kind !== "sampler" ? { ...t, armed: !t.armed } : t,
      ),
    }));
    schedulePersist(get());
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
      schedulePersist(get());
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
    schedulePersist(get());
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

  clearSamplerPattern: async (id) => {
    const project = captureProjectIdentity(get());
    if (!project) return;
    await withProjectOperation(async () => {
      if (!isProjectIdentityCurrent(project)) return;
      const track = get().tracks.find((t) => t.id === id);
      if (!track || track.samplerPattern.length === 0) return;
      pushHistory(get(), `samplerPattern:${id}`);
      getEngine().clearSamplerPart(id);
      set((s) => ({
        tracks: s.tracks.map((t) =>
          t.id === id ? { ...t, samplerPattern: [] } : t,
        ),
      }));
      reconcileTransportAfterDurationChange();
      schedulePersist(get());
    });
  },

  startArmedRecording: () => {
    if (recordingStartBlockCount > 0) return Promise.resolve();
    if (recordingStartInFlight) return recordingStartInFlight;
    if (get().isMultiRecording || get().recordingTrackId !== null) {
      return Promise.resolve();
    }
    const attempt = beginRecordingStartAttempt();
    activeMultiRecordingTrackIds.clear();
    set({ isStartingRecording: true });
    const operation = (async () => {
    const project = captureProjectIdentity(get());
    if (!project) return;
    // Kick the AudioContext awake inside the user gesture; once we await
    // anything (enumerateDevices, getUserMedia) iOS Safari treats it as
    // out-of-gesture and refuses to resume.
    void getEngine().start();
    await maybeWarnAboutBluetoothMic(get().pushToast);
    if (!isRecordingStartAttemptCurrent(attempt, project)) return;
    const all = get().tracks;
    // Sampler tracks aren't recordable — they hold per-pad samples loaded
    // by the user, not a single timeline buffer.
    const recordable = all.filter((t) => t.kind !== "sampler");
    let targets = recordable.filter((t) => t.armed);
    const autoArmedIds = new Set<string>();
    // If the user hasn't armed anything, default to all empty tracks so
    // pressing the master record on a fresh project Just Works without
    // overwriting any imported/recorded audio.
    if (targets.length === 0) {
      targets = recordable.filter((t) => !t.hasAudio);
      for (const target of targets) autoArmedIds.add(target.id);
    }
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
          attempt.controller.signal,
          (interruption) =>
            handleRecordingInterruption(project, "multi", interruption),
          get().countInBeats > 0
            ? async () => {
                const ok = await runCountIn(
                  get().countInBeats,
                  get().bpm,
                  get().timeSignature,
                  getEngine().recordingStartOffsetFromToneNow(),
                  project,
                  set,
                  attempt.controller.signal,
                );
                if (!ok) {
                  const error = new Error("Recording start cancelled");
                  error.name = "AbortError";
                  throw error;
                }
              }
            : undefined,
        );
        if (!isRecordingStartAttemptCurrent(attempt, project)) {
          await getEngine().stopMultiRecording().catch(() => ({
            results: new Map<string, AudioBuffer | null>(),
            errors: new Map<string, Error>(),
          }));
          activeMultiRecordingTrackIds.clear();
          if (isProjectIdentityCurrent(project) && autoArmedIds.size > 0) {
            set((s) => ({
              tracks: s.tracks.map((t) =>
                autoArmedIds.has(t.id) ? { ...t, armed: false } : t,
              ),
            }));
          }
          return;
        }
        for (const target of targets) {
          activeMultiRecordingTrackIds.add(target.id);
        }
        resetSamplerHistoryGrouping();
        set({ isMultiRecording: true, isPlaying: true, recordingTrackId: null });
        const rates = targets
          .map((t) => getEngine().capturedSampleRate(t.id))
          .filter((r): r is number => typeof r === "number");
        if (rates.length > 0) {
          maybeWarnAboutLowSampleRate(Math.min(...rates), get().pushToast);
        }
      } catch (err) {
        activeMultiRecordingTrackIds.clear();
        if (!isRecordingStartAttemptCurrent(attempt, project)) {
          if (isProjectIdentityCurrent(project) && autoArmedIds.size > 0) {
            set((s) => ({
              tracks: s.tracks.map((t) =>
                autoArmedIds.has(t.id) ? { ...t, armed: false } : t,
              ),
            }));
          }
          return;
        }
        // Roll back only auto-arming from this attempt. Manually armed tracks
        // remain the user's explicit selection after a permission/device error.
        if (isProjectIdentityCurrent(project)) {
          set((s) => ({
            tracks: s.tracks.map((t) =>
              autoArmedIds.has(t.id) ? { ...t, armed: false } : t,
            ),
          }));
          get().pushToast(toastFromMicError(err));
        }
      }
    } else {
      // All recordable tracks already have audio, so this action is playback
      // only. Sampler-only and fully-trimmed projects may still be silent.
      const beats = get().countInBeats;
      if (beats > 0) {
        const ok = await runCountIn(
          beats,
          get().bpm,
          get().timeSignature,
          getEngine().playStartOffsetFromToneNow(),
          project,
          set,
          attempt.controller.signal,
        );
        if (!ok || !isRecordingStartAttemptCurrent(attempt, project)) return;
      }
      if (!canRunTransport(get().tracks)) {
        getEngine().stop();
        if (isProjectIdentityCurrent(project)) {
          set({ isPlaying: false, positionSec: 0 });
        }
        return;
      }
      await getEngine().play();
      if (!isRecordingStartAttemptCurrent(attempt, project)) {
        getEngine().stop();
        return;
      }
      resetSamplerHistoryGrouping();
      set({ isPlaying: true });
    }
    })();
    recordingStartInFlight = operation;
    void operation
      .finally(() => {
        if (recordingStartInFlight === operation) {
          recordingStartInFlight = null;
          if (recordingStartAbortController === attempt.controller) {
            recordingStartAbortController = null;
          }
          set({ isStartingRecording: false });
        }
      })
      .catch(() => {});
    return operation;
  },

  stopArmedRecording: () => {
    if (recordingStopInFlight) return recordingStopInFlight;
    set({ isFinalizingRecording: true });
    const operation = (async () => {
    const startingState = get();
    const project = captureProjectIdentity(startingState);
    const latencyOffsetMs = startingState.latencyOffsetMs;
    const activeTargetIds = new Set(activeMultiRecordingTrackIds);
    const replacements = new Map<
      string,
      { target: string; token: symbol }
    >();
    if (project) {
      for (const track of startingState.tracks) {
        if (track.kind === "sampler" || !activeTargetIds.has(track.id)) continue;
        const target = trackAudioTarget(project.id, track.id);
        replacements.set(track.id, {
          target,
          token: beginAudioReplacement(target),
        });
      }
    }
    const updates = new Map<
      string,
      { audioKey: string; duration: number; buffer: AudioBuffer }
    >();
    try {
      let results = new Map<string, AudioBuffer | null>();
      let errors = new Map<string, Error>();
      try {
        const out = await getEngine().stopMultiRecording();
        results = out.results;
        errors = out.errors;
      } catch (err) {
        if (project && isProjectIdentityCurrent(project)) {
          get().pushToast(toastFromCaptureError(err));
        }
      }
      if (project && isProjectIdentityCurrent(project)) {
        set({ isMultiRecording: false, isPlaying: false });
      }
      for (const [trackId, err] of errors) {
        if (!project || !isProjectIdentityCurrent(project)) break;
        const t = get().tracks.find((x) => x.id === trackId);
        const toast = toastFromCaptureError(err);
        get().pushToast({
          ...toast,
          title: t ? `${t.name}: ${toast.title}` : toast.title,
        });
      }
      if (!project || !isProjectIdentityCurrent(project)) return;

      await withProjectStorageLease(project.id, async () => {
        try {
        for (const [trackId, buf] of results) {
          if (!buf) continue;
          const replacement = replacements.get(trackId);
          if (
            !replacement ||
            !isProjectIdentityCurrent(project) ||
            !isCurrentAudioReplacement(
              replacement.target,
              replacement.token,
            )
          ) {
            continue;
          }
          const audioKey = makeAudioKey(project.id, trackId);
          await saveAudio(audioKey, audioBufferToWavBlob(buf));
          pendingAudioKeys.add(audioKey);
          updates.set(trackId, {
            audioKey,
            duration: buf.duration,
            buffer: buf,
          });
        }
        } catch (error) {
        for (const update of updates.values()) {
          pendingAudioKeys.delete(update.audioKey);
        }
        await Promise.all(
          [...updates.values()].map((update) => deleteAudio(update.audioKey)),
        );
        if (isProjectIdentityCurrent(project)) {
          get().pushToast({
            variant: "error",
            title: "Recording wasn't saved",
            message: error instanceof Error ? error.message : String(error),
          });
        }
          return;
        }

        const committedAudioKeys = new Set<string>();
        try {
          await withProjectOperation(async () => {
          if (!isProjectIdentityCurrent(project)) return;
          const stateTrackIds = new Set(get().tracks.map((track) => track.id));
          const validUpdates = new Map(
            [...updates].filter(([trackId]) => {
              const replacement = replacements.get(trackId);
              if (!replacement) return false;
              return (
                stateTrackIds.has(trackId) &&
                Boolean(getEngine().getTrack(trackId)) &&
                isCurrentAudioReplacement(
                  replacement.target,
                  replacement.token,
                )
              );
            }),
          );
          if (validUpdates.size === 0) return;

          // The take is now durable and every target still exists. Attach all
          // buffers first, then capture the exact pre-commit store state so
          // intervening edits remain independently undoable.
          const latencySec = latencyOffsetMs / 1000;
          for (const [trackId, update] of validUpdates) {
            getEngine().setTrackBuffer(trackId, update.buffer);
            const trimIn = Math.max(
              0,
              Math.min(update.duration, latencySec),
            );
            getEngine().setTrim(trackId, trimIn, null);
          }
          pushHistory(
            get(),
            `recording:${[...validUpdates.keys()].sort().join(",")}`,
          );
          set((s) => ({
            tracks: s.tracks.map((track) => {
              const update = validUpdates.get(track.id);
              if (!update) return track;
              const trimIn = Math.max(
                0,
                Math.min(update.duration, latencySec),
              );
              return {
                ...track,
                hasAudio: true,
                fileName: "Recording",
                durationSec: update.duration,
                bufferRevision: track.bufferRevision + 1,
                audioKey: update.audioKey,
                trimInSec: trimIn,
                trimOutSec: null,
                normalized: false,
                normalizationGain: 1,
              };
            }),
          }));
          for (const update of validUpdates.values()) {
            committedAudioKeys.add(update.audioKey);
          }
          schedulePersist(get());
            await flushPersist();
          });
        } finally {
          for (const update of updates.values()) {
            pendingAudioKeys.delete(update.audioKey);
          }
          await Promise.all(
            [...updates.values()]
              .filter((update) => !committedAudioKeys.has(update.audioKey))
              .map((update) => deleteAudio(update.audioKey).catch(() => {})),
          );
        }
      });
    } finally {
      activeMultiRecordingTrackIds.clear();
      for (const replacement of replacements.values()) {
        finishAudioReplacement(replacement.target, replacement.token);
      }
    }
    })();
    recordingStopInFlight = operation;
    void operation
      .finally(() => {
        if (recordingStopInFlight === operation) {
          recordingStopInFlight = null;
          set({ isFinalizingRecording: false });
        }
      })
      .catch(() => {});
    return operation;
  },

  stopRecording: () => {
    if (recordingStopInFlight) return recordingStopInFlight;
    set({ isFinalizingRecording: true });
    const operation = (async () => {
    const startingState = get();
    const project = captureProjectIdentity(startingState);
    const id = startingState.recordingTrackId;
    const latencyOffsetMs = startingState.latencyOffsetMs;
    const replacementTarget =
      project && id ? trackAudioTarget(project.id, id) : null;
    const replacementToken = replacementTarget
      ? beginAudioReplacement(replacementTarget)
      : null;
    try {
      let buf: AudioBuffer | null = null;
      try {
        buf = await getEngine().stopRecording();
      } catch (err) {
        if (project && isProjectIdentityCurrent(project)) {
          get().pushToast(toastFromCaptureError(err));
        }
      }
      if (project && isProjectIdentityCurrent(project)) {
        set({ recordingTrackId: null, isPlaying: false });
      }
      if (
        !project ||
        !isProjectIdentityCurrent(project) ||
        !id ||
        !buf ||
        !replacementTarget ||
        !replacementToken ||
        !isCurrentAudioReplacement(replacementTarget, replacementToken)
      ) {
        return;
      }

      const audioKey = makeAudioKey(project.id, id);
      await withProjectStorageLease(project.id, async () => {
        try {
          await saveAudio(audioKey, audioBufferToWavBlob(buf));
        } catch (error) {
          if (isProjectIdentityCurrent(project)) {
            get().pushToast({
              variant: "error",
              title: "Recording wasn't saved",
              message: error instanceof Error ? error.message : String(error),
            });
          }
          return;
        }
        pendingAudioKeys.add(audioKey);
        let committed = false;
        try {
          await withProjectOperation(async () => {
          const targetStillExists = get().tracks.some(
            (track) => track.id === id,
          );
          if (
            !isProjectIdentityCurrent(project) ||
            !isCurrentAudioReplacement(
              replacementTarget,
              replacementToken,
            ) ||
            !targetStillExists ||
            !getEngine().getTrack(id)
          ) {
            return;
          }

          getEngine().setTrackBuffer(id, buf);
          pushHistory(get(), `recording:${id}`);
          const latencySec = latencyOffsetMs / 1000;
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
                    normalized: false,
                    normalizationGain: 1,
                  }
                : t,
            ),
          }));
          committed = true;
          schedulePersist(get());
            await flushPersist();
          });
        } finally {
          pendingAudioKeys.delete(audioKey);
          if (!committed) await deleteAudio(audioKey).catch(() => {});
        }
      });
    } finally {
      if (replacementTarget && replacementToken) {
        finishAudioReplacement(replacementTarget, replacementToken);
      }
    }
    })();
    recordingStopInFlight = operation;
    void operation
      .finally(() => {
        if (recordingStopInFlight === operation) {
          recordingStopInFlight = null;
          set({ isFinalizingRecording: false });
        }
      })
      .catch(() => {});
    return operation;
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
let persistInFlight: Promise<void> | null = null;

interface PersistInput {
  currentProjectId: string;
  currentProjectName: string;
  tracks: TrackState[];
  bpm: number;
  timeSignature: TimeSignature;
  latencyOffsetMs: number;
  countInBeats: number;
}

interface DirtyPersistSnapshot {
  generation: number;
  changedAt: number;
  acceptableBaseUpdatedAts: Array<number | null>;
  state: PersistInput;
}

let persistGeneration = 0;
let lastDirtyAt = 0;
let dirtyPersistSnapshot: DirtyPersistSnapshot | null = null;
// The revision each open project was loaded or last saved from. A read/write
// transaction compares this value before replacing the complete snapshot, so
// delayed work from another tab cannot silently clobber a newer edit.
const persistedProjectRevisions = new Map<string, number | null>();

function buildPersisted(state: PersistInput): PersistedProject {
  return {
    id: state.currentProjectId,
    name: state.currentProjectName,
    bpm: state.bpm,
    timeSignature: state.timeSignature,
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
      samplerPattern:
        t.kind === "sampler"
          ? t.samplerPattern.flatMap<PersistedSamplerEvent>((event) => {
              const safeEvent = sanitizeSamplerEvent(
                event,
                SAMPLER_PAD_COUNT,
              );
              return safeEvent ? [safeEvent] : [];
            })
          : undefined,
    })),
    createdAt: 0, // filled in by flush — preserves existing createdAt if present.
    updatedAt: Date.now(),
    latencyOffsetMs: state.latencyOffsetMs,
    countInBeats: state.countInBeats,
  };
}

const LEGACY_RECOVERY_SNAPSHOT_KEY = "cypher:pending-project-snapshot";
const RECOVERY_SNAPSHOT_PREFIX = "cypher:pending-project-snapshot:";
const RECOVERY_CONFLICT_PREFIX = "cypher:conflicted-project-snapshot:";
const RECOVERY_CLEANUP_PREFIX = "cypher:recovery-audio-cleanup:";
const RECOVERY_RETIREMENT_PREFIX = "cypher:retired-recovery-journal:";

interface RecoveryEnvelope {
  version: 3;
  project: PersistedProject;
  acceptableBaseUpdatedAts: Array<number | null>;
}

interface RecoveryEntry {
  key: string;
  envelope: RecoveryEnvelope;
  serialized: string | null;
}

let recoverySessionId: string | null = null;

function getRecoverySessionId() {
  if (!recoverySessionId) {
    recoverySessionId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : makeId();
  }
  return recoverySessionId;
}

function recoveryConflictKey(projectId: string) {
  return `${RECOVERY_CONFLICT_PREFIX}${encodeURIComponent(projectId)}:${makeId()}`;
}

function projectIdFromRecoveryConflictKey(key: string): string | null {
  if (!key.startsWith(RECOVERY_CONFLICT_PREFIX)) return null;
  const encodedProjectId = key
    .slice(RECOVERY_CONFLICT_PREFIX.length)
    .split(":", 1)[0];
  if (!encodedProjectId) return null;
  try {
    return decodeURIComponent(encodedProjectId);
  } catch {
    return null;
  }
}

function recoveryCleanupKey(projectId: string) {
  return `${RECOVERY_CLEANUP_PREFIX}${encodeURIComponent(projectId)}:${makeId()}`;
}

function projectIdFromRecoveryCleanupKey(key: string): string | null {
  if (!key.startsWith(RECOVERY_CLEANUP_PREFIX)) return null;
  const encodedProjectId = key
    .slice(RECOVERY_CLEANUP_PREFIX.length)
    .split(":", 1)[0];
  if (!encodedProjectId) return null;
  try {
    return decodeURIComponent(encodedProjectId);
  } catch {
    return null;
  }
}

function publishRecoveryCleanup(projectId: string): string {
  if (typeof localStorage === "undefined") {
    throw new Error("Recovery storage is unavailable.");
  }
  const key = recoveryCleanupKey(projectId);
  localStorage.setItem(key, String(Date.now()));
  return key;
}

async function completePublishedRecoveryCleanup(
  projectId: string,
  cleanupKey: string,
) {
  await cleanupDeletedRecoveryAudioIfSafe(projectId);
  // Tombstones are immutable and nonce-suffixed. Removing this exact entry
  // cannot erase a newer cleanup request published by another action/tab.
  localStorage.removeItem(cleanupKey);
}

async function retryPendingRecoveryCleanup() {
  if (typeof localStorage === "undefined") return;
  const pending: Array<{ key: string; projectId: string }> = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(RECOVERY_CLEANUP_PREFIX)) continue;
      const projectId = projectIdFromRecoveryCleanupKey(key);
      if (projectId) pending.push({ key, projectId });
    }
  } catch {
    return;
  }
  for (const entry of pending) {
    try {
      await withProjectStorageLease(entry.projectId, () =>
        completePublishedRecoveryCleanup(entry.projectId, entry.key),
      );
    } catch {
      // Leave the immutable tombstone for the next startup.
    }
  }
}

interface PreparedDeletionRecovery {
  journalEntries: RecoveryEntry[];
  retiredLegacyJournalKeys: string[];
  createdBackupKeys: string[];
  protectedAudioKeys: string[];
}

/** Make every pending journal visible in MainMenu before its project row goes. */
function prepareRecoveryForProjectDeletion(
  projectId: string,
): PreparedDeletionRecovery {
  if (typeof localStorage === "undefined") {
    throw new Error("Recovery storage is unavailable.");
  }
  const allJournals = readRecoverySnapshotsStrict(projectId, true);
  // A matching retirement marker proves this exact mutable legacy value was
  // already promoted/copied. Do not manufacture a duplicate visible backup;
  // the exclusive delete path below will retire its stale source key.
  const journals = allJournals.filter(
    (entry) => !isRetiredLegacyRecoveryEntry(projectId, entry),
  );
  const retiredLegacyJournalKeys = allJournals
    .filter((entry) => isRetiredLegacyRecoveryEntry(projectId, entry))
    .map(({ key }) => key);
  const createdBackupKeys: string[] = [];
  try {
    for (const entry of journals) {
      const key = recoveryConflictKey(projectId);
      localStorage.setItem(
        key,
        JSON.stringify({
          ...entry.envelope,
          currentUpdatedAt: null,
          conflictedAt: Date.now(),
        }),
      );
      createdBackupKeys.push(key);
    }
    return {
      journalEntries: allJournals,
      retiredLegacyJournalKeys,
      createdBackupKeys,
      protectedAudioKeys: recoveryAudioReferences(projectId),
    };
  } catch (error) {
    for (const key of createdBackupKeys) {
      try {
        localStorage.removeItem(key);
      } catch {
        // The source journals still exist; an extra visible backup is safe.
      }
    }
    throw error;
  }
}

function rollbackPreparedDeletionRecovery(
  prepared: PreparedDeletionRecovery | null,
) {
  if (!prepared || typeof localStorage === "undefined") return;
  for (const key of prepared.createdBackupKeys) {
    try {
      localStorage.removeItem(key);
    } catch {
      // A duplicate visible backup is preferable to losing the journal.
    }
  }
}

async function cleanupDeletedRecoveryAudioIfSafe(projectId: string) {
  // Strict scanning fails closed. If recovery storage becomes unreadable, keep
  // extra bytes rather than risk deleting the only copy of a dormant take.
  const protectedAudioKeys = recoveryAudioReferences(projectId);
  await cleanupDeletedProjectAudio(projectId, protectedAudioKeys);
}

function legacyProjectRecoveryKey(projectId: string) {
  return `${RECOVERY_SNAPSHOT_PREFIX}${encodeURIComponent(projectId)}`;
}

function currentRecoverySessionKeyPrefix(projectId: string) {
  return `${legacyProjectRecoveryKey(projectId)}:${getRecoverySessionId()}:`;
}

function isCurrentRecoverySessionKey(projectId: string, key: string) {
  return key.startsWith(currentRecoverySessionKeyPrefix(projectId));
}

function recoverySnapshotKey(projectId: string, generation: number) {
  // Each value is immutable after publication. A recovery reader can safely
  // delete the exact key it processed without racing an owning tab that is
  // publishing a successor snapshot under a fresh nonce-suffixed key.
  return `${currentRecoverySessionKeyPrefix(projectId)}${generation.toString(36)}:${makeId()}`;
}

function isImmutableRecoverySnapshotKey(key: string) {
  if (!key.startsWith(RECOVERY_SNAPSHOT_PREFIX)) return false;
  // encoded project id, session id, generation, publication nonce
  return key.slice(RECOVERY_SNAPSHOT_PREFIX.length).split(":").length >= 4;
}

function immutableRecoverySessionId(projectId: string, key: string) {
  if (!isImmutableRecoverySnapshotKey(key)) return null;
  const prefix = `${legacyProjectRecoveryKey(projectId)}:`;
  if (!key.startsWith(prefix)) return null;
  const [sessionId, generation, nonce] = key.slice(prefix.length).split(":");
  return sessionId && generation && nonce ? sessionId : null;
}

interface LegacyRecoveryRetirement {
  markerKey: string;
  sourceKey: string;
  sourceRaw: string;
}

function legacyRecoveryRetirementKey(projectId: string) {
  return `${RECOVERY_RETIREMENT_PREFIX}${encodeURIComponent(projectId)}:${makeId()}`;
}

function readLegacyRecoveryRetirements(
  projectId: string,
): LegacyRecoveryRetirement[] {
  if (typeof localStorage === "undefined") return [];
  const prefix = `${RECOVERY_RETIREMENT_PREFIX}${encodeURIComponent(projectId)}:`;
  const retirements: LegacyRecoveryRetirement[] = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const markerKey = localStorage.key(index);
      if (!markerKey?.startsWith(prefix)) continue;
      const raw = localStorage.getItem(markerKey);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as {
        sourceKey?: unknown;
        sourceRaw?: unknown;
      };
      if (
        typeof parsed.sourceKey === "string" &&
        typeof parsed.sourceRaw === "string"
      ) {
        retirements.push({
          markerKey,
          sourceKey: parsed.sourceKey,
          sourceRaw: parsed.sourceRaw,
        });
      }
    }
  } catch {
    // A missing/corrupt retirement marker only causes conservative duplicate
    // recovery; it can never authorize deleting a journal or its audio.
  }
  return retirements;
}

function isRetiredLegacyRecoveryEntry(
  projectId: string,
  entry: RecoveryEntry,
) {
  return (
    !isImmutableRecoverySnapshotKey(entry.key) &&
    entry.serialized !== null &&
    readLegacyRecoveryRetirements(projectId).some(
      ({ sourceKey, sourceRaw }) =>
        sourceKey === entry.key && sourceRaw === entry.serialized,
    )
  );
}

function retireHandledRecoveryEntry(projectId: string, entry: RecoveryEntry) {
  if (isImmutableRecoverySnapshotKey(entry.key)) {
    removeRecoveryEntry(entry.key);
    return;
  }
  if (typeof localStorage === "undefined" || entry.serialized === null) return;
  try {
    const markerKey = legacyRecoveryRetirementKey(projectId);
    localStorage.setItem(
      markerKey,
      JSON.stringify({ sourceKey: entry.key, sourceRaw: entry.serialized }),
    );
  } catch {
    // Keep the legacy journal discoverable. It may be materialized again, but
    // no pending branch is lost when retirement metadata cannot be stored.
  }
}

function removeRetiredLegacyRecoveryEntriesUnderExclusiveSession(
  projectId: string,
  removeMarkers = true,
) {
  if (typeof localStorage === "undefined") return;
  const groups = new Map<string, LegacyRecoveryRetirement[]>();
  for (const retirement of readLegacyRecoveryRetirements(projectId)) {
    const group = groups.get(retirement.sourceKey) ?? [];
    group.push(retirement);
    groups.set(retirement.sourceKey, group);
  }
  for (const [sourceKey, retirements] of groups) {
    if (sourceKey === LEGACY_RECOVERY_SNAPSHOT_KEY) {
      // This key is shared by every project from the oldest schema. A
      // per-project exclusive lock cannot authorize deleting it or its
      // exact-value retirement marker.
      continue;
    }
    const currentRaw = localStorage.getItem(sourceKey);
    if (
      currentRaw !== null &&
      retirements.some(({ sourceRaw }) => sourceRaw === currentRaw)
    ) {
      // The caller holds the project's exclusive lifetime session lock, so no
      // cooperating writer can replace this mutable legacy value between the
      // check and removal.
      localStorage.removeItem(sourceKey);
      if (localStorage.getItem(sourceKey) !== null) {
        throw new Error("A retired recovery journal could not be removed.");
      }
    }
    if (removeMarkers) {
      for (const { markerKey } of retirements) {
        localStorage.removeItem(markerKey);
      }
    }
  }
}

function isPersistedProject(value: unknown): value is PersistedProject {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedProject>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.bpm === "number" &&
    Array.isArray(candidate.tracks) &&
    typeof candidate.updatedAt === "number"
  );
}

function addProjectAudioReferences(
  project: PersistedProject,
  references: Set<string>,
) {
  for (const track of project.tracks) {
    if (track.audioKey) references.add(track.audioKey);
    for (const pad of track.pads ?? []) {
      if (pad.audioKey) references.add(pad.audioKey);
    }
  }
}

function recoveryAudioReferences(projectId: string): string[] {
  const references = new Set<string>();
  if (typeof localStorage === "undefined") {
    throw new Error(
      "Recovery storage is unavailable, so Cypher cannot compact this project safely.",
    );
  }
  try {
    void localStorage.length;
  } catch {
    throw new Error(
      "Recovery storage is unavailable, so Cypher cannot compact this project safely.",
    );
  }
  for (const entry of readRecoverySnapshotsStrict(projectId)) {
    addProjectAudioReferences(entry.envelope.project, references);
  }
  try {
    const projectBackupPrefix = `${RECOVERY_CONFLICT_PREFIX}${encodeURIComponent(
      projectId,
    )}:`;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(projectBackupPrefix)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { project?: unknown };
        if (
          isPersistedProject(parsed.project) &&
          parsed.project.id === projectId
        ) {
          addProjectAudioReferences(parsed.project, references);
        } else {
          throw new Error("Recovery backup metadata does not match its project.");
        }
      } catch (error) {
        throw new Error(
          "A recovery backup is unreadable, so Cypher cannot compact or delete this project safely.",
          { cause: error },
        );
      }
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("A recovery backup is unreadable")
    ) {
      throw error;
    }
    throw new Error(
      "Recovery storage changed while Cypher was checking it. Retry the storage action.",
      { cause: error },
    );
  }
  return [...references];
}

function parseRecoveryEnvelope(
  raw: string,
  projectId: string,
): RecoveryEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as {
      version?: number;
      project?: unknown;
      acceptableBaseUpdatedAts?: Array<number | null>;
      expectedUpdatedAt?: number | null;
      hasKnownBase?: boolean;
    };
    if (
      parsed.version === 3 &&
      isPersistedProject(parsed.project) &&
      Array.isArray(parsed.acceptableBaseUpdatedAts) &&
      parsed.acceptableBaseUpdatedAts.every(
        (revision) => typeof revision === "number" || revision === null,
      )
    ) {
      if (parsed.project.id !== projectId) return null;
      return {
        version: 3,
        project: parsed.project,
        acceptableBaseUpdatedAts: [
          ...new Set(parsed.acceptableBaseUpdatedAts),
        ],
      };
    }
    // v2 journals carried one expected base revision. Convert them without
    // weakening the compare-and-swap rule used by recovery.
    if (
      parsed.version === 2 &&
      isPersistedProject(parsed.project) &&
      (typeof parsed.expectedUpdatedAt === "number" ||
        parsed.expectedUpdatedAt === null)
    ) {
      if (parsed.project.id !== projectId) return null;
      return {
        version: 3,
        project: parsed.project,
        acceptableBaseUpdatedAts:
          parsed.hasKnownBase === false ? [null] : [parsed.expectedUpdatedAt],
      };
    }
    // Legacy journals did not carry a base revision. They can safely create a
    // missing project, but must never replace an existing record.
    if (isPersistedProject(parsed) && parsed.id === projectId) {
      return {
        version: 3,
        project: parsed,
        acceptableBaseUpdatedAts: [null],
      };
    }
    return null;
  } catch {
    return null;
  }
}

function collapseImmutableRecoveryGenerations(
  projectId: string,
  entries: RecoveryEntry[],
) {
  const retained: RecoveryEntry[] = [];
  const bySession = new Map<string, RecoveryEntry[]>();
  for (const entry of entries) {
    const sessionId = immutableRecoverySessionId(projectId, entry.key);
    if (!sessionId) {
      retained.push(entry);
      continue;
    }
    const group = bySession.get(sessionId) ?? [];
    group.push(entry);
    bySession.set(sessionId, group);
  }

  for (const group of bySession.values()) {
    const newestUpdatedAt = Math.max(
      ...group.map(({ envelope }) => envelope.project.updatedAt),
    );
    const newest = group.filter(
      ({ envelope }) => envelope.project.updatedAt === newestUpdatedAt,
    );
    const first = newest[0];
    const sameSnapshot = newest.every((entry) =>
      projectsRepresentSameSnapshot(first.envelope.project, entry.envelope.project),
    );
    const winners = sameSnapshot
      ? [
          newest.toSorted(
            (a, b) =>
              b.envelope.acceptableBaseUpdatedAts.length -
                a.envelope.acceptableBaseUpdatedAts.length ||
              b.key.localeCompare(a.key),
          )[0],
        ]
      : newest;
    const winnerKeys = new Set(winners.map(({ key }) => key));
    retained.push(...winners);
    for (const entry of group) {
      if (!winnerKeys.has(entry.key)) removeRecoveryEntry(entry.key);
    }
  }
  return retained;
}

function readRecoverySnapshots(projectId: string): RecoveryEntry[] {
  if (typeof localStorage === "undefined") return [];
  const legacyProjectKey = legacyProjectRecoveryKey(projectId);
  const sessionPrefix = `${legacyProjectKey}:`;
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === legacyProjectKey || key?.startsWith(sessionPrefix)) {
        keys.push(key);
      }
    }
    if (localStorage.getItem(LEGACY_RECOVERY_SNAPSHOT_KEY)) {
      keys.push(LEGACY_RECOVERY_SNAPSHOT_KEY);
    }
  } catch {
    return [];
  }

  const entries: RecoveryEntry[] = [];
  for (const key of new Set(keys)) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const envelope = parseRecoveryEnvelope(raw, projectId);
      if (envelope) {
        const entry: RecoveryEntry = { key, envelope, serialized: raw };
        if (!isRetiredLegacyRecoveryEntry(projectId, entry)) {
          entries.push(entry);
        }
      } else if (isImmutableRecoverySnapshotKey(key)) {
        localStorage.removeItem(key);
      }
    } catch {
      // Leave an unreadable entry in place; another session may still be able
      // to inspect or export it when storage access becomes available.
    }
  }
  return collapseImmutableRecoveryGenerations(projectId, entries).sort(
    (a, b) =>
      b.envelope.project.updatedAt - a.envelope.project.updatedAt ||
      a.key.localeCompare(b.key),
  );
}

/**
 * Read every journal that could root audio for a destructive storage action.
 * The normal recovery path is intentionally best-effort so one corrupt entry
 * cannot prevent startup; compaction/deletion must instead fail closed when a
 * journal cannot be enumerated or parsed.
 */
function readRecoverySnapshotsStrict(
  projectId: string,
  includeRetiredLegacy = false,
): RecoveryEntry[] {
  if (typeof localStorage === "undefined") {
    throw new Error("Recovery storage is unavailable.");
  }
  const legacyProjectKey = legacyProjectRecoveryKey(projectId);
  const sessionPrefix = `${legacyProjectKey}:`;
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key === legacyProjectKey || key?.startsWith(sessionPrefix)) {
      keys.push(key);
    }
  }
  if (localStorage.getItem(LEGACY_RECOVERY_SNAPSHOT_KEY) !== null) {
    keys.push(LEGACY_RECOVERY_SNAPSHOT_KEY);
  }

  const entries: RecoveryEntry[] = [];
  for (const key of new Set(keys)) {
    const raw = localStorage.getItem(key);
    // Another document may have just promoted and removed this entry. Missing
    // is safe; unreadable is not, because its audio roots are unknowable.
    if (raw === null) continue;
    const envelope = parseRecoveryEnvelope(raw, projectId);
    if (envelope) {
      entries.push({ key, envelope, serialized: raw });
      continue;
    }

    if (key === LEGACY_RECOVERY_SNAPSHOT_KEY) {
      try {
        const parsed = JSON.parse(raw) as { project?: unknown };
        const candidate = isPersistedProject(parsed.project)
          ? parsed.project
          : isPersistedProject(parsed)
            ? parsed
            : null;
        if (candidate && candidate.id !== projectId) continue;
      } catch {
        // The owner cannot be determined, so it may belong to this project.
      }
    }
    throw new Error(
      "A recovery journal is unreadable, so Cypher cannot compact or delete this project safely.",
    );
  }
  // Destructive storage actions must root every generation they observed.
  // Best-effort pruning may have failed, and an older full snapshot can still
  // uniquely reference audio that the newest generation removed.
  const rootedEntries = includeRetiredLegacy
    ? entries
    : entries.filter(
        (entry) => !isRetiredLegacyRecoveryEntry(projectId, entry),
      );
  return rootedEntries.sort(
    (a, b) =>
      b.envelope.project.updatedAt - a.envelope.project.updatedAt ||
      a.key.localeCompare(b.key),
  );
}

function writeRecoverySnapshot(): boolean {
  if (typeof localStorage === "undefined" || projectTransitioning) return false;
  const dirty = dirtyPersistSnapshot;
  if (!dirty) return false;
  try {
    const snapshot = buildPersisted(dirty.state);
    // Preserve the edit revision. An idle/stale tab must not become "newer"
    // merely because it was hidden after another tab saved real changes.
    snapshot.updatedAt = dirty.changedAt;
    const envelope: RecoveryEnvelope = {
      version: 3,
      project: snapshot,
      acceptableBaseUpdatedAts: [...dirty.acceptableBaseUpdatedAts],
    };
    const publishedKey = recoverySnapshotKey(snapshot.id, dirty.generation);
    // Publish the complete successor before pruning older entries. Recovery
    // readers treat keys as immutable, so deleting an entry they already read
    // can never delete this newly published generation.
    localStorage.setItem(publishedKey, JSON.stringify(envelope));
    for (const key of currentRecoverySessionKeys(snapshot.id)) {
      if (key !== publishedKey) localStorage.removeItem(key);
    }
    return true;
  } catch {
    // IndexedDB autosave remains the primary path when localStorage is full
    // or unavailable. Audio data is never written to localStorage.
    return false;
  }
}

function currentRecoverySessionKeys(projectId: string): string[] {
  if (typeof localStorage === "undefined") return [];
  const prefix = currentRecoverySessionKeyPrefix(projectId);
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

function rewriteRecoverySnapshotIfPresent(projectId: string) {
  if (typeof localStorage === "undefined") return;
  try {
    if (currentRecoverySessionKeys(projectId).length > 0) {
      writeRecoverySnapshot();
    }
  } catch {
    // Best effort only.
  }
}

function clearRecoverySnapshot(
  projectId: string,
  savedAt = Number.POSITIVE_INFINITY,
) {
  if (typeof localStorage === "undefined") return;
  try {
    for (const key of currentRecoverySessionKeys(projectId)) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const recovery = parseRecoveryEnvelope(raw, projectId);
      if (recovery && recovery.project.updatedAt > savedAt) continue;
      // The key is immutable. Even if its owning code publishes a successor
      // concurrently, that successor has a different key and survives.
      localStorage.removeItem(key);
    }
  } catch {
    // Best effort only.
  }
}

function removeRecoveryEntry(key: string, allowMutable = false) {
  if (
    typeof localStorage === "undefined" ||
    (!allowMutable && !isImmutableRecoverySnapshotKey(key))
  ) {
    // Mutable session keys from older builds cannot be deleted safely while
    // an old live tab may still rewrite them. Retain those legacy roots; all newly
    // published entries are immutable and can be removed by exact key.
    return;
  }
  try {
    localStorage.removeItem(key);
  } catch {
    // Best effort only.
  }
}

function retirePreparedRecoveryEntryAfterExclusiveDelete(
  projectId: string,
  entry: RecoveryEntry,
  canRetireMutable: boolean,
) {
  if (isImmutableRecoverySnapshotKey(entry.key)) {
    removeRecoveryEntry(entry.key);
    return;
  }

  // The immutable conflict backup created before deletion now owns this exact
  // snapshot. A retirement marker suppresses duplicate recovery if the old
  // mutable key cannot be removed.
  retireHandledRecoveryEntry(projectId, entry);
  if (
    !canRetireMutable ||
    entry.serialized === null ||
    entry.key === LEGACY_RECOVERY_SNAPSHOT_KEY
  ) {
    // The one global legacy key is not protected by a per-project session
    // lock. Another project/tab may replace it at any point, so retain both
    // its exact-value marker and the source key.
    return;
  }
  const projectKey = legacyProjectRecoveryKey(projectId);
  if (entry.key !== projectKey && !entry.key.startsWith(`${projectKey}:`)) {
    return;
  }
  // The caller owns this project's exclusive lifetime session lock. Compare
  // the captured value so a pre-lock successor is retained; cooperating tabs
  // cannot rewrite it between this check and removal.
  if (localStorage.getItem(entry.key) !== entry.serialized) return;
  localStorage.removeItem(entry.key);
  if (localStorage.getItem(entry.key) !== null) {
    throw new Error("A prepared recovery journal could not be retired.");
  }
}

function projectsRepresentSameSnapshot(
  current: PersistedProject,
  pending: PersistedProject,
) {
  return (
    current.id === pending.id &&
    current.name === pending.name &&
    current.bpm === pending.bpm &&
    JSON.stringify(current.timeSignature ?? null) ===
      JSON.stringify(pending.timeSignature ?? null) &&
    JSON.stringify(current.tracks) === JSON.stringify(pending.tracks) &&
    (current.latencyOffsetMs ?? 0) === (pending.latencyOffsetMs ?? 0) &&
    (current.countInBeats ?? 0) === (pending.countInBeats ?? 0)
  );
}

interface PreservedRecoveryConflict {
  warning: string;
  recoveredProjectId: string | null;
  preserved: boolean;
}

async function preserveRecoveryConflict(
  recovery: RecoveryEnvelope,
  currentUpdatedAt: number | null,
): Promise<PreservedRecoveryConflict> {
  const recoveredProjectId = makeId();
  const recoveredName = `${recovery.project.name} (Recovered ${new Date()
    .toISOString()
    .slice(0, 16)
    .replace("T", " ")})`;
  try {
    await materializeRecoveryProject(
      recovery.project,
      recoveredProjectId,
      recoveredName,
    );
    await clearPendingAudioForProject(recovery.project).catch(() => {});
    return {
      recoveredProjectId,
      preserved: true,
      warning: `Pending changes conflicted with another tab, so they were saved as “${recoveredName}” in the project library.`,
    };
  } catch {
    // If quota or a missing referenced blob prevents a full project copy,
    // retain a versioned metadata backup that the user can download from the
    // project menu. Never overwrite an earlier conflict branch.
  }

  if (typeof localStorage !== "undefined") {
    try {
      const backupKey = recoveryConflictKey(recovery.project.id);
      localStorage.setItem(
        backupKey,
        JSON.stringify({
          ...recovery,
          currentUpdatedAt,
          conflictedAt: Date.now(),
        }),
      );
      return {
        recoveredProjectId: null,
        preserved: true,
        warning:
          "Pending changes conflicted with another tab. Their metadata was preserved as a downloadable recovery backup in the project menu.",
      };
    } catch {
      // Leave the active journal intact if the conflict backup cannot be made.
    }
  }

  return {
    recoveredProjectId: null,
    preserved: false,
    warning:
      "Pending changes conflicted with another tab and could not be copied. Keep this tab open and free storage before retrying.",
  };
}

async function recoverProjectSnapshot(projectId: string): Promise<string | null> {
  const entries = readRecoverySnapshots(projectId);
  const inMemoryDirty = dirtyPersistSnapshot;
  if (inMemoryDirty?.state.currentProjectId === projectId) {
    const project = buildPersisted(inMemoryDirty.state);
    project.updatedAt = inMemoryDirty.changedAt;
    const inMemoryEnvelope: RecoveryEnvelope = {
      version: 3,
      project,
      acceptableBaseUpdatedAts: [
        ...inMemoryDirty.acceptableBaseUpdatedAts,
      ],
    };
    // The latest in-memory full-state snapshot supersedes any older journal
    // generations from this document. Process it once as a synthetic immutable
    // entry; the real session keys are only cleared after identity-safe async
    // promotion below.
    for (let index = entries.length - 1; index >= 0; index--) {
      if (isCurrentRecoverySessionKey(projectId, entries[index].key)) {
        entries.splice(index, 1);
      }
    }
    entries.push({
      key: `${currentRecoverySessionKeyPrefix(projectId)}memory:${inMemoryDirty.generation.toString(36)}`,
      envelope: inMemoryEnvelope,
      serialized: null,
    });
    entries.sort(
      (a, b) =>
        b.envelope.project.updatedAt - a.envelope.project.updatedAt ||
        a.key.localeCompare(b.key),
    );
  }
  if (entries.length === 0) return null;
  const warnings = new Set<string>();
  let ownEntryHandled = false;
  let ownPromotedRevision: number | undefined;

  for (const entry of entries) {
    const recovery = entry.envelope;
    const isOwnEntry = isCurrentRecoverySessionKey(projectId, entry.key);
    const existing = await loadProject(projectId);
    const currentUpdatedAt = existing?.updatedAt ?? null;

    // A journal whose full semantic snapshot is already stored is redundant
    // regardless of timestamp. Requiring revision equality would make two
    // opening tabs duplicate the same journal after one legitimately advances
    // its CAS token.
    if (existing && projectsRepresentSameSnapshot(existing, recovery.project)) {
      await clearPendingAudioForProject(recovery.project).catch(() => {});
      if (isOwnEntry) {
        ownEntryHandled = true;
        ownPromotedRevision = currentUpdatedAt ?? undefined;
      } else {
        retireHandledRecoveryEntry(projectId, entry);
      }
      continue;
    }

    // Compare lineage before timestamps. A divergent stale-tab snapshot is a
    // real branch even when its wall-clock edit time is older than the current
    // save, and must be preserved instead of silently deleted.
    const baseMatches = recovery.acceptableBaseUpdatedAts.some(
      (revision) => revision === currentUpdatedAt,
    );
    if (!baseMatches) {
      const preserved = await preserveRecoveryConflict(
        recovery,
        currentUpdatedAt,
      );
      warnings.add(preserved.warning);
      if (preserved.preserved) {
        if (isOwnEntry) ownEntryHandled = true;
        else retireHandledRecoveryEntry(projectId, entry);
      }
      continue;
    }

    recovery.project.createdAt =
      existing?.createdAt ?? recovery.project.createdAt ?? Date.now();
    // Clock changes must not move the stored CAS token backwards.
    recovery.project.updatedAt = Math.max(
      recovery.project.updatedAt,
      (currentUpdatedAt ?? 0) + 1,
      Date.now(),
    );
    const result = await saveProjectIfRevision(
      recovery.project,
      currentUpdatedAt,
    );
    if (result.status === "conflict") {
      // Another opener may have promoted this exact journal after our read but
      // before our CAS. Reload before branching: an identical current snapshot
      // means the journal was consumed, not that it diverged.
      const latest = await loadProject(projectId);
      if (
        latest &&
        projectsRepresentSameSnapshot(latest, recovery.project)
      ) {
        lastDirtyAt = Math.max(lastDirtyAt, latest.updatedAt);
        await clearPendingAudioForProject(recovery.project).catch(() => {});
        if (isOwnEntry) {
          ownEntryHandled = true;
          ownPromotedRevision = latest.updatedAt;
        } else {
          retireHandledRecoveryEntry(projectId, entry);
        }
        continue;
      }
      const preserved = await preserveRecoveryConflict(
        recovery,
        result.currentUpdatedAt,
      );
      warnings.add(preserved.warning);
      if (preserved.preserved) {
        if (isOwnEntry) ownEntryHandled = true;
        else retireHandledRecoveryEntry(projectId, entry);
      }
      continue;
    }
    lastDirtyAt = Math.max(lastDirtyAt, result.project.updatedAt);
    await clearPendingAudioForProject(result.project).catch(() => {});
    if (isOwnEntry) {
      ownEntryHandled = true;
      ownPromotedRevision = result.project.updatedAt;
    } else {
      retireHandledRecoveryEntry(projectId, entry);
    }
  }

  // Retry runs in the same document after an autosave failure. Once this
  // tab's journal has been promoted or preserved as a branch, discard its
  // in-memory twin so a later pagehide cannot recreate the obsolete journal.
  if (ownEntryHandled && dirtyPersistSnapshot === inMemoryDirty) {
    cancelQueuedPersist();
    dirtyPersistSnapshot = null;
    clearRecoverySnapshot(projectId);
  } else if (
    ownPromotedRevision !== undefined &&
    dirtyPersistSnapshot?.state.currentProjectId === projectId
  ) {
    // A newer edit landed while Retry was promoting the captured generation.
    // Keep it queued, but advance its safe predecessor to the revision that
    // now contains the handled snapshot.
    persistedProjectRevisions.set(projectId, ownPromotedRevision);
    addAcceptableBaseRevision(
      dirtyPersistSnapshot,
      ownPromotedRevision,
    );
    rewriteRecoverySnapshotIfPresent(projectId);
  } else if (
    ownEntryHandled &&
    dirtyPersistSnapshot?.state.currentProjectId === projectId
  ) {
    // The captured local branch was copied aside, but a still-newer edit is a
    // descendant of that local branch—not of the other tab's authoritative
    // revision. Keep its original lineage and make Retry preserve it as a new
    // branch instead of allowing its stale queued CAS to overwrite anything.
    cancelQueuedPersist();
    if (!writeRecoverySnapshot()) {
      warnings.add(
        "Newer pending changes remain only in this tab because browser recovery storage is unavailable. Keep it open and Retry.",
      );
    }
  }

  return warnings.size > 0 ? [...warnings].join(" ") : null;
}

function addAcceptableBaseRevision(
  dirty: DirtyPersistSnapshot,
  revision: number | null,
) {
  if (
    !dirty.acceptableBaseUpdatedAts.some(
      (candidate) => candidate === revision,
    )
  ) {
    dirty.acceptableBaseUpdatedAts.push(revision);
  }
}

function reportPersistFailure(error: unknown) {
  const preserved = writeRecoverySnapshot();
  // A newer debounce may already be queued behind the failed flush. Its full
  // state is in the journal above; allowing the stale closure to run during
  // Retry would CAS against the pre-recovery revision and manufacture a false
  // cross-tab conflict.
  cancelQueuedPersist();
  const detail = error instanceof Error ? error.message : String(error);
  const recovery = preserved
    ? "Pending changes were preserved in this browser."
    : "Browser recovery storage was unavailable, so keep this tab open.";
  useCypher.setState({
    isLoaded: false,
    loadError: `Couldn't save this project. ${recovery} Retry to save again.${
      detail ? ` ${detail}` : ""
    }`,
  });
}

function schedulePersist(
  state: PersistInput,
  allowDuringProjectTransition = false,
) {
  if (projectTransitioning && !allowDuringProjectTransition) return;
  const generation = ++persistGeneration;
  const changedAt = Math.max(Date.now(), lastDirtyAt + 1);
  lastDirtyAt = changedAt;
  const dirty: DirtyPersistSnapshot = {
    generation,
    changedAt,
    acceptableBaseUpdatedAts: [
      persistedProjectRevisions.get(state.currentProjectId) ?? null,
    ],
    state,
  };
  dirtyPersistSnapshot = dirty;
  const scheduledEpoch = projectEpoch;
  const flush = async () => {
    if (
      scheduledEpoch !== projectEpoch ||
      state.currentProjectId !== useCypher.getState().currentProjectId
    ) return;
    const built = buildPersisted(state);
    built.updatedAt = changedAt;
    const expectedUpdatedAt = persistedProjectRevisions.get(built.id) ?? null;
    const pendingDirty = dirtyPersistSnapshot;
    if (
      pendingDirty &&
      pendingDirty.state.currentProjectId === built.id &&
      pendingDirty.generation >= generation
    ) {
      addAcceptableBaseRevision(pendingDirty, expectedUpdatedAt);
      // `built.updatedAt` is only a proposed CAS token until IndexedDB
      // confirms this write. Adding it here would let a recovery journal
      // mistake an unrelated same-millisecond revision from another tab for
      // its predecessor. The saved branch below adds the confirmed revision.
      rewriteRecoverySnapshotIfPresent(built.id);
    }

    let result: Awaited<ReturnType<typeof saveProjectIfRevision>>;
    try {
      result = await saveProjectIfRevision(built, expectedUpdatedAt);
    } catch (error) {
      if (
        scheduledEpoch === projectEpoch &&
        built.id === useCypher.getState().currentProjectId
      ) {
        reportPersistFailure(error);
      }
      throw error;
    }
    if (result.status === "conflict") {
      let message =
        result.currentUpdatedAt === null
          ? "This project was deleted in another tab. Retry to open the current project."
          : "This project changed in another tab. Retry to load the latest saved version.";
      if (
        scheduledEpoch === projectEpoch &&
        built.id === useCypher.getState().currentProjectId
      ) {
        // Do not leave a later stale debounce or unload journal queued behind
        // the conflict. Retry reloads the authoritative revision from IDB.
        const dirty = dirtyPersistSnapshot;
        cancelQueuedPersist();
        // Freeze the editor before the potentially slow branch copy. Store
        // actions can still race this await, so the generation check below is
        // the actual data-safety boundary rather than relying on the UI alone.
        useCypher.setState({ isLoaded: false, loadError: message });
        let pendingPreserved = true;
        if (dirty && dirty.state.currentProjectId === built.id) {
          const pendingProject = buildPersisted(dirty.state);
          pendingProject.updatedAt = dirty.changedAt;
          writeRecoverySnapshot();
          const preserved = await preserveRecoveryConflict(
            {
              version: 3,
              project: pendingProject,
              acceptableBaseUpdatedAts: [
                ...dirty.acceptableBaseUpdatedAts,
              ],
            },
            result.currentUpdatedAt,
          );
          pendingPreserved = preserved.preserved;
          message = `${message} ${preserved.warning}`;
        }
        if (pendingPreserved && dirtyPersistSnapshot === dirty) {
          // Only the exact generation copied above is now redundant. A newer
          // dirty object may have landed while materialization awaited IDB and
          // must never be discarded with its ancestor.
          dirtyPersistSnapshot = null;
          clearRecoverySnapshot(built.id);
        } else {
          // A newer generation descends from the captured local branch, not
          // from the other tab's authoritative revision. Cancel its stale CAS
          // closure and retain both its original lineage and full-state
          // journal so Retry preserves it as another branch.
          cancelQueuedPersist();
          if (
            dirtyPersistSnapshot?.state.currentProjectId === built.id
          ) {
            if (!writeRecoverySnapshot()) {
              message = `${message} Newer pending changes remain only in this tab because browser recovery storage is unavailable. Keep it open and Retry.`;
            }
          }
        }
        useCypher.setState({ isLoaded: false, loadError: message });
      }
      throw new Error(message);
    }
    persistedProjectRevisions.set(built.id, result.project.updatedAt);
    await clearPendingAudioForProject(result.project).catch(() => {});
    if (
      dirtyPersistSnapshot &&
      dirtyPersistSnapshot.generation > generation &&
      dirtyPersistSnapshot.state.currentProjectId === built.id
    ) {
      // A newer full-state snapshot contains this just-saved edit, so this
      // revision is now its safe predecessor if the tab closes mid-flush.
      addAcceptableBaseRevision(
        dirtyPersistSnapshot,
        result.project.updatedAt,
      );
      rewriteRecoverySnapshotIfPresent(built.id);
    }
    if (
      scheduledEpoch === projectEpoch &&
      built.id === useCypher.getState().currentProjectId
    ) {
      useCypher.setState({ lastSavedAt: result.project.updatedAt });
      if (dirtyPersistSnapshot?.generation === generation) {
        dirtyPersistSnapshot = null;
      }
      clearRecoverySnapshot(built.id, result.project.updatedAt);
    }
  };
  pendingFlush = flush;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const f = pendingFlush;
    pendingFlush = null;
    if (f) void runPersist(f).catch(() => {});
  }, 400);
}

async function flushPersist() {
  while (true) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const f = pendingFlush;
    pendingFlush = null;
    if (f) {
      await runPersist(f);
    } else if (persistInFlight) {
      await persistInFlight;
    }
    if (!saveTimer && !pendingFlush && !persistInFlight) return;
  }
}

function runPersist(flush: () => Promise<void>) {
  const previous = persistInFlight;
  const running = (previous ? previous.catch(() => {}) : Promise.resolve()).then(flush);
  persistInFlight = running;
  void running.finally(() => {
    if (persistInFlight === running) persistInFlight = null;
  }).catch(() => {});
  return running;
}

function cancelQueuedPersist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  pendingFlush = null;
}

function discardPendingPersist(clearJournal = true) {
  cancelQueuedPersist();
  const dirtyProjectId = dirtyPersistSnapshot?.state.currentProjectId;
  dirtyPersistSnapshot = null;
  if (clearJournal && dirtyProjectId) clearRecoverySnapshot(dirtyProjectId);
}

async function waitForPersistIdle() {
  while (persistInFlight) {
    const running = persistInFlight;
    await running.catch(() => {});
    if (persistInFlight === running) persistInFlight = null;
  }
}

// ---- Undo / redo ----

const MAX_HISTORY = 50;
// Same-action edits within this window are coalesced into a single history
// entry — dragging a volume slider would otherwise generate dozens of
// snapshots and force the user to undo dozens of times to back out one move.
const HISTORY_COALESCE_MS = 800;
let lastHistoryAction = "";
let lastHistoryTime = 0;
// Multiple calls can be queued programmatically before React disables the
// controls. Keep the editor inert until the whole Undo/Redo queue drains.
let historyApplicationCount = 0;

function captureHistorySnapshot(state: CypherState): HistorySnapshot {
  // TrackState is mostly primitives plus the pads array, which we deep-clone
  // so a snapshot can't be mutated by later pad edits.
  return {
    bpm: state.bpm,
    timeSignature: { ...state.timeSignature },
    tracks: state.tracks.map((t) => ({
      ...t,
      pads: t.pads.map((p) => ({ ...p })),
      samplerPattern: t.samplerPattern.map((event) => ({ ...event })),
    })),
  };
}

function pushHistory(state: CypherState, action: string) {
  // A normal edit splits an in-progress sampler overdub into a new semantic
  // history group. Otherwise a later hit could be removed together with an
  // unrelated volume/trim/etc. undo.
  if (action !== "samplerRecord") samplerHistoryProjectId = null;
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

function resetSamplerHistoryGrouping() {
  samplerHistoryProjectId = null;
  // A fresh transport/recording pass, or consuming a history entry, starts a
  // new sampler overdub action even if it happens inside the generic 800 ms
  // coalescing window.
  resetHistoryCoalesce();
}

function reconcileTransportAfterDurationChange() {
  const state = useCypher.getState();
  const duration = projectDuration(state.tracks);
  const canCapturePastEnd = hasSamplerCaptureSource(state.tracks);
  const position = getEngine().seconds();
  if (
    !canRunTransport(state.tracks) ||
    (!canCapturePastEnd && position >= duration)
  ) {
    getEngine().stop();
    useCypher.setState({ isPlaying: false, positionSec: 0 });
    return;
  }
  if (!state.isPlaying) {
    useCypher.setState({ positionSec: clampProjectTime(position, duration) });
  }
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

async function settleAudioRestores(promises: Promise<unknown>[]) {
  const results = await Promise.allSettled(promises);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
}

async function applyHistorySnapshot(
  snap: HistorySnapshot,
  project: ProjectIdentity,
  forceAudioReload = false,
) {
  // The caller holds withProjectOperation so snapshot application, project
  // transitions, and durable sampler commits cannot interleave.
  if (!isProjectIdentityCurrent(project)) return;
  const engine = getEngine();
  const resumePlayback = engine.isPlaying();
  const resumePosition = engine.seconds();
  engine.setBpm(snap.bpm);
  engine.setTimeSignature(snap.timeSignature);

  const currentTracks = useCypher.getState().tracks;
  const snapById = new Map(snap.tracks.map((t) => [t.id, t]));
  const currById = new Map(currentTracks.map((t) => [t.id, t]));

  // Reconcile against the actual graph, not only Zustand state. A previous
  // failed restore may have added a track before another blob failed, leaving
  // an engine-only ghost that the rollback snapshot must remove.
  for (const engineTrack of engine.getTracks()) {
    if (!snapById.has(engineTrack.id)) engine.removeTrack(engineTrack.id);
  }

  // Add and reload audio for all tracks in parallel — each track is keyed
  // by id and the final setState rebuilds the whole list, so order doesn't
  // matter.
  await settleAudioRestores(
    snap.tracks.map(async (snapT) => {
      if (!engine.getTrack(snapT.id)) {
        await engine.addTrack(snapT.id, snapT.name, snapT.kind);
      }
      const cur = currById.get(snapT.id);
      if (!snapT.audioKey) {
        engine.clearTrackAudio(snapT.id);
      } else if (forceAudioReload || cur?.audioKey !== snapT.audioKey) {
        const restored = await restoreTrackAudio(
          snapT.id,
          snapT.audioKey,
          snapT.fileName,
        );
        if (!restored) {
          throw new Error(`Audio for ${snapT.name} is unavailable`);
        }
      }
      if (snapT.kind === "sampler") {
        engine.clearAllPads(snapT.id);
        await settleAudioRestores(
          snapT.pads.map(async (p, i) => {
            if (!p.audioKey) return;
            const blob = await loadAudio(p.audioKey);
            if (!blob) {
              throw new Error(
                `Pad ${i + 1} audio for ${snapT.name} is unavailable`,
              );
            }
            const arr = await blob.arrayBuffer();
            try {
              const buf = await engine.context().decodeAudioData(arr.slice(0));
              engine.setPadBuffer(snapT.id, i, buf);
            } catch (error) {
              throw new Error(
                `Pad ${i + 1} audio for ${snapT.name} could not be decoded`,
                { cause: error },
              );
            }
          }),
        );
        engine.setSamplerPattern(snapT.id, snapT.samplerPattern);
      }
    }),
  );

  if (!isProjectIdentityCurrent(project)) return;

  for (const snapT of snap.tracks) {
    engine.setVolume(snapT.id, snapT.volume);
    engine.setPan(snapT.id, snapT.pan);
    if (snapT.audioKey) {
      engine.setTrim(snapT.id, snapT.trimInSec, snapT.trimOutSec);
    }
    engine.setNormalizationGain(
      snapT.id,
      snapT.normalized ? snapT.normalizationGain : 1,
    );
  }

  // Bump bufferRevision so the waveform re-reads from the engine.
  const revBase = Date.now();
  const liveTracksById = new Map(
    useCypher.getState().tracks.map((track) => [track.id, track]),
  );
  useCypher.setState({
    bpm: snap.bpm,
    timeSignature: { ...snap.timeSignature },
    tracks: snap.tracks.map((t, i) => {
      const liveTrack = liveTracksById.get(t.id);
      return {
        ...t,
        // Input routing and record-arm controls are intentionally not history
        // actions. Preserve their latest values when applying a project edit.
        inputDeviceId: liveTrack?.inputDeviceId ?? t.inputDeviceId,
        armed: liveTrack?.armed ?? t.armed,
        samplerRecArmed: liveTrack?.samplerRecArmed ?? t.samplerRecArmed,
        bufferRevision: revBase + i,
        pads: t.pads.map((p, j) => ({
          ...p,
          bufferRevision: revBase + i * 1000 + j,
        })),
      };
    }),
  });
  const restoredTracks = useCypher.getState().tracks;
  applyMixState(restoredTracks);
  if (resumePlayback) {
    const restoredDuration = projectDuration(restoredTracks);
    const samplerCaptureReady = hasSamplerCaptureSource(restoredTracks);
    if (
      !canRunTransport(restoredTracks) ||
      (!samplerCaptureReady && resumePosition >= restoredDuration)
    ) {
      engine.stop();
      useCypher.setState({ isPlaying: false, positionSec: 0 });
    } else {
      await engine.seek(resumePosition);
      useCypher.setState({ positionSec: resumePosition });
    }
  } else {
    reconcileTransportAfterDurationChange();
  }
  schedulePersist(useCypher.getState());
  // Undo/Redo is not finished until its metadata snapshot is durable. This
  // prevents an immediate reload from observing an older pattern revision.
  await flushPersist();
}

function gcOrphanedAudio() {
  // Deliberately retain replacement/history blobs until their project is
  // deleted. A tab cannot see another tab's in-memory pendingAudioKeys, so an
  // automatic orphan sweep can race that tab between saveAudio() and its
  // metadata CAS and permanently delete live audio. Delete Project remains
  // the safe, transactional reclamation boundary.
}

// Build a list of MixTrack values for export. Pulls volume/pan/trim/normalization
// from the user-facing store state and the audio buffer from the engine.
function collectSamplerEvents(track: TrackState) {
  if (track.kind !== "sampler") return [];
  const engine = getEngine();
  return track.samplerPattern.flatMap((event) => {
    const buffer = engine.getPadBuffer(track.id, event.padIdx);
    return buffer ? [{ buffer, timeSec: event.timeSec }] : [];
  });
}

function collectMixTracks(opts: { includeMuted: boolean }): MixTrack[] {
  const engine = getEngine();
  const state = useCypher.getState();
  const anySoloed = state.tracks.some((track) => track.soloed);
  const out: MixTrack[] = [];
  for (const s of state.tracks) {
    if (!opts.includeMuted && !isTrackAudible(s, anySoloed)) continue;
    const e = engine.getTrack(s.id);
    const events = collectSamplerEvents(s);
    if (!e?.buffer && events.length === 0) continue;
    out.push({
      buffer: e?.buffer ?? null,
      events,
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
    const events = collectSamplerEvents(s);
    if (!e?.buffer && events.length === 0) continue;
    stems.push({
      name: s.name,
      track: {
        buffer: e?.buffer ?? null,
        events,
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
  installProjectCoordinationChannel();
  const flush = () => {
    // Browsers do not wait for asynchronous IndexedDB work during unload.
    // Journal the small metadata snapshot synchronously; startup promotes it
    // back into IndexedDB if the async flush was interrupted.
    writeRecoverySnapshot();
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

function projectLoadError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail
    ? `Couldn't restore this project. ${detail}`
    : "Couldn't restore this project.";
}

async function loadProjectIntoEngine(
  id: string,
  set: Setter,
  createIfMissing = false,
) {
  await holdProjectSessionLease(id);
  try {
    await withProjectOperation(() =>
      loadProjectIntoEngineUnlocked(id, set, createIfMissing),
    );
  } catch (error) {
    if (useCypher.getState().currentProjectId !== id) {
      await releaseProjectSessionLease(id);
    }
    throw error;
  }
}

async function loadProjectIntoEngineUnlocked(
  id: string,
  set: Setter,
  createIfMissing = false,
) {
  const engine = getEngine();
  set({ isLoaded: false, loadError: null });
  let transition: number | null = null;
  try {
    await flushPersist();
    transition = beginProjectTransition();
    await holdProjectSessionLease(id);
    engine.clearAllTracks();
    trackCounter = 0;

    const persisted = await loadProject(id);
    if (!persisted) {
      if (createIfMissing) {
        // First launch: create the default project with no surprise tracks.
        await switchToProjectUnlocked(id, "Untitled", false, set);
        return;
      }
      throw new Error(
        "This project was deleted in another tab. Return to the library and choose another project.",
      );
    }
    persistedProjectRevisions.set(id, persisted.updatedAt ?? null);
    lastDirtyAt = Math.max(lastDirtyAt, persisted.updatedAt ?? 0);

    await engine.start();
    engine.setBpm(persisted.bpm);
    const timeSignature = sanitizeTimeSignature(persisted.timeSignature);
    engine.setTimeSignature(timeSignature);
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
      const samplerPattern =
        kind === "sampler"
          ? (pt.samplerPattern ?? []).flatMap((event) => {
              const safeEvent = sanitizeSamplerEvent(
                event,
                SAMPLER_PAD_COUNT,
              );
              return safeEvent ? [safeEvent] : [];
            })
          : [];
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
        samplerPattern,
      });
      if (
        hasAudio &&
        pt.normalized &&
        pt.normalizationGain &&
        pt.normalizationGain !== 1
      ) {
        engine.setNormalizationGain(pt.id, pt.normalizationGain);
      }
    }
    await setCurrentProjectId(id);
    if (transition !== projectEpoch) return;
    await holdProjectSessionLease(id);
    await releaseOtherProjectSessionLeases(id);
    set({
      tracks: restored,
      bpm: persisted.bpm,
      timeSignature,
      currentProjectId: id,
      currentProjectName: persisted.name,
      latencyOffsetMs: persisted.latencyOffsetMs ?? 0,
      countInBeats: persisted.countInBeats ?? 0,
      positionSec: 0,
      countdownActive: false,
      countdownBeat: 0,
      isCalibrating: false,
      exportProgress: null,
      isPlaying: false,
      isMultiRecording: false,
      recordingTrackId: null,
      lastSavedAt: persisted.updatedAt ?? null,
      isLoaded: true,
      loadError: null,
      undoStack: [],
      redoStack: [],
    });
    completeProjectTransition(transition);
    resetHistoryCoalesce();
    applyMixState(restored);
    void gcOrphanedAudio();
  } catch (error) {
    if (transition === null || transition === projectEpoch) {
      set({ isLoaded: false, loadError: projectLoadError(error) });
    }
    throw error;
  } finally {
    if (transition !== null) completeProjectTransition(transition);
  }
}

async function switchToProjectUnlocked(
  id: string,
  name: string,
  withInitialTracks: boolean,
  set: Setter,
) {
  const engine = getEngine();
  set({ isLoaded: false, loadError: null });
  let transition: number | null = null;
  try {
    await flushPersist();
    transition = beginProjectTransition();
    await holdProjectSessionLease(id);
    engine.clearAllTracks();
    trackCounter = 0;
    await engine.start();
    engine.setBpm(120);
    engine.setTimeSignature(DEFAULT_TIME_SIGNATURE);

    const tracks: TrackState[] = [];
    if (withInitialTracks) {
      const a = nextId();
      const b = nextId();
      await engine.addTrack(a, "Track 1");
      await engine.addTrack(b, "Track 2");
      tracks.push(emptyTrack(a, "Track 1"), emptyTrack(b, "Track 2"));
    }
    const initialProject = buildPersisted({
      currentProjectId: id,
      currentProjectName: name,
      tracks,
      bpm: 120,
      timeSignature: { ...DEFAULT_TIME_SIGNATURE },
      latencyOffsetMs: 0,
      countInBeats: 0,
    });
    const createdProject = await createProjectAndSetCurrent(initialProject);
    if (transition !== projectEpoch) return;
    await releaseOtherProjectSessionLeases(id);
    persistedProjectRevisions.set(id, createdProject.updatedAt);
    lastDirtyAt = Math.max(lastDirtyAt, createdProject.updatedAt);
    set({
      tracks,
      bpm: 120,
      timeSignature: { ...DEFAULT_TIME_SIGNATURE },
      currentProjectId: id,
      currentProjectName: name,
      latencyOffsetMs: 0,
      countInBeats: 0,
      positionSec: 0,
      countdownActive: false,
      countdownBeat: 0,
      isCalibrating: false,
      exportProgress: null,
      isPlaying: false,
      isMultiRecording: false,
      recordingTrackId: null,
      lastSavedAt: createdProject.updatedAt,
      isLoaded: true,
      loadError: null,
      undoStack: [],
      redoStack: [],
    });
    completeProjectTransition(transition);
    resetHistoryCoalesce();
  } catch (error) {
    if (transition === null || transition === projectEpoch) {
      set({ isLoaded: false, loadError: projectLoadError(error) });
    }
    throw error;
  } finally {
    if (transition !== null) completeProjectTransition(transition);
  }
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
  const beatMs = 500;
  const beats = 4;
  const totalSec = (beats * beatMs) / 1000 + 0.5;

  let stream: MediaStream | null = null;
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
    const recording = await captureViaMediaRecorder(stream, totalSec, ctx);
    const recorderSamples = recording.samples;
    const recordingSampleRate = recording.sampleRate;
    // Detect click peaks in recorded audio.
    const sampleClickWindow = Math.floor(0.06 * recordingSampleRate);
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
          i + Math.floor(0.02 * recordingSampleRate),
        );
        for (let j = i + 1; j < windowEnd; j++) {
          if (Math.abs(recorderSamples[j]) > bestVal) {
            bestVal = Math.abs(recorderSamples[j]);
            bestIdx = j;
          }
        }
        peaks.push(bestIdx / recordingSampleRate);
        i = bestIdx + sampleClickWindow;
      } else {
        i++;
      }
    }
    if (peaks.length < 2) return null;
    // Average each acoustic peak against the click's actual position relative
    // to MediaRecorder start. The clicks are intentionally scheduled 200 ms in
    // the future; treating the first click as t=0 biases every result by that
    // full lead-in.
    let totalDelayMs = 0;
    let count = 0;
    for (let i = 0; i < Math.min(peaks.length, clickTimes.length); i++) {
      const expected = clickTimes[i] - recording.startedAt;
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
  clock: AudioContext,
): Promise<{ samples: Float32Array; sampleRate: number; startedAt: number }> {
  const types = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/aac",
  ];
  const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
  const rec = new MediaRecorder(
    stream,
    mime ? { mimeType: mime } : undefined,
  );
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data?.size > 0) chunks.push(e.data);
  };
  const startedAt = clock.currentTime;
  // As in the main recording path, avoid timeslices: concatenated MP4
  // fragments are not reliably decodable on Safari.
  rec.start();
  await new Promise((r) => setTimeout(r, durationSec * 1000));
  await new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
    rec.stop();
  });
  const blob = new Blob(chunks, { type: rec.mimeType || mime });
  const ctx = new AudioContext();
  try {
    const arr = await blob.arrayBuffer();
    const buf = await ctx.decodeAudioData(arr);
    return {
      samples: new Float32Array(buf.getChannelData(0)),
      sampleRate: buf.sampleRate,
      startedAt,
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function runCountIn(
  beats: number,
  bpm: number,
  timeSignature: TimeSignature,
  finalStartOffsetSec: number,
  project: ProjectIdentity,
  set: Setter,
  signal: AbortSignal,
): Promise<boolean> {
  const engine = getEngine();
  await engine.start();
  if (
    signal.aborted ||
    countInCancelled ||
    !isProjectIdentityCurrent(project)
  ) {
    return false;
  }
  const beatMs = signaturePulseMs(bpm, timeSignature);
  for (let i = 0; i < beats; i++) {
    if (
      signal.aborted ||
      countInCancelled ||
      !isProjectIdentityCurrent(project)
    ) {
      if (!isProjectIdentityCurrent(project)) return false;
      set({ countdownActive: false, countdownBeat: 0 });
      return false;
    }
    set({ countdownActive: true, countdownBeat: i + 1 });
    engine.tickClick(isSignatureAccent(i, timeSignature));
    const finalLeadMs = finalStartOffsetSec * 1000;
    const waitMs = i === beats - 1 ? Math.max(0, beatMs - finalLeadMs) : beatMs;
    if (!(await abortableDelay(waitMs, signal))) {
      set({ countdownActive: false, countdownBeat: 0 });
      return false;
    }
  }
  if (
    signal.aborted ||
    countInCancelled ||
    !isProjectIdentityCurrent(project)
  ) {
    if (!isProjectIdentityCurrent(project)) return false;
    set({ countdownActive: false, countdownBeat: 0 });
    return false;
  }
  set({ countdownActive: false, countdownBeat: 0 });
  return true;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
    engine.setMute(t.id, !isTrackAudible(t, anySoloed));
  }
}

function isTrackAudible(track: TrackState, anySoloed: boolean) {
  return !track.muted && (!anySoloed || track.soloed);
}
