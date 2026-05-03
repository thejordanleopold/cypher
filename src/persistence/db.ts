import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "cypher";
const DB_VERSION = 2;
const PROJECT_STORE = "projects";
const AUDIO_STORE = "audio";
const META_STORE = "meta";

export interface PersistedTrack {
  id: string;
  name: string;
  fileName: string | null;
  hasAudio: boolean;
  durationSec: number;
  volume: number;
  pan: number;
  muted: boolean;
  soloed: boolean;
  audioKey: string | null;
  trimInSec: number;
  trimOutSec: number | null;
  inputDeviceId?: string;
  inputGain?: number;
  armed?: boolean;
  normalized?: boolean;
  normalizationGain?: number;
  mode?: 'audio' | 'sampler';
  samplerPads?: Array<{
    id: string;
    startSec: number;
    endSec: number;
    label: string;
  }>;
}

export interface PersistedProject {
  id: string;
  name: string;
  bpm: number;
  tracks: PersistedTrack[];
  createdAt: number;
  updatedAt: number;
  latencyOffsetMs?: number;
  countInBeats?: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  trackCount: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (!db.objectStoreNames.contains(PROJECT_STORE)) {
          db.createObjectStore(PROJECT_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(AUDIO_STORE)) {
          db.createObjectStore(AUDIO_STORE);
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE);
        }
        // v1 → v2: backfill createdAt for any existing project that lacks it.
        if (oldVersion < 2 && db.objectStoreNames.contains(PROJECT_STORE)) {
          // Handled lazily on first read; nothing destructive needed here.
        }
      },
    });
  }
  return dbPromise;
}

// ---- Projects ----

export async function saveProject(project: PersistedProject) {
  const db = await getDb();
  await db.put(PROJECT_STORE, project);
}

export async function loadProject(id: string): Promise<PersistedProject | undefined> {
  const db = await getDb();
  const row = (await db.get(PROJECT_STORE, id)) as PersistedProject | undefined;
  if (!row) return undefined;
  // Backfill createdAt for projects saved under v1.
  if (typeof row.createdAt !== "number") row.createdAt = row.updatedAt ?? Date.now();
  return row;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const db = await getDb();
  const all = (await db.getAll(PROJECT_STORE)) as PersistedProject[];
  return all
    .map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt ?? p.updatedAt ?? 0,
      updatedAt: p.updatedAt ?? 0,
      trackCount: p.tracks?.length ?? 0,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(id: string) {
  const db = await getDb();
  // Delete project record and any audio keys belonging to it.
  await db.delete(PROJECT_STORE, id);
  const audioKeys = (await db.getAllKeys(AUDIO_STORE)) as IDBValidKey[];
  const prefix = `audio:${id}:`;
  for (const k of audioKeys) {
    if (typeof k === "string" && k.startsWith(prefix)) {
      await db.delete(AUDIO_STORE, k);
    }
  }
}

export async function duplicateProject(
  sourceId: string,
  newId: string,
  newName: string,
): Promise<PersistedProject | null> {
  const db = await getDb();
  const source = (await db.get(PROJECT_STORE, sourceId)) as
    | PersistedProject
    | undefined;
  if (!source) return null;

  const now = Date.now();
  // Copy each audio blob under a new key prefixed with the new project id.
  const newTracks: PersistedTrack[] = [];
  for (const t of source.tracks) {
    let newAudioKey: string | null = null;
    if (t.audioKey) {
      const blob = (await db.get(AUDIO_STORE, t.audioKey)) as Blob | undefined;
      if (blob) {
        newAudioKey = `audio:${newId}:${t.id}:${now}`;
        await db.put(AUDIO_STORE, blob, newAudioKey);
      }
    }
    newTracks.push({ ...t, audioKey: newAudioKey });
  }

  const copy: PersistedProject = {
    id: newId,
    name: newName,
    bpm: source.bpm,
    tracks: newTracks,
    createdAt: now,
    updatedAt: now,
  };
  await db.put(PROJECT_STORE, copy);
  return copy;
}

// ---- Audio ----

export async function saveAudio(key: string, blob: Blob) {
  const db = await getDb();
  await db.put(AUDIO_STORE, blob, key);
}

export async function loadAudio(key: string): Promise<Blob | undefined> {
  const db = await getDb();
  return db.get(AUDIO_STORE, key);
}

export async function deleteAudio(key: string) {
  const db = await getDb();
  await db.delete(AUDIO_STORE, key);
}

export function audioKeyPrefix(projectId: string): string {
  return `audio:${projectId}:`;
}

export function makeAudioKey(projectId: string, trackId: string): string {
  return `${audioKeyPrefix(projectId)}${trackId}:${Date.now()}`;
}

export async function listAudioKeysForProject(projectId: string): Promise<string[]> {
  const db = await getDb();
  const prefix = audioKeyPrefix(projectId);
  // Use a key range so IndexedDB does the prefix scan natively instead of
  // pulling every audio key for every project and filtering in JS.
  const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
  const keys = (await db.getAllKeys(AUDIO_STORE, range)) as IDBValidKey[];
  return keys.filter((k): k is string => typeof k === "string");
}

// ---- Meta ----

export async function getCurrentProjectId(): Promise<string | undefined> {
  const db = await getDb();
  return (await db.get(META_STORE, "currentProjectId")) as string | undefined;
}

export async function setCurrentProjectId(id: string) {
  const db = await getDb();
  await db.put(META_STORE, id, "currentProjectId");
}

export async function getOutputDeviceId(): Promise<string | undefined> {
  const db = await getDb();
  return (await db.get(META_STORE, "outputDeviceId")) as string | undefined;
}

export async function setOutputDeviceId(id: string) {
  const db = await getDb();
  await db.put(META_STORE, id, "outputDeviceId");
}

export async function getDefaultInputDeviceId(): Promise<string | undefined> {
  const db = await getDb();
  return (await db.get(META_STORE, "defaultInputDeviceId")) as
    | string
    | undefined;
}

export async function setDefaultInputDeviceId(id: string) {
  const db = await getDb();
  await db.put(META_STORE, id, "defaultInputDeviceId");
}

// ---- Storage estimate ----

export interface StorageEstimate {
  usageBytes: number;
  quotaBytes: number;
  percent: number;
}

export async function estimateStorage(): Promise<StorageEstimate | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  const usage = e.usage ?? 0;
  const quota = e.quota ?? 0;
  return {
    usageBytes: usage,
    quotaBytes: quota,
    percent: quota > 0 ? (usage / quota) * 100 : 0,
  };
}
