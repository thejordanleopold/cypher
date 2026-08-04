import { expect, test, type Page } from "@playwright/test";

async function waitForShell(page: Page) {
  const shell = page.getByRole("button", { name: /Start Demo|Exit Demo/ });
  const resume = page.getByRole("button", { name: "Resume Session" });
  await expect(shell.or(resume)).toBeVisible({ timeout: 10_000 });
  if (await resume.isVisible().catch(() => false)) await resume.click();
  await expect(shell).toBeVisible();
}

type StoredProject = {
  id: string;
  name: string;
  bpm: number;
  tracks: unknown[];
  createdAt: number;
  updatedAt: number;
  latencyOffsetMs: number;
  countInBeats: number;
  timeSignature?: {
    numerator: number;
    denominator: number;
  };
};

type RecoveryJournal = {
  session: string;
  project: StoredProject;
  acceptableBaseUpdatedAts: number[];
};

function project(
  id: string,
  name: string,
  bpm: number,
  updatedAt: number,
): StoredProject {
  return {
    id,
    name,
    bpm,
    tracks: [],
    createdAt: 1_000,
    updatedAt,
    latencyOffsetMs: 0,
    countInBeats: 0,
  };
}

async function seedRecoveryState(
  page: Page,
  authoritative: StoredProject,
  journals: RecoveryJournal[],
) {
  // Use a same-origin, non-app page so setup cannot install lifecycle hooks
  // or write an extra unload journal while navigating into Cypher.
  await page.goto("/manifest.webmanifest");
  await page.evaluate(
    async ({ authoritativeProject, pendingJournals }) => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("cypher", 2);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("projects")) {
            db.createObjectStore("projects", { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains("audio")) {
            db.createObjectStore("audio");
          }
          if (!db.objectStoreNames.contains("meta")) {
            db.createObjectStore("meta");
          }
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(["projects", "meta"], "readwrite");
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          const projects = tx.objectStore("projects");
          const meta = tx.objectStore("meta");
          projects.clear();
          meta.clear();
          projects.put(authoritativeProject);
          meta.put(authoritativeProject.id, "currentProjectId");
        };
      });

      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("cypher:pending-project-snapshot:")) {
          localStorage.removeItem(key);
        }
      }
      for (const [journalIndex, journal] of pendingJournals.entries()) {
        localStorage.setItem(
          `cypher:pending-project-snapshot:${encodeURIComponent(
            authoritativeProject.id,
          )}:${journal.session}:${journalIndex}:fixture-${journal.session}-${journalIndex}`,
          JSON.stringify({
            version: 3,
            project: journal.project,
            acceptableBaseUpdatedAts: journal.acceptableBaseUpdatedAts,
          }),
        );
      }
    },
    { authoritativeProject: authoritative, pendingJournals: journals },
  );
}

async function readStoredProjects(page: Page): Promise<StoredProject[]> {
  return page.evaluate(
    () =>
      new Promise<StoredProject[]>((resolve, reject) => {
        const request = indexedDB.open("cypher");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const get = db.transaction("projects", "readonly")
            .objectStore("projects")
            .getAll();
          get.onerror = () => reject(get.error);
          get.onsuccess = () => {
            resolve(get.result as StoredProject[]);
            db.close();
          };
        };
      }),
  );
}

async function readPendingJournalKeys(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith("cypher:pending-project-snapshot:"))
      .sort(),
  );
}

async function readStoredBpm(page: Page): Promise<number | null> {
  return page.evaluate(
    () =>
      new Promise<number | null>((resolve, reject) => {
        const request = indexedDB.open("cypher", 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("projects", "readonly");
          const get = tx.objectStore("projects").get("default");
          get.onerror = () => reject(get.error);
          get.onsuccess = () => {
            resolve((get.result as { bpm?: number } | undefined)?.bpm ?? null);
            db.close();
          };
        };
      }),
  );
}

