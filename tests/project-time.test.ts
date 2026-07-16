import assert from "node:assert/strict";
import test from "node:test";
import {
  audioTrackDuration,
  canRunTransport,
  clampProjectTime,
  projectDuration,
  hasSamplerCaptureSource,
  sanitizeSamplerEvent,
  samplerTrackDuration,
  sourceTimeAtProjectTime,
  trackProjectDuration,
  type ProjectTimeTrack,
} from "../src/audio/project-time.ts";

function audioTrack(overrides: Partial<ProjectTimeTrack> = {}): ProjectTimeTrack {
  return {
    kind: "audio",
    hasAudio: true,
    durationSec: 10,
    trimInSec: 0,
    trimOutSec: null,
    pads: [],
    samplerPattern: [],
    ...overrides,
  };
}

function samplerTrack(
  overrides: Partial<ProjectTimeTrack> = {},
): ProjectTimeTrack {
  return {
    kind: "sampler",
    hasAudio: false,
    durationSec: 0,
    trimInSec: 0,
    trimOutSec: null,
    pads: [
      { hasAudio: true, durationSec: 0.5 },
      { hasAudio: false, durationSec: 4 },
    ],
    samplerPattern: [],
    ...overrides,
  };
}

test("audio duration is project-relative after source trimming", () => {
  const track = audioTrack({ trimInSec: 5, trimOutSec: 9 });
  assert.equal(audioTrackDuration(track), 4);
  assert.equal(sourceTimeAtProjectTime(track, 0), 5);
  assert.equal(sourceTimeAtProjectTime(track, 3.25), 8.25);
  assert.equal(sourceTimeAtProjectTime(track, 4.01), null);
});

test("sampler duration includes each event's audible tail", () => {
  const track = samplerTrack({
    samplerPattern: [
      { padIdx: 0, timeSec: 2 },
      { padIdx: 0, timeSec: 12 },
      // Empty pads do not extend an otherwise audible project.
      { padIdx: 1, timeSec: 99 },
    ],
  });
  assert.equal(samplerTrackDuration(track), 12.5);
  assert.equal(trackProjectDuration(track), 12.5);
});

test("project duration uses the longest audible track on the shared axis", () => {
  assert.equal(
    projectDuration([
      audioTrack({ trimInSec: 4, trimOutSec: 9 }),
      samplerTrack({ samplerPattern: [{ padIdx: 0, timeSec: 8 }] }),
    ]),
    8.5,
  );
});

test("corrupt and out-of-range values are safely clamped", () => {
  assert.equal(
    audioTrackDuration(
      audioTrack({ durationSec: 10, trimInSec: 20, trimOutSec: -5 }),
    ),
    0,
  );
  assert.equal(clampProjectTime(Number.NaN, 10), 0);
  assert.equal(clampProjectTime(-2, 10), 0);
  assert.equal(clampProjectTime(12, 10), 10);
});

test("only an armed sampler with a loaded pad may roll before the first event", () => {
  const silentSampler = samplerTrack({ samplerRecArmed: true });
  assert.equal(hasSamplerCaptureSource([silentSampler]), true);
  assert.equal(canRunTransport([silentSampler]), true);
  assert.equal(
    canRunTransport([
      samplerTrack({
        samplerRecArmed: true,
        pads: [{ hasAudio: false, durationSec: 0 }],
      }),
    ]),
    false,
  );
  assert.equal(canRunTransport([]), false);
});

test("sampler events survive scheduled-start transport timestamps", () => {
  assert.deepEqual(sanitizeSamplerEvent({ padIdx: 0, timeSec: -0.04 }, 32), {
    padIdx: 0,
    timeSec: 0,
  });
  assert.deepEqual(sanitizeSamplerEvent({ padIdx: 1, timeSec: Number.NaN }, 32), {
    padIdx: 1,
    timeSec: 0,
  });
  assert.equal(sanitizeSamplerEvent({ padIdx: 32, timeSec: 1 }, 32), null);
});
