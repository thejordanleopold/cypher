/**
 * A decoded take needs a small amount of real audio after the scheduled
 * transport lead. Anything shorter is indistinguishable from an interrupted
 * pre-roll and must not replace the track's previous take.
 */
export const MIN_USABLE_RECORDING_DURATION_SEC = 0.05;

export function hasUsableRecordingAfterLead(
  decodedDurationSec: number,
  scheduledLeadSec: number,
): boolean {
  if (!Number.isFinite(decodedDurationSec) || decodedDurationSec <= 0) {
    return false;
  }
  const lead = Number.isFinite(scheduledLeadSec)
    ? Math.max(0, scheduledLeadSec)
    : 0;
  return decodedDurationSec - lead >= MIN_USABLE_RECORDING_DURATION_SEC;
}