async function seedCompactionState(page: Page) {
  const sourceId = "compact-source";
  const liveKey = `audio:${sourceId}:t1:live`;
  const orphanKey = `audio:${sourceId}:discarded-take`;
  const sourceProject: StoredProject = {
    id: sourceId,
    name: "Seven Eight Session",
    bpm: 137,
    tracks: [
      {
        id: "t1",
        name: "Lead take",
        fileName: "neptunes-80.wav",
        hasAudio: true,
        durationSec: 0.5,
        volume: 0.37,
        pan: -0.25,
        muted: true,
        soloed: false,
        audioKey: liveKey,
        trimInSec: 0.01,
        trimOutSec: 0.4,
        inputDeviceId: "default",
        inputGain: 0.72,
        armed: false,
        normalized: true,
        normalizationGain: 1.15,
        kind: "audio",
      },
    ],
    createdAt: 1_000,
    updatedAt: 5_000,
    latencyOffsetMs: 23,
    countInBeats: 3,
    timeSignature: { numerator: 7, denominator: 8 },
  };

  // Seed on a same-origin non-app page so the application cannot autosave
  // over the deliberately orphaned key before the test invokes compaction.
  await page.goto("/manifest.webmanifest");
  const liveByteLength = await page.evaluate(
    async ({ projectToSeed, referencedKey, unusedKey }) => {
      const response = await fetch("/demo/neptunes-80.wav");
      if (!response.ok) throw new Error("Could not load the compaction fixture.");
      const liveAudio = await response.arrayBuffer();
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("cypher", 2);
        request.onupgradeneeded = () => {
          const opened = request.result;
          if (!opened.objectStoreNames.contains("projects")) {
            opened.createObjectStore("projects", { keyPath: "id" });
          }
          if (!opened.objectStoreNames.contains("audio")) {
            opened.createObjectStore("audio");
          }
          if (!opened.objectStoreNames.contains("meta")) {
            opened.createObjectStore("meta");
          }
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["projects", "audio", "meta"], "readwrite");
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
        tx.oncomplete = () => resolve();
        const projects = tx.objectStore("projects");
        const audio = tx.objectStore("audio");
        const meta = tx.objectStore("meta");
        projects.clear();
        audio.clear();
        meta.clear();
        projects.put(projectToSeed);
        audio.put(liveAudio, referencedKey);
        audio.put(new Uint8Array([9, 8, 7, 6]).buffer, unusedKey);
        meta.put(projectToSeed.id, "currentProjectId");
      });
      db.close();
      return liveAudio.byteLength;
    },
    {
      projectToSeed: sourceProject,
      referencedKey: liveKey,
      unusedKey: orphanKey,
    },
  );

  return { sourceId, liveKey, orphanKey, sourceProject, liveByteLength };
}

async function readCompactionState(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{
        projects: StoredProject[];
        audioKeys: string[];
        audioByteLengths: number[];
        pendingAudioMarkers: string[];
        currentProjectId: string | null;
      }>((resolve, reject) => {
        const request = indexedDB.open("cypher", 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(["projects", "audio", "meta"], "readonly");
          const projectsRequest = tx.objectStore("projects").getAll();
          const audioStore = tx.objectStore("audio");
          const audioKeysRequest = audioStore.getAllKeys();
          const audioValuesRequest = audioStore.getAll();
          const metaStore = tx.objectStore("meta");
          const currentProjectRequest = metaStore.get("currentProjectId");
          const metaKeysRequest = metaStore.getAllKeys();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
          tx.oncomplete = () => {
            const audioByteLengths = (
              audioValuesRequest.result as Array<ArrayBuffer | Blob>
            ).map((value) =>
              value instanceof Blob ? value.size : value.byteLength,
            );
            resolve({
              projects: projectsRequest.result as StoredProject[],
              audioKeys: (audioKeysRequest.result as string[]).sort(),
              audioByteLengths,
              pendingAudioMarkers: (metaKeysRequest.result as IDBValidKey[])
                .filter(
                  (key): key is string =>
                    typeof key === "string" &&
                    key.startsWith("pending-audio:"),
                )
                .sort(),
              currentProjectId:
                (currentProjectRequest.result as string | undefined) ?? null,
            });
            db.close();
          };
        };
      }),
  );
}

test("a blocked database upgrade fails visibly and succeeds after Retry", async ({
  context,
}) => {
  const blockerPage = await context.newPage();
  await blockerPage.goto("/manifest.webmanifest");
  await blockerPage.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("cypher", 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore("projects", { keyPath: "id" });
          db.createObjectStore("audio");
          db.createObjectStore("meta");
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          (window as Window & { __blockingDb?: IDBDatabase }).__blockingDb =
            request.result;
          resolve();
        };
      }),
  );

  const appPage = await context.newPage();
  await appPage.goto("/");
  await expect(appPage.getByText("PROJECT UNAVAILABLE")).toBeVisible({
    timeout: 10_000,
  });
  await expect(appPage.getByText(/Close other Cypher tabs, then retry/i)).toBeVisible();

  await blockerPage.evaluate(() => {
    (window as Window & { __blockingDb?: IDBDatabase }).__blockingDb?.close();
  });
  await appPage.getByRole("button", { name: "Retry" }).click();
  await waitForShell(appPage);
});

test("startup repairs a stranded current-project pointer", async ({ page }) => {
  const strandedId = "stranded-new-project";
  const existing = project("existing-project", "Existing work", 128, 2_000);
  await seedRecoveryState(page, existing, []);
  await page.evaluate(
    (missingId) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("cypher", 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("meta", "readwrite");
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.objectStore("meta").put(missingId, "currentProjectId");
        };
      }),
    strandedId,
  );

  await page.goto("/");
  await waitForShell(page);
  await expect
    .poll(async () => (await readCompactionState(page)).currentProjectId)
    .toBe(strandedId);
  const repairedProjects = await readStoredProjects(page);
  expect(repairedProjects).toHaveLength(2);
  expect(repairedProjects.find(({ id }) => id === strandedId)).toMatchObject({
    id: strandedId,
    name: "Untitled",
    tracks: [],
  });
  expect(repairedProjects.find(({ id }) => id === existing.id)).toMatchObject({
    id: existing.id,
    name: existing.name,
    bpm: existing.bpm,
  });

  // The repaired row and pointer survive a new document; Retry can no longer
  // loop forever on the missing id.
  await page.reload();
  await waitForShell(page);
  await expect
    .poll(async () => (await readCompactionState(page)).currentProjectId)
    .toBe(strandedId);
});

