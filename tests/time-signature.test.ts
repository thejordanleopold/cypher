import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TIME_SIGNATURE,
  isSignatureAccent,
  sanitizeTimeSignature,
  signaturePulseMs,
} from "../src/audio/time-signature.ts";

test("legacy or malformed projects fall back to 4/4", () => {
  assert.deepEqual(sanitizeTimeSignature(undefined), DEFAULT_TIME_SIGNATURE);
  assert.deepEqual(
    sanitizeTimeSignature({ numerator: 0, denominator: 3 }),
    DEFAULT_TIME_SIGNATURE,
  );
});

test("valid signatures preserve numerator and denominator losslessly", () => {
  assert.deepEqual(sanitizeTimeSignature({ numerator: 6, denominator: 8 }), {
    numerator: 6,
    denominator: 8,
  });
});

test("pulse timing follows the denominator and accents each measure", () => {
  const sixEight = { numerator: 6, denominator: 8 } as const;
  assert.equal(signaturePulseMs(120, sixEight), 250);
  assert.equal(isSignatureAccent(0, sixEight), true);
  assert.equal(isSignatureAccent(5, sixEight), false);
  assert.equal(isSignatureAccent(6, sixEight), true);
});
