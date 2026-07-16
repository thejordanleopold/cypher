export interface TimeSignature {
  numerator: number;
  denominator: 2 | 4 | 8 | 16;
}

export const DEFAULT_TIME_SIGNATURE: TimeSignature = {
  numerator: 4,
  denominator: 4,
};

export const TIME_SIGNATURE_OPTIONS: readonly TimeSignature[] = [
  { numerator: 2, denominator: 4 },
  { numerator: 3, denominator: 4 },
  { numerator: 4, denominator: 4 },
  { numerator: 5, denominator: 4 },
  { numerator: 6, denominator: 8 },
  { numerator: 7, denominator: 8 },
  { numerator: 9, denominator: 8 },
  { numerator: 12, denominator: 8 },
];

export function sanitizeTimeSignature(value: unknown): TimeSignature {
  if (!value || typeof value !== "object") return { ...DEFAULT_TIME_SIGNATURE };
  const candidate = value as {
    numerator?: unknown;
    denominator?: unknown;
  };
  const numerator =
    typeof candidate.numerator === "number" &&
    Number.isInteger(candidate.numerator) &&
    candidate.numerator >= 1 &&
    candidate.numerator <= 32
      ? candidate.numerator
      : DEFAULT_TIME_SIGNATURE.numerator;
  const denominator = [2, 4, 8, 16].includes(
    candidate.denominator as number,
  )
    ? (candidate.denominator as TimeSignature["denominator"])
    : DEFAULT_TIME_SIGNATURE.denominator;
  return { numerator, denominator };
}

/** Duration of one denominator-note pulse at a quarter-note BPM. */
export function signaturePulseMs(
  bpm: number,
  signature: TimeSignature,
): number {
  const safeBpm = Number.isFinite(bpm) ? Math.max(1, bpm) : 120;
  return (60_000 / safeBpm) * (4 / signature.denominator);
}

export function isSignatureAccent(
  zeroBasedPulse: number,
  signature: TimeSignature,
): boolean {
  return Math.max(0, Math.trunc(zeroBasedPulse)) % signature.numerator === 0;
}