test("a delayed stale tab cannot overwrite a newer project save", async ({
  context,
  page: tabA,
}) => {
  await tabA.goto("/");
  await waitForShell(tabA);
  await expect.poll(() => readStoredBpm(tabA)).toBe(120);

  const tabB = await context.newPage();
  await tabB.goto("/");
  await waitForShell(tabB);

  await tabA.evaluate(() => {
    const originalSetTimeout = window.setTimeout.bind(window);
    let delayNextAutosave = true;
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delayNextAutosave && delay === 400) {
        delayNextAutosave = false;
        return originalSetTimeout(handler, 1_600, ...args);
      }
      return originalSetTimeout(handler, delay, ...args);
    }) as typeof window.setTimeout;
  });

  const bpmA = tabA.getByRole("spinbutton", {
    name: "Tempo in beats per minute",
  });
  await bpmA.fill("130");
  await bpmA.press("Enter");

  const bpmB = tabB.getByRole("spinbutton", {
    name: "Tempo in beats per minute",
  });
  await bpmB.fill("140");
  await bpmB.press("Enter");
  await expect.poll(() => readStoredBpm(tabB)).toBe(140);

  await expect(tabA.getByText("PROJECT UNAVAILABLE")).toBeVisible({
    timeout: 5_000,
  });
  await expect(tabA.getByText(/changed in another tab/i)).toBeVisible();
  await expect.poll(() => readStoredBpm(tabB)).toBe(140);
});

test("an older divergent journal becomes a recovered project", async ({
  page,
}) => {
  const projectId = "project/recovery target";
  const authoritative = project(projectId, "Authoritative mix", 120, 3_000);
  const interrupted = project(projectId, "Interrupted edit", 131, 2_000);
  await seedRecoveryState(page, authoritative, [
    {
      session: "stale-tab",
      project: interrupted,
      acceptableBaseUpdatedAts: [1_500],
    },
  ]);
  expect(await readPendingJournalKeys(page)).toEqual([
    "cypher:pending-project-snapshot:project%2Frecovery%20target:stale-tab:0:fixture-stale-tab-0",
  ]);

  await page.goto("/");
  await waitForShell(page);
  await expect.poll(async () => (await readStoredProjects(page)).length).toBe(2);

  const stored = await readStoredProjects(page);
  const stillAuthoritative = stored.find(({ id }) => id === projectId);
  const recovered = stored.filter(({ id }) => id !== projectId);
  expect(stillAuthoritative).toMatchObject(authoritative);
  expect(recovered).toHaveLength(1);
  expect(recovered[0]).toMatchObject({ bpm: interrupted.bpm });
  expect(recovered[0].name).toMatch(/recovered/i);
  expect(recovered[0].name).not.toBe(interrupted.name);
  await expect(
    page.getByRole("spinbutton", { name: "Tempo in beats per minute" }),
  ).toHaveValue(String(authoritative.bpm));
  expect(await readPendingJournalKeys(page)).toEqual([]);
});

test("same-project session journals are both processed without overwriting", async ({
  page,
}) => {
  const projectId = "shared project/id";
  const authoritative = project(projectId, "Shared mix", 120, 1_000);
  const alpha = project(projectId, "Alpha pending edit", 131, 2_000);
  const beta = project(projectId, "Beta pending edit", 149, 3_000);
  await seedRecoveryState(page, authoritative, [
    {
      session: "tab-alpha",
      project: alpha,
      acceptableBaseUpdatedAts: [authoritative.updatedAt],
    },
    {
      session: "tab-beta",
      project: beta,
      acceptableBaseUpdatedAts: [authoritative.updatedAt],
    },
  ]);
  expect(await readPendingJournalKeys(page)).toEqual([
    "cypher:pending-project-snapshot:shared%20project%2Fid:tab-alpha:0:fixture-tab-alpha-0",
    "cypher:pending-project-snapshot:shared%20project%2Fid:tab-beta:1:fixture-tab-beta-1",
  ]);

  await page.goto("/");
  await waitForShell(page);
  await expect.poll(async () => (await readStoredProjects(page)).length).toBe(2);

  const stored = await readStoredProjects(page);
  const promoted = stored.find(({ id }) => id === projectId);
  const recovered = stored.find(({ id }) => id !== projectId);
  expect(promoted).toBeDefined();
  expect(recovered).toBeDefined();
  expect(stored.map(({ bpm }) => bpm).sort((a, b) => a - b)).toEqual([
    alpha.bpm,
    beta.bpm,
  ]);

  const originalNameByBpm = new Map([
    [alpha.bpm, alpha.name],
    [beta.bpm, beta.name],
  ]);
  expect(promoted?.name).toBe(originalNameByBpm.get(promoted?.bpm ?? -1));
  expect(recovered?.name).toContain(
    originalNameByBpm.get(recovered?.bpm ?? -1),
  );
  expect(recovered?.name).toMatch(/recovered/i);
  expect(await readPendingJournalKeys(page)).toEqual([]);
});

