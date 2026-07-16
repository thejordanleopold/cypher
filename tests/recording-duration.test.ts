import assert from "node:assert/strict";
import test from "node:test";
import {
  hasUsableRecordingAfterLead,
  MIN_USABLE_RECORDING_DURATION_SEC,
} from "../src/audio/recording-duration.ts";

test("rejects recordings consumed by their scheduled transport lead", () => {
  assert.equal(hasUsableRecordingAfterLead(0.06, 0.06), false);
  assert.equal(hasUsableRecordingAfterLead(0.08, 0.06), false);
  assert.equal(hasUsableRecordingAfterLead(0.109, 0.06), false);
});

test("accepts a take once enough real audio remains after the lead", () => {
  assert.equal(
    hasUsableRecordingAfterLead(
      0.06 + MIN_USABLE_RECORDING_DURATION_SEC,
      0.06,
    ),
    true,
  );
  assert.equal(hasUsableRecordingAfterLead(1, 0.06), true);
});

test("handles invalid durations without manufacturing a usable take", () => {
  assert.equal(hasUsableRecordingAfterLead(Number.NaN, 0), false);
  assert.equal(hasUsableRecordingAfterLead(0, 0), false);
  assert.equal(hasUsableRecordingAfterLead(0.1, Number.NaN), true);
  assert.equal(hasUsableRecordingAfterLead(0.1, -1), true);
});
