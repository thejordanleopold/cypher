/* global self */

const TEMP_DIRECTORY = "cypher-recording-temp";
const TEMP_FILE_PREFIX = "pcm-";
const STALE_FILE_AGE_MS = 24 * 60 * 60 * 1000;

let storageMode = "memory";
let directory = null;
let fileName = null;
let accessHandle = null;
let writeOffset = 0;
let totalLength = 0;
let channelCount = 0;
let records = [];
let memoryChunks = [];
let operation = Promise.resolve();
let resolveSegmentAck = null;

self.onmessage = (event) => {
  if (event.data?.type === "segment-ack") {
    resolveSegmentAck?.();
    resolveSegmentAck = null;
    return;
  }
  operation = operation
    .then(() => handleMessage(event.data))
    .catch(async (error) => {
      self.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      await cleanup();
      self.close();
    });
};

async function handleMessage(message) {
  if (message?.type === "init") {
    await initialize(message.captureId);
  } else if (message?.type === "chunk") {
    await storeChunk(message.channels);
  } else if (message?.type === "finish") {
    await finish();
  } else if (message?.type === "abort") {
    await cleanup();
    self.postMessage({ type: "aborted" });
    self.close();
  }
}

async function initialize(captureId) {
  try {
    if (!navigator.storage?.getDirectory) throw new Error("OPFS unavailable");
    const root = await navigator.storage.getDirectory();
    directory = await root.getDirectoryHandle(TEMP_DIRECTORY, { create: true });
    await removeStaleFiles(directory);
    fileName = `${TEMP_FILE_PREFIX}${captureId}.raw`;
    const file = await directory.getFileHandle(fileName, { create: true });
    if (typeof file.createSyncAccessHandle !== "function") {
      throw new Error("Synchronous OPFS access unavailable");
    }
    accessHandle = await file.createSyncAccessHandle();
    accessHandle.truncate(0);
    storageMode = "opfs";
  } catch {
    await closeAndRemoveFile();
    storageMode = "memory";
  }
  self.postMessage({ type: "ready", storage: storageMode });
}

async function removeStaleFiles(tempDirectory) {
  try {
    for await (const [name, handle] of tempDirectory.entries()) {
      if (!name.startsWith(TEMP_FILE_PREFIX) || handle.kind !== "file") continue;
      const file = await handle.getFile();
      if (Date.now() - file.lastModified > STALE_FILE_AGE_MS) {
        await tempDirectory.removeEntry(name);
      }
    }
  } catch {
    // Cleanup is best-effort and must never block a new recording.
  }
}

async function storeChunk(channels) {
  if (!Array.isArray(channels) || channels.length === 0) return;
  const length = channels[0].byteLength / Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isInteger(length) || length <= 0) return;
  totalLength += length;
  channelCount = Math.max(channelCount, channels.length);

  if (storageMode === "opfs" && accessHandle) {
    try {
      const record = { offsets: [], byteLengths: [], length };
      for (const channel of channels) {
        const bytes = new Uint8Array(channel);
        const offset = writeOffset;
        const written = accessHandle.write(bytes, { at: offset });
        if (written !== bytes.byteLength) {
          throw new Error("PCM temporary storage write was incomplete");
        }
        record.offsets.push(offset);
        record.byteLengths.push(bytes.byteLength);
        writeOffset += bytes.byteLength;
      }
      records.push(record);
      return;
    } catch {
      await fallBackToMemory();
    }
  }
  memoryChunks.push({ channels, length });
}

async function fallBackToMemory() {
  if (accessHandle) {
    for (const record of records) {
      memoryChunks.push({
        channels: readRecord(record),
        length: record.length,
      });
    }
  }
  records = [];
  await closeAndRemoveFile();
  storageMode = "memory";
  self.postMessage({ type: "storage", storage: "memory" });
}

function readRecord(record) {
  if (!accessHandle) throw new Error("PCM temporary storage is closed");
  return record.offsets.map((offset, index) => {
    const buffer = new ArrayBuffer(record.byteLengths[index]);
    const bytes = new Uint8Array(buffer);
    const read = accessHandle.read(bytes, { at: offset });
    if (read !== bytes.byteLength) {
      throw new Error("PCM temporary storage read was incomplete");
    }
    return buffer;
  });
}

async function finish() {
  accessHandle?.flush();
  self.postMessage({ type: "metadata", length: totalLength, channelCount });
  let offset = 0;
  if (storageMode === "opfs") {
    for (const record of records) {
      const channels = readRecord(record);
      await sendSegment(offset, channels);
      offset += record.length;
    }
  } else {
    for (const chunk of memoryChunks) {
      await sendSegment(offset, chunk.channels);
      offset += chunk.length;
    }
  }
  await cleanup();
  self.postMessage({ type: "done" });
  self.close();
}

function sendSegment(offset, channels) {
  return new Promise((resolve) => {
    resolveSegmentAck = resolve;
    self.postMessage({ type: "segment", offset, channels }, channels);
  });
}

async function cleanup() {
  records = [];
  memoryChunks = [];
  await closeAndRemoveFile();
}

async function closeAndRemoveFile() {
  try {
    accessHandle?.close();
  } catch {
    // ignore a handle already closed by the browser
  }
  accessHandle = null;
  if (directory && fileName) {
    try {
      await directory.removeEntry(fileName);
    } catch {
      // best-effort cleanup; stale files are reaped by a later recording
    }
  }
  fileName = null;
}