test("two opening tabs consume one recovery journal only once", async ({
  context,
  page,
}) => {
  const projectId = "concurrent recovery project";
  const authoritative = project(projectId, "Before interruption", 120, 1_000);
  const pending = project(projectId, "Recovered once", 146, 2_000);
  await seedRecoveryState(page, authoritative, [
    {
      session: "closed-writer:1:immutable",
      project: pending,
      acceptableBaseUpdatedAts: [authoritative.updatedAt],
    },
  ]);
  const otherTab = await context.newPage();

  await Promise.all([page.goto("/"), otherTab.goto("/")]);
  await Promise.all([waitForShell(page), waitForShell(otherTab)]);
  await expect.poll(async () => (await readStoredProjects(page)).length).toBe(1);

  expect(await readStoredProjects(page)).toMatchObject([
    {
      id: projectId,
      name: pending.name,
      bpm: pending.bpm,
    },
  ]);
  expect(await readPendingJournalKeys(page)).toEqual([]);
});

test("newest immutable generation supersedes an older journal from its session", async ({
  page,
}) => {
  const projectId = "append-only recovery project";
  const authoritative = project(projectId, "Base mix", 120, 1_000);
  const older = project(projectId, "Older pending edit", 131, 2_000);
  const newest = project(projectId, "Newest pending edit", 147, 3_000);
  await seedRecoveryState(page, authoritative, [
    {
      session: "same-tab",
      project: older,
      acceptableBaseUpdatedAts: [authoritative.updatedAt],
    },
    {
      session: "same-tab",
      project: newest,
      acceptableBaseUpdatedAts: [authoritative.updatedAt],
    },
  ]);

  await page.goto("/");
  await waitForShell(page);
  const stored = await readStoredProjects(page);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({
    id: projectId,
    bpm: newest.bpm,
    name: newest.name,
  });
  expect(await readPendingJournalKeys(page)).toEqual([]);
});

test("a handled mutable legacy journal is retired without rematerializing", async ({
  page,
}) => {
  const projectId = "legacy retirement project";
  const authoritative = project(projectId, "Authoritative legacy mix", 120, 3_000);
  const interrupted = project(projectId, "Legacy pending edit", 139, 2_000);
  await seedRecoveryState(page, authoritative, [
    {
      session: "legacy-tab",
      project: interrupted,
      acceptableBaseUpdatedAts: [1_500],
    },
  ]);
  const legacyKey = await page.evaluate((id) => {
    const immutableKey = Object.keys(localStorage).find((key) =>
      key.startsWith(
        `cypher:pending-project-snapshot:${encodeURIComponent(id)}:`,
      ),
    );
    if (!immutableKey) throw new Error("Missing immutable recovery fixture.");
    const raw = localStorage.getItem(immutableKey);
    if (!raw) throw new Error("Missing recovery fixture value.");
    const mutableKey = `cypher:pending-project-snapshot:${encodeURIComponent(id)}:legacy-tab`;
    localStorage.setItem(mutableKey, raw);
    localStorage.removeItem(immutableKey);
    return mutableKey;
  }, projectId);

  await page.goto("/");
  await waitForShell(page);
  await expect.poll(async () => (await readStoredProjects(page)).length).toBe(2);
  expect(await readPendingJournalKeys(page)).toEqual([legacyKey]);

  // The exact-value retirement marker suppresses duplicate recovery while the
  // mutable source key remains potentially owned by an older live build.
  await page.reload();
  await waitForShell(page);
  expect(await readStoredProjects(page)).toHaveLength(2);

  // Explicit compaction owns the project's exclusive session lock, so it can
  // finally remove the retired mutable key and its marker.
  await page.getByRole("button", { name: "Library and export menu" }).click();
  const menu = page.getByRole("dialog", {
    name: "Project, audio, and export settings",
  });
  page.once("dialog", (dialog) => dialog.accept());
  await menu
    .getByRole("button", { name: "Compact project storage…" })
    .click();
  await expect(
    page.getByText("Project storage compacted", { exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  expect(await readPendingJournalKeys(page)).toEqual([]);
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) =>
        key.startsWith("cypher:retired-recovery-journal:"),
      ),
    ),
  ).toEqual([]);
});

