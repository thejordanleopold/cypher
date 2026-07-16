import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "cypher";
const DB_VERSION = 2;
const PROJECT_STORE = "projects";
const AUDIO_STORE = "audio";
const META_STORE = "meta";
const PENDING_AUDIO_META_PREFIX = "pending-audio:";

export interface PersistedSamplerPad {
  audioKey: string | null;
  fileName: string | null;
  durationSec: number;
}

export interface PersistedSamplerEvent {
  padIdx: number;
  timeSec: number;
}

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
  // "audio" (default for legacy projects) or "sampler" (drum-pad track).
  kind?: "audio" | "sampler";
  // Indexed by pad slot (0..N-1). Slots without a sample carry a null audioKey
  // but are still emitted so pad order is stable across saves.
  pads?: PersistedSamplerPad[];
  // Recorded one-shot events on the project timeline.
  samplerPattern?: PersistedSamplerEvent[];
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
  timeSignature?: {
    numerator: number;
    denominator: number;
  };
}

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  trackCount: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

export class ProjectDatabaseBlockedError extends Error {
  constructor(oldVersion: number, newVersion: number | null) {
    const target = newVersion === null ? "a newer version" : `version ${newVersion}`;
    super(
      `Cypher storage could not upgrade from version ${oldVersion} to ${target} because another Cypher tab is still open. Close other Cypher tabs, then retry.`,
    );
    this.name = "ProjectDatabaseBlockedError";
  }
}

