"use client";

import { useEffect } from "react";
import { useCypher } from "@/state/store";

/**
 * Holds a screen Wake Lock while any recording or playback is active so the
 * phone doesn't auto-sleep mid-take. Best-effort: if the OS suspends the tab
 * (iOS background, manual lock), the lock is released and recording stops.
 */
export function WakeLockHandler() {
  const isRecording = useCypher(
    (s) =>
      s.isMultiRecording ||
      s.recordingTrackId !== null ||
      s.isFinalizingRecording,
  );
  const isPlaying = useCypher((s) => s.isPlaying);
  const wantLock = isRecording || isPlaying;

  useEffect(() => {
    if (!wantLock) return;
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (cancelled) {
          await lock.release();
          return;
        }
        sentinel = lock;
        // Re-acquire on visibility change (browsers auto-release when tab is hidden).
        const reacquire = async () => {
          const state = useCypher.getState();
          if (
            document.visibilityState === "visible" &&
            (state.isMultiRecording ||
              state.recordingTrackId !== null ||
              state.isFinalizingRecording ||
              state.isPlaying)
          ) {
            try {
              sentinel = await navigator.wakeLock.request("screen");
            } catch {
              // ignore
            }
          }
        };
        document.addEventListener("visibilitychange", reacquire);
        lock.addEventListener("release", () => {
          document.removeEventListener("visibilitychange", reacquire);
        });
      } catch {
        // User may have denied, or device doesn't support — silently degrade.
      }
    };

    acquire();
    return () => {
      cancelled = true;
      sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [wantLock]);

  return null;
}