test("project compaction atomically keeps only live audio and preserves the mix", async ({
  page,
}) => {
  const seeded = await seedCompactionState(page);

  await page.goto("/");
  await waitForShell(page);
  const dormantRecoveryKey = `audio:${seeded.sourceId}:t1:dormant-recovery`;
  const olderRecoveryKey = `audio:${seeded.sourceId}:t1:older-recovery-generation`;
  const preparedOnlyKey = `audio:${seeded.sourceId}:t1:prepared-only`;
  const sourceTrack = seeded.sourceProject.tracks[0] as Record<string, unknown>;
  const dormantProject: StoredProject = {
    ...seeded.sourceProject,
    name: "Interrupted dormant take",
    updatedAt: seeded.sourceProject.updatedAt + 2,
    tracks: [{ ...sourceTrack, audioKey: dormantRecoveryKey }],
  };
  const olderDormantProject: StoredProject = {
    ...seeded.sourceProject,
    name: "Earlier interrupted take",
    updatedAt: seeded.sourceProject.updatedAt + 1,
    tracks: [{ ...sourceTrack, audioKey: olderRecoveryKey }],
  };
  await page.evaluate(
    async ({
      projectId,
      recoveryAudioKey,
      olderRecoveryAudioKey,
      preparedAudioKey,
      pendingProject,
      olderPendingProject,
      baseRevision,
    }) => {
      const response = await fetch("/demo/neptunes-80.wav");
      if (!response.ok) throw new Error("Could not load the recovery fixture.");
      const recoveryAudio = await response.arrayBuffer();
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("cypher", 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(["audio", "meta"], "readwrite");
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.objectStore("audio").put(recoveryAudio, recoveryAudioKey);
          tx.objectStore("audio").put(recoveryAudio, olderRecoveryAudioKey);
          tx.objectStore("audio").put(
            new Uint8Array([1, 2, 3, 4]).buffer,
            preparedAudioKey,
          );
          tx.objectStore("meta").put(
            Date.now(),
            `pending-audio:${preparedAudioKey}`,
          );
        };
      });
      localStorage.setItem(
        `cypher:pending-project-snapshot:${encodeURIComponent(projectId)}:closed-tab:1:fixture-compaction-newest`,
        JSON.stringify({
          version: 3,
          project: pendingProject,
          acceptableBaseUpdatedAts: [baseRevision],
        }),
      );
      localStorage.setItem(
        `cypher:pending-project-snapshot:${encodeURIComponent(projectId)}:closed-tab:0:fixture-compaction-older`,
        JSON.stringify({
          version: 3,
          project: olderPendingProject,
          acceptableBaseUpdatedAts: [baseRevision],
        }),
      );
    },
    {
      projectId: seeded.sourceId,
      recoveryAudioKey: dormantRecoveryKey,
      olderRecoveryAudioKey: olderRecoveryKey,
      preparedAudioKey: preparedOnlyKey,
      pendingProject: dormantProject,
      olderPendingProject: olderDormantProject,
      baseRevision: seeded.sourceProject.updatedAt,
    },
  );
  await page.getByRole("button", { name: "Library and export menu" }).click();
  const menu = page.getByRole("dialog", {
    name: "Project, audio, and export settings",
  });
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("remove unused takes");
    await dialog.accept();
  });
  await menu
    .getByRole("button", { name: "Compact project storage…" })
    .click();
  await expect(
    page.getByText("Project storage compacted", { exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  await expect
    .poll(async () => (await readCompactionState(page)).audioKeys)
    .toEqual([dormantRecoveryKey, olderRecoveryKey, seeded.liveKey].sort());
  const compactedState = await readCompactionState(page);
  expect(compactedState.projects).toHaveLength(1);
  const compacted = compactedState.projects[0];
  expect(compacted.id).toBe(seeded.sourceId);
  expect(compactedState.currentProjectId).toBe(seeded.sourceId);

  expect(compactedState.audioKeys).toEqual(
    [dormantRecoveryKey, olderRecoveryKey, seeded.liveKey].sort(),
  );
  expect(compactedState.audioKeys).not.toContain(seeded.orphanKey);
  expect(compactedState.audioKeys).not.toContain(preparedOnlyKey);
  expect(compactedState.pendingAudioMarkers).toEqual([]);
  expect(compactedState.audioByteLengths).toEqual([
    seeded.liveByteLength,
    seeded.liveByteLength,
    seeded.liveByteLength,
  ]);

  expect(compacted).toMatchObject({
    name: seeded.sourceProject.name,
    bpm: seeded.sourceProject.bpm,
    createdAt: seeded.sourceProject.createdAt,
    latencyOffsetMs: seeded.sourceProject.latencyOffsetMs,
    countInBeats: seeded.sourceProject.countInBeats,
    timeSignature: seeded.sourceProject.timeSignature,
  });
  expect(compacted.updatedAt).toBeGreaterThan(seeded.sourceProject.updatedAt);
  expect(compacted.tracks).toHaveLength(1);
  expect(compacted.tracks[0]).toMatchObject({
    id: "t1",
    name: "Lead take",
    fileName: "neptunes-80.wav",
    hasAudio: true,
    durationSec: 0.5,
    volume: 0.37,
    pan: -0.25,
    muted: true,
    soloed: false,
    audioKey: seeded.liveKey,
    trimInSec: 0.01,
    trimOutSec: 0.4,
    inputGain: 0.72,
    normalized: true,
    normalizationGain: 1.15,
    kind: "audio",
  });

  // The dormant journal remains discoverable after in-place compaction and
  // its branch-only audio survives the sweep, so startup can materialize it.
  await page.reload();
  await waitForShell(page);
  await expect.poll(async () => (await readStoredProjects(page)).length).toBe(2);
  const recovered = (await readStoredProjects(page)).find(
    ({ id }) => id !== seeded.sourceId,
  );
  expect(recovered?.name).toMatch(/recovered/i);
  expect(recovered?.tracks[0]).toMatchObject({
    audioKey: expect.stringMatching(
      new RegExp(`^audio:${recovered?.id}:t1:`),
    ),
  });
  expect(await readPendingJournalKeys(page)).toEqual([]);
});

test("project compaction refuses while another tab can still reference old audio", async ({
  context,
  page,
}) => {
  const seeded = await seedCompactionState(page);
  await page.goto("/");
  await waitForShell(page);
  const otherTab = await context.newPage();
  await otherTab.goto("/");
  await waitForShell(otherTab);

  await page.getByRole("button", { name: "Library and export menu" }).click();
  await otherTab
    .getByRole("button", { name: "Library and export menu" })
    .click();
  page.once("dialog", (dialog) => dialog.accept());
  otherTab.once("dialog", (dialog) => dialog.accept());
  await Promise.all([
    page
      .getByRole("dialog", {
        name: "Project, audio, and export settings",
      })
      .getByRole("button", { name: "Compact project storage…" })
      .click(),
    otherTab
      .getByRole("dialog", {
        name: "Project, audio, and export settings",
      })
      .getByRole("button", { name: "Compact project storage…" })
      .click(),
  ]);
  await expect(page.getByText("Close other project tabs", { exact: true })).toBeVisible();
  await expect(
    otherTab.getByText("Close other project tabs", { exact: true }),
  ).toBeVisible();
  expect((await readCompactionState(page)).audioKeys).toContain(
    seeded.orphanKey,
  );

  await otherTab.close();
  await expect
    .poll(() =>
      page.evaluate(async ({ lockName }) => {
        const snapshot = await navigator.locks.query();
        return snapshot.held?.filter((lock) => lock.name === lockName).length ?? 0;
      }, { lockName: `cypher:project-session:${seeded.sourceId}` }),
    )
    .toBe(1);

  await page.getByRole("button", { name: "Library and export menu" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("dialog", {
      name: "Project, audio, and export settings",
    })
    .getByRole("button", { name: "Compact project storage…" })
    .click();
  await expect(
    page.getByText("Project storage compacted", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await readCompactionState(page)).audioKeys)
    .toEqual([seeded.liveKey]);
});

test("project deletion refuses while another tab has the project open", async ({
  context,
  page,
}) => {
  const seeded = await seedCompactionState(page);
  await page.goto("/");
  await waitForShell(page);
  const otherTab = await context.newPage();
  await otherTab.goto("/");
  await waitForShell(otherTab);

  await page.getByRole("button", { name: "Library and export menu" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("dialog", {
      name: "Project, audio, and export settings",
    })
    .getByRole("button", { name: "Delete this project" })
    .click();

  await expect(page.getByText("Close other project tabs", { exact: true })).toBeVisible();
  const state = await readCompactionState(page);
  expect(state.projects.map(({ id }) => id)).toContain(seeded.sourceId);
  expect(state.audioKeys).toContain(seeded.liveKey);
});

test("deleting the only default project opens a fresh project without deadlocking", async ({
  page,
}) => {
  await page.goto("/");
  await waitForShell(page);
  await expect.poll(async () => (await readCompactionState(page)).currentProjectId).toBe(
    "default",
  );

  await page.getByRole("button", { name: "Library and export menu" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("dialog", {
      name: "Project, audio, and export settings",
    })
    .getByRole("button", { name: "Delete this project" })
    .click();
  await waitForShell(page);

  await expect
    .poll(async () => (await readCompactionState(page)).currentProjectId)
    .not.toBe("default");
  expect((await readStoredProjects(page)).map(({ id }) => id)).not.toContain(
    "default",
  );
});

test("concurrent deletion of the last two projects cannot form a lease cycle", async ({
  context,
  page,
}) => {
  const first = project("delete-cycle-a", "Delete cycle A", 120, 1_000);
  const second = project("delete-cycle-b", "Delete cycle B", 130, 2_000);
  await seedRecoveryState(page, first, []);
  await page.evaluate(
    (projectToAdd) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("cypher", 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("projects", "readwrite");
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.objectStore("projects").put(projectToAdd);
        };
      }),
    second,
  );

  await page.goto("/");
  await waitForShell(page);
  const otherTab = await context.newPage();
  await otherTab.goto("/");
  await waitForShell(otherTab);
  await otherTab
    .getByRole("button", { name: "Library and export menu" })
    .click();
  await otherTab
    .getByRole("dialog", {
      name: "Project, audio, and export settings",
    })
    .getByRole("button", { name: new RegExp(second.name) })
    .click();
  await expect(
    otherTab.getByRole("spinbutton", { name: "Tempo in beats per minute" }),
  ).toHaveValue(String(second.bpm));

  await page.getByRole("button", { name: "Library and export menu" }).click();
  await otherTab
    .getByRole("button", { name: "Library and export menu" })
    .click();
  page.once("dialog", (dialog) => dialog.accept());
  otherTab.once("dialog", (dialog) => dialog.accept());
  await Promise.all([
    page
      .getByRole("dialog", {
        name: "Project, audio, and export settings",
      })
      .getByRole("button", { name: "Delete this project" })
      .click(),
    otherTab
      .getByRole("dialog", {
        name: "Project, audio, and export settings",
      })
      .getByRole("button", { name: "Delete this project" })
      .click(),
  ]);

  await Promise.all([waitForShell(page), waitForShell(otherTab)]);
  const remainingIds = (await readStoredProjects(page)).map(({ id }) => id);
  const originalIds = remainingIds.filter(
    (id) => id === first.id || id === second.id,
  );
  const [pageState, otherTabState] = await Promise.all([
    readCompactionState(page),
    readCompactionState(otherTab),
  ]);
  // Depending on lock timing, one delete may refuse after the other tab adopts
  // its project, or both explicit deletes may commit and each tab may create a
  // fresh unowned fallback. The safety invariant is that both actions settle,
  // at least one original is removed, and every tab lands on durable metadata.
  expect(originalIds.length).toBeLessThanOrEqual(1);
  expect(remainingIds.length).toBeGreaterThanOrEqual(1);
  expect(remainingIds).toContain(pageState.currentProjectId);
  expect(remainingIds).toContain(otherTabState.currentProjectId);
});

test("deleting a project keeps a conflict backup fully restorable", async ({
  page,
}) => {
  const seeded = await seedCompactionState(page);
  const recoveryKey = `audio:${seeded.sourceId}:t1:conflict-backup`;
  const sourceTrack = seeded.sourceProject.tracks[0] as Record<string, unknown>;
  const recoveryProject: StoredProject = {
    ...seeded.sourceProject,
    name: "Unmerged vocal take",
    updatedAt: seeded.sourceProject.updatedAt + 100,
    tracks: [{ ...sourceTrack, audioKey: recoveryKey }],
  };
  const backupKey = `cypher:conflicted-project-snapshot:${encodeURIComponent(
    seeded.sourceId,
  )}:delete-regression`;

  await page.evaluate(
    async ({ branchAudioKey, backupStorageKey, pendingProject }) => {
      const response = await fetch("/demo/neptunes-80.wav");
      if (!response.ok) throw new Error("Could not load the recovery fixture.");
      const branchAudio = await response.arrayBuffer();
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("cypher", 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(["audio", "meta"], "readwrite");
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.objectStore("audio").put(branchAudio, branchAudioKey);
          tx.objectStore("meta").put(
            Date.now(),
            `pending-audio:${branchAudioKey}`,
          );
        };
      });
      localStorage.setItem(
        backupStorageKey,
        JSON.stringify({
          version: 3,
          project: pendingProject,
          acceptableBaseUpdatedAts: [pendingProject.updatedAt - 100],
          conflictedAt: Date.now(),
        }),
      );
    },
    {
      branchAudioKey: recoveryKey,
      backupStorageKey: backupKey,
      pendingProject: recoveryProject,
    },
  );

  await page.goto("/");
  await waitForShell(page);
  await page.getByRole("button", { name: "Library and export menu" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("dialog", {
      name: "Project, audio, and export settings",
    })
    .getByRole("button", { name: "Delete this project" })
    .click();
  await waitForShell(page);

  await expect
    .poll(async () => (await readCompactionState(page)).audioKeys)
    .toEqual([recoveryKey]);
  expect(await page.evaluate((key) => localStorage.getItem(key), backupKey)).not.toBeNull();

  await page.getByRole("button", { name: "Library and export menu" }).click();
  const menu = page.getByRole("dialog", {
    name: "Project, audio, and export settings",
  });
  await expect(menu.getByText(recoveryProject.name, { exact: true })).toBeVisible();
  await menu.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Recovery backup restored", { exact: true })).toBeVisible();

  const restoredProjects = await readStoredProjects(page);
  const restored = restoredProjects.find(({ name }) =>
    name.includes("Recovered backup"),
  );
  expect(restored).toBeDefined();
  expect(restored?.tracks[0]).toMatchObject({
    audioKey: expect.stringMatching(
      new RegExp(`^audio:${restored?.id}:t1:`),
    ),
  });
  expect(await page.evaluate((key) => localStorage.getItem(key), backupKey)).toBeNull();
  const afterRestore = await readCompactionState(page);
  expect(afterRestore.audioKeys).not.toContain(recoveryKey);
  expect(afterRestore.audioKeys).toEqual([
    (restored?.tracks[0] as { audioKey: string }).audioKey,
  ]);
});

test("deleting a project exposes pending journals and discard reclaims their audio", async ({
  page,
}) => {
  const seeded = await seedCompactionState(page);
  await page.goto("/");
  await waitForShell(page);
  const journalAudioKey = `audio:${seeded.sourceId}:t1:closed-tab-journal`;
  const sourceTrack = seeded.sourceProject.tracks[0] as Record<string, unknown>;
  const pendingProject: StoredProject = {
    ...seeded.sourceProject,
    name: "Closed tab pending take",
    updatedAt: seeded.sourceProject.updatedAt + 200,
    tracks: [{ ...sourceTrack, audioKey: journalAudioKey }],
  };
  await page.evaluate(
    async ({ projectId, audioKey, pending }) => {
      const response = await fetch("/demo/neptunes-80.wav");
      if (!response.ok) throw new Error("Could not load the journal fixture.");
      const audio = await response.arrayBuffer();
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("cypher", 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(["audio", "meta"], "readwrite");
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.objectStore("audio").put(audio, audioKey);
          tx.objectStore("meta").put(Date.now(), `pending-audio:${audioKey}`);
        };
      });
      localStorage.setItem(
        `cypher:pending-project-snapshot:${encodeURIComponent(projectId)}:closed-tab`,
        JSON.stringify({
          version: 3,
          project: pending,
          acceptableBaseUpdatedAts: [pending.updatedAt - 200],
        }),
      );
    },
    {
      projectId: seeded.sourceId,
      audioKey: journalAudioKey,
      pending: pendingProject,
    },
  );

  await page.getByRole("button", { name: "Library and export menu" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("dialog", {
      name: "Project, audio, and export settings",
    })
    .getByRole("button", { name: "Delete this project" })
    .click();
  await waitForShell(page);

  await expect.poll(() => readPendingJournalKeys(page)).toEqual([]);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).filter((key) =>
          key.startsWith("cypher:conflicted-project-snapshot:"),
        ),
      ),
    )
    .toHaveLength(1);
  const conflictKeys = await page.evaluate(() =>
    Object.keys(localStorage).filter((key) =>
      key.startsWith("cypher:conflicted-project-snapshot:"),
    ),
  );
  expect((await readCompactionState(page)).audioKeys).toEqual([journalAudioKey]);

  await page.getByRole("button", { name: "Library and export menu" }).click();
  const menu = page.getByRole("dialog", {
    name: "Project, audio, and export settings",
  });
  const backup = menu.getByText(pendingProject.name, { exact: true }).locator("..");
  page.once("dialog", (dialog) => dialog.accept());
  await backup.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Recovery backup deleted", { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await readCompactionState(page)).audioKeys)
    .toEqual([]);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), conflictKeys[0]),
  ).toBeNull();
});