function openProjectDatabase(): Promise<IDBPDatabase> {
  let opening!: Promise<IDBPDatabase>;
  let failed = false;

  const attempt = new Promise<IDBPDatabase>((resolve, reject) => {
    opening = openDB(DB_NAME, DB_VERSION, {
      blocked(oldVersion, newVersion) {
        failed = true;
        reject(new ProjectDatabaseBlockedError(oldVersion, newVersion));
      },
      blocking() {
        // Let a newer Cypher build upgrade immediately instead of leaving its
        // startup request pending behind this tab's cached connection.
        void opening.then((db) => db.close()).catch(() => {});
        if (dbPromise === attempt) dbPromise = null;
      },
      terminated() {
        // Browsers may terminate an IDB connection under storage pressure.
        // Reopen on the next operation rather than retaining a closed handle.
        if (dbPromise === attempt) dbPromise = null;
      },
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
    void opening.then(
      (db) => {
        // A request that reported `blocked` may still finish after the old tab
        // closes. This attempt already failed visibly, so do not leak its late
        // connection or let it compete with the user's Retry attempt.
        if (failed) db.close();
        else resolve(db);
      },
      reject,
    );
  });

  void attempt.catch(() => {
    if (dbPromise === attempt) dbPromise = null;
  });
  return attempt;
}

function getDb() {
  if (!dbPromise) {
    dbPromise = openProjectDatabase();
  }
  return dbPromise;
}

// ---- Projects ----

export async function saveProject(project: PersistedProject) {
  const db = await getDb();
  await db.put(PROJECT_STORE, project);
}

export type ProjectRevisionSaveResult =
  | { status: "saved"; project: PersistedProject }
  | { status: "conflict"; currentUpdatedAt: number | null };

/**
 * Atomically replace a project only when the stored revision is the one this
 * caller originally loaded. IndexedDB serializes read/write transactions on
 * this store across tabs, so a delayed stale autosave cannot pass the check
 * and overwrite a newer tab's complete project snapshot.
 */
export async function saveProjectIfRevision(
  project: PersistedProject,
  expectedUpdatedAt: number | null,
): Promise<ProjectRevisionSaveResult> {
  const db = await getDb();
  const tx = db.transaction(PROJECT_STORE, "readwrite");
  const store = tx.objectStore(PROJECT_STORE);
  const existing = (await store.get(project.id)) as PersistedProject | undefined;
  const currentUpdatedAt = existing?.updatedAt ?? null;
  if (currentUpdatedAt !== expectedUpdatedAt) {
    await tx.done;
    return { status: "conflict", currentUpdatedAt };
  }

  const existingCreatedAt = existing?.createdAt;
  const projectCreatedAt = project.createdAt;
  const stored: PersistedProject = {
    ...project,
    createdAt:
      typeof existingCreatedAt === "number" && existingCreatedAt > 0
        ? existingCreatedAt
        : typeof projectCreatedAt === "number" && projectCreatedAt > 0
          ? projectCreatedAt
          : Date.now(),
  };
  await store.put(stored);
  await tx.done;
  return { status: "saved", project: stored };
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

/**
 * Publish a newly-created project and make it current in one commit. Keeping
 * these writes in the same transaction prevents startup from observing a
 * current-project pointer whose project row was never durably created.
 */
export async function createProjectAndSetCurrent(
  project: PersistedProject,
): Promise<PersistedProject> {
  const db = await getDb();
  const tx = db.transaction([PROJECT_STORE, META_STORE], "readwrite");
  const projectStore = tx.objectStore(PROJECT_STORE);
  const existing = await projectStore.get(project.id);
  if (existing) {
    await tx.done;
    throw new Error("The new project id is already in use. Retry the operation.");
  }

  const now = Date.now();
  const stored: PersistedProject = {
    ...project,
    createdAt: project.createdAt > 0 ? project.createdAt : now,
    updatedAt: Math.max(project.updatedAt, now),
  };
  await Promise.all([
    projectStore.put(stored),
    tx.objectStore(META_STORE).put(stored.id, "currentProjectId"),
  ]);
  await tx.done;
  return stored;
}

export async function deleteProject(
  id: string,
  protectedRecoveryAudioKeys: readonly string[] = [],
): Promise<string | null> {
  const db = await getDb();
  // Delete metadata and every owned blob in one transaction. If quota,
  // termination, or another IndexedDB error interrupts the operation, the
  // project remains wholly intact instead of becoming a partial orphan. The
  // current-project pointer moves in that same commit, so a crash cannot leave
  // startup pointing at an id that was already deleted.
  const tx = db.transaction(
    [PROJECT_STORE, AUDIO_STORE, META_STORE],
    "readwrite",
  );
  const projectStore = tx.objectStore(PROJECT_STORE);
  const audioStore = tx.objectStore(AUDIO_STORE);
  const metaStore = tx.objectStore(META_STORE);
  const projects = (await projectStore.getAll()) as PersistedProject[];
  const fallback = projects
    .filter((project) => project.id !== id)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  const currentProjectId = (await metaStore.get("currentProjectId")) as
    | string
    | undefined;
  await projectStore.delete(id);
  const audioKeys = (await audioStore.getAllKeys()) as IDBValidKey[];
  const prefix = `audio:${id}:`;
  // Recovery journals and conflict backups deliberately outlive the
  // authoritative project. Keep their source blobs so the menu's Restore
  // action remains truthful after the user deletes the main branch.
  const protectedRecoveryAudio = new Set(
    protectedRecoveryAudioKeys.filter((key) => key.startsWith(prefix)),
  );
  const pendingPrefix = pendingAudioMetaPrefix(id);
  const pendingRange = IDBKeyRange.bound(pendingPrefix, `${pendingPrefix}￿`);
  const pendingMarkers = await metaStore.getAllKeys(pendingRange);
  await Promise.all(
    [
      ...audioKeys
        .filter(
          (key) =>
            typeof key === "string" &&
            key.startsWith(prefix) &&
            !protectedRecoveryAudio.has(key),
        )
        .map((key) => audioStore.delete(key)),
      ...pendingMarkers.map((key) => metaStore.delete(key)),
    ],
  );
  if (currentProjectId === id) {
    if (fallback) await metaStore.put(fallback.id, "currentProjectId");
    else await metaStore.delete("currentProjectId");
  }
  await tx.done;
  return fallback?.id ?? null;
}

/**
 * Reclaim source blobs after the last recovery journal/backup for a deleted
 * project is consumed. The authoritative-row check makes this a no-op for a
 * live project; callers supply the result of a strict recovery-root scan so a
 * remaining dormant version can never be swept.
 */
export async function cleanupDeletedProjectAudio(
  id: string,
  protectedRecoveryAudioKeys: readonly string[] = [],
): Promise<number> {
  const db = await getDb();
  const tx = db.transaction(
    [PROJECT_STORE, AUDIO_STORE, META_STORE],
    "readwrite",
  );
  const projectStore = tx.objectStore(PROJECT_STORE);
  const audioStore = tx.objectStore(AUDIO_STORE);
  const metaStore = tx.objectStore(META_STORE);
  const existing = await projectStore.get(id);
  if (existing) {
    await tx.done;
    return 0;
  }

  const prefix = audioKeyPrefix(id);
  const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
  const keys = (await audioStore.getAllKeys(range)).filter(
    (key): key is string => typeof key === "string",
  );
  const protectedAudio = new Set(
    protectedRecoveryAudioKeys.filter((key) => key.startsWith(prefix)),
  );
  const removable = keys.filter((key) => !protectedAudio.has(key));
  await Promise.all(
    removable.flatMap((key) => [
      audioStore.delete(key),
      metaStore.delete(pendingAudioMetaKey(key)),
    ]),
  );
  await tx.done;
  return removable.length;
}

type StoredAudio = ArrayBuffer | Blob;

interface ProjectCopyData {
  project: PersistedProject;
  audio: Array<{ key: string; data: ArrayBuffer }>;
}

function referencedAudioKeys(project: PersistedProject): string[] {
  const keys = new Set<string>();
  for (const track of project.tracks) {
    if (track.audioKey) keys.add(track.audioKey);
    for (const pad of track.pads ?? []) {
      if (pad.audioKey) keys.add(pad.audioKey);
    }
  }
  return [...keys];
}

function pendingAudioMetaKey(audioKey: string) {
  return `${PENDING_AUDIO_META_PREFIX}${audioKey}`;
}

function pendingAudioMetaPrefix(projectId: string) {
  return `${PENDING_AUDIO_META_PREFIX}${audioKeyPrefix(projectId)}`;
}

function missingAudioError(key: string): Error {
  return new Error(`Referenced audio is missing: ${key}`);
}

function assertStoredAudio(key: string, value: unknown): asserts value is StoredAudio {
  if (!(value instanceof ArrayBuffer) && !(value instanceof Blob)) {
    throw missingAudioError(key);
  }
}

async function normalizeStoredAudio(
  stored: Map<string, StoredAudio>,
): Promise<Map<string, ArrayBuffer>> {
  const normalized = new Map<string, ArrayBuffer>();
  for (const [key, value] of stored) {
    // Do this after the IndexedDB transaction completes. Awaiting
    // Blob.arrayBuffer() while a transaction is active can close it in WebKit.
    normalized.set(
      key,
      value instanceof ArrayBuffer ? value : await value.arrayBuffer(),
    );
  }
  return normalized;
}

async function readSnapshotAudio(
  project: PersistedProject,
): Promise<Map<string, ArrayBuffer>> {
  const db = await getDb();
  const tx = db.transaction(AUDIO_STORE, "readonly");
  const store = tx.objectStore(AUDIO_STORE);
  const keys = referencedAudioKeys(project);
  const values = await Promise.all(keys.map((key) => store.get(key)));
  await tx.done;

  const stored = new Map<string, StoredAudio>();
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const value = values[index];
    assertStoredAudio(key, value);
    stored.set(key, value);
  }
  return normalizeStoredAudio(stored);
}

async function readStoredProjectCopySource(
  sourceId: string,
  expectedSourceUpdatedAt?: number,
): Promise<{
  project: PersistedProject;
  audio: Map<string, ArrayBuffer>;
} | null> {
  const db = await getDb();
  // The metadata and every referenced blob come from the same IndexedDB
  // snapshot, so a concurrent delete cannot produce a partially silent copy.
  const tx = db.transaction([PROJECT_STORE, AUDIO_STORE], "readonly");
  const project = (await tx.objectStore(PROJECT_STORE).get(sourceId)) as
    | PersistedProject
    | undefined;
  if (!project) {
    await tx.done;
    return null;
  }

  const keys = referencedAudioKeys(project);
  const audioStore = tx.objectStore(AUDIO_STORE);
  const values = await Promise.all(keys.map((key) => audioStore.get(key)));
  await tx.done;

  if (
    expectedSourceUpdatedAt !== undefined &&
    project.updatedAt !== expectedSourceUpdatedAt
  ) {
    throw new Error(
      "The source project changed in another tab. Retry after loading the latest version.",
    );
  }

  const stored = new Map<string, StoredAudio>();
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const value = values[index];
    assertStoredAudio(key, value);
    stored.set(key, value);
  }
  return { project, audio: await normalizeStoredAudio(stored) };
}

function buildProjectCopy(
  source: PersistedProject,
  sourceAudio: Map<string, ArrayBuffer>,
  newId: string,
  newName: string,
  preserveCreatedAt = false,
): ProjectCopyData {
  if (!newId || newId === source.id) {
    throw new Error("A project copy requires a distinct, non-empty project id.");
  }

  const copiedAudio: Array<{ key: string; data: ArrayBuffer }> = [];
  const remappedKeys = new Map<string, string>();
  const remapAudioKey = (
    sourceKey: string,
    trackId: string,
    padIdx?: number,
  ): string => {
    const existing = remappedKeys.get(sourceKey);
    if (existing) return existing;
    const data = sourceAudio.get(sourceKey);
    if (!data) throw missingAudioError(sourceKey);
    const key =
      padIdx === undefined
        ? makeAudioKey(newId, trackId)
        : makePadAudioKey(newId, trackId, padIdx);
    remappedKeys.set(sourceKey, key);
    copiedAudio.push({ key, data });
    return key;
  };

  const tracks = source.tracks.map((track) => ({
    ...track,
    audioKey: track.audioKey
      ? remapAudioKey(track.audioKey, track.id)
      : null,
    pads: track.pads?.map((pad, padIdx) => ({
      ...pad,
      audioKey: pad.audioKey
        ? remapAudioKey(pad.audioKey, track.id, padIdx)
        : null,
    })),
  }));
  const now = Date.now();
  return {
    project: {
      ...source,
      id: newId,
      name: newName,
      tracks,
      createdAt: preserveCreatedAt ? source.createdAt : now,
      updatedAt: preserveCreatedAt
        ? Math.max(now, source.updatedAt + 1)
        : now,
    },
    audio: copiedAudio,
  };
}

async function commitProjectCopy(
  copy: ProjectCopyData,
  sourceRevision?: { id: string; updatedAt: number },
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction([PROJECT_STORE, AUDIO_STORE], "readwrite");
  const projectStore = tx.objectStore(PROJECT_STORE);
  const [existingTarget, currentSource] = await Promise.all([
    projectStore.get(copy.project.id),
    sourceRevision ? projectStore.get(sourceRevision.id) : undefined,
  ]);
  if (existingTarget) {
    await tx.done;
    throw new Error("The new project id is already in use. Retry the operation.");
  }
  if (
    sourceRevision &&
    (currentSource as PersistedProject | undefined)?.updatedAt !==
      sourceRevision.updatedAt
  ) {
    await tx.done;
    throw new Error(
      "The source project changed in another tab. Retry after loading the latest version.",
    );
  }

  const audioStore = tx.objectStore(AUDIO_STORE);
  await Promise.all([
    ...copy.audio.map(({ key, data }) => audioStore.put(data, key)),
    projectStore.put(copy.project),
  ]);
  await tx.done;
}

export async function duplicateProject(
  sourceId: string,
  newId: string,
  newName: string,
  expectedSourceUpdatedAt?: number,
): Promise<PersistedProject | null> {
  const source = await readStoredProjectCopySource(
    sourceId,
    expectedSourceUpdatedAt,
  );
  if (!source) return null;
  const copy = buildProjectCopy(source.project, source.audio, newId, newName);
  // Pin the source again in the commit transaction. This closes the small
  // window between the consistent read and the atomic target write.
  await commitProjectCopy(copy, {
    id: sourceId,
    updatedAt: source.project.updatedAt,
  });
  return copy.project;
}

/**
 * Preserve a recovery journal as an independent project. The caller supplies
 * a fresh identity and display name; the journal's exact referenced audio is
 * read consistently, remapped, and committed with the project in one atomic
 * transaction.
 */
export async function materializeRecoveryProject(
  snapshot: PersistedProject,
  newId: string,
  newName: string,
): Promise<PersistedProject> {
  const sourceAudio = await readSnapshotAudio(snapshot);
  const copy = buildProjectCopy(snapshot, sourceAudio, newId, newName);
  await commitProjectCopy(copy);
  return copy.project;
}

export interface ProjectCompactionResult {
  project: PersistedProject;
  removedAudioCount: number;
}

/**
 * Remove audio that is not referenced by the pinned project revision. Keeping
 * the same project id and live keys means another tab's recovery journal stays
 * discoverable. The caller also supplies keys referenced by recovery journals
 * and conflict backups so their dormant branches remain restorable.
 */
export async function compactProject(
  sourceId: string,
  expectedSourceUpdatedAt: number,
  protectedRecoveryAudioKeys: readonly string[] = [],
): Promise<ProjectCompactionResult> {
  const db = await getDb();
  const tx = db.transaction(
    [PROJECT_STORE, AUDIO_STORE, META_STORE],
    "readwrite",
  );
  const projectStore = tx.objectStore(PROJECT_STORE);
  const audioStore = tx.objectStore(AUDIO_STORE);
  const metaStore = tx.objectStore(META_STORE);
  const sourcePrefix = audioKeyPrefix(sourceId);
  const sourceRange = IDBKeyRange.bound(sourcePrefix, `${sourcePrefix}￿`);
  const pendingPrefix = pendingAudioMetaPrefix(sourceId);
  const pendingRange = IDBKeyRange.bound(pendingPrefix, `${pendingPrefix}￿`);
  const [currentSource, sourceAudioKeys, pendingAudioMarkers] = await Promise.all([
    projectStore.get(sourceId),
    audioStore.getAllKeys(sourceRange),
    metaStore.getAllKeys(pendingRange),
  ]);
  const source = currentSource as PersistedProject | undefined;

  if (source?.updatedAt !== expectedSourceUpdatedAt) {
    await tx.done;
    throw new Error(
      "The source project changed in another tab. Retry after loading the latest version.",
    );
  }

  const referenced = new Set(referencedAudioKeys(source));
  for (const key of protectedRecoveryAudioKeys) {
    if (key.startsWith(sourcePrefix)) referenced.add(key);
  }
  const orphanedKeys = sourceAudioKeys.filter(
    (key): key is string =>
      typeof key === "string" && !referenced.has(key),
  );
  const compacted: PersistedProject = {
    ...source,
    updatedAt: Math.max(Date.now(), source.updatedAt + 1),
  };
  await Promise.all([
    ...orphanedKeys.map((key) => audioStore.delete(key)),
    // The caller holds the project's exclusive live-session lock and supplied
    // every journal/backup reference. Any marker-only key is therefore a
    // renderer-crash remnant with no recoverable metadata; live and recovery
    // keys remain rooted above, and all now-reconciled markers can be cleared.
    ...pendingAudioMarkers.map((key) => metaStore.delete(key)),
    projectStore.put(compacted),
  ]);
  await tx.done;
  return { project: compacted, removedAudioCount: orphanedKeys.length };
}

// ---- Audio ----

export async function saveAudio(key: string, data: Blob | ArrayBuffer) {
  const db = await getDb();
  // Always store ArrayBuffer — Blob is not reliably cloneable by the structured
  // clone algorithm in Safari/WebKit, causing DataCloneError on IDB writes.
  const buf = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
  // The prepared-root marker and blob share a transaction. If metadata saving
  // and localStorage recovery both fail later, cross-tab compaction can still
  // see that this otherwise-orphan-looking key is the only copy of a take.
  const tx = db.transaction([AUDIO_STORE, META_STORE], "readwrite");
  await Promise.all([
    tx.objectStore(AUDIO_STORE).put(buf, key),
    tx.objectStore(META_STORE).put(Date.now(), pendingAudioMetaKey(key)),
  ]);
  await tx.done;
}

export async function loadAudio(key: string): Promise<Blob | undefined> {
  const db = await getDb();
  const stored = await db.get(AUDIO_STORE, key);
  if (!stored) return undefined;
  // New format: ArrayBuffer. Legacy format: Blob (from before this fix).
  if (stored instanceof ArrayBuffer) return new Blob([stored]);
  return stored as Blob;
}

export async function deleteAudio(key: string) {
  const db = await getDb();
  const tx = db.transaction([AUDIO_STORE, META_STORE], "readwrite");
  await Promise.all([
    tx.objectStore(AUDIO_STORE).delete(key),
    tx.objectStore(META_STORE).delete(pendingAudioMetaKey(key)),
  ]);
  await tx.done;
}

export async function clearPendingAudioForProject(
  project: PersistedProject,
) {
  const keys = referencedAudioKeys(project);
  if (keys.length === 0) return;
  const db = await getDb();
  const tx = db.transaction(META_STORE, "readwrite");
  const store = tx.objectStore(META_STORE);
  await Promise.all(keys.map((key) => store.delete(pendingAudioMetaKey(key))));
  await tx.done;
}

export function audioKeyPrefix(projectId: string): string {
  return `audio:${projectId}:`;
}

function freshAudioKeySuffix() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function makeAudioKey(projectId: string, trackId: string): string {
  return `${audioKeyPrefix(projectId)}${trackId}:${freshAudioKeySuffix()}`;
}

export function makePadAudioKey(
  projectId: string,
  trackId: string,
  padIdx: number,
): string {
  return `${audioKeyPrefix(projectId)}${trackId}:pad${padIdx}:${freshAudioKeySuffix()}`;
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