test("project deletion never removes the shared global legacy journal key", async ({
  page,
}) => {
  const seeded = await seedCompactionState(page);
  await page.goto("/");
  await waitForShell(page);
  const pendingProject: StoredProject = {
    ...seeded.sourceProject,
    name: "Global legacy pending edit",
    updatedAt: seeded.sourceProject.updatedAt + 100,
  };
  const globalRaw = JSON.stringify({
    version: 3,
    project: pendingProject,
    acceptableBaseUpdatedAts: [seeded.sourceProject.updatedAt],
  });
  await page.evaluate((raw) => {
    localStorage.setItem("cypher:pending-project-snapshot", raw);
  }, globalRaw);

  await page.getByRole("button", { name: "Library and export menu" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("dialog", {
      name: "Project, audio, and export settings",
    })
    .getByRole("button", { name: "Delete this project" })
    .click();
  await waitForShell(page);

  expect(
    await page.evaluate(() =>
      localStorage.getItem("cypher:pending-project-snapshot"),
    ),
  ).toBe(globalRaw);
  await expect
    .poll(() =>
      page.evaluate((projectId) =>
        Object.keys(localStorage).filter((key) =>
          key.startsWith(
            `cypher:retired-recovery-journal:${encodeURIComponent(projectId)}:`,
          ),
        ),
      seeded.sourceId),
    )
    .toHaveLength(1);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).filter((key) =>
          key.startsWith("cypher:conflicted-project-snapshot:"),
        ),
      ),
    )
    .toHaveLength(1);
});

test("startup retries durable cleanup for a previously deleted source", async ({
  page,
}) => {
  const deletedProjectId = "deleted/recovery-source";
  const orphanedKey = `audio:${deletedProjectId}:t1:consumed-backup`;
  const cleanupKey = `cypher:recovery-audio-cleanup:${encodeURIComponent(
    deletedProjectId,
  )}:crash-retry`;
  await page.goto("/manifest.webmanifest");
  await page.evaluate(
    async ({ audioKey, cleanupStorageKey }) => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("cypher", 2);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("projects")) {
            db.createObjectStore("projects", { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains("audio")) {
            db.createObjectStore("audio");
          }
          if (!db.objectStoreNames.contains("meta")) {
            db.createObjectStore("meta");
          }
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(["projects", "audio", "meta"], "readwrite");
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.objectStore("projects").clear();
          tx.objectStore("audio").clear();
          tx.objectStore("meta").clear();
          tx.objectStore("audio").put(
            new Uint8Array([4, 3, 2, 1]).buffer,
            audioKey,
          );
        };
      });
      localStorage.setItem(cleanupStorageKey, String(Date.now()));
    },
    { audioKey: orphanedKey, cleanupStorageKey: cleanupKey },
  );

  await page.goto("/");
  await waitForShell(page);
  await expect
    .poll(async () => (await readCompactionState(page)).audioKeys)
    .toEqual([]);
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), cleanupKey))
    .toBeNull();
});

test("a rejected shared session-lock request fails visibly instead of hanging", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const originalRequest = navigator.locks.request.bind(navigator.locks) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    let rejectFirstSessionRequest = true;
    Object.defineProperty(navigator.locks, "request", {
      configurable: true,
      value: (...args: unknown[]) => {
        if (
          rejectFirstSessionRequest &&
          typeof args[0] === "string" &&
          args[0].startsWith("cypher:project-session:")
        ) {
          rejectFirstSessionRequest = false;
          return Promise.reject(new DOMException("Lock service unavailable", "InvalidStateError"));
        }
        return originalRequest(...args);
      },
    });
  });

  await page.goto("/");
  await expect(page.getByText("PROJECT UNAVAILABLE")).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "Retry" }).click();
  await waitForShell(page);
});
