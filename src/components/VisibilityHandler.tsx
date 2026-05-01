"use client";

import { useEffect } from "react";
import { useCypher } from "@/state/store";
import { getEngine } from "@/audio/engine";

/**
 * Handles tab/app visibility transitions on mobile:
 *  - When hidden: stop any active recording (iOS suspends mic anyway,
 *    leaving the engine in a half-broken state) and pause playback.
 *  - When visible again: ensure the AudioContext is resumed so the next
 *    user action doesn't fall on a deaf graph.
 */
export function VisibilityHandler() {
  useEffect(() => {
    if (typeof document === "undefined") return;

    const onVisibility = async () => {
      const state = useCypher.getState();
      if (document.visibilityState === "hidden") {
        if (state.isMultiRecording) await state.stopArmedRecording();
        if (state.recordingTrackId) await state.stopRecording();
        if (state.isPlaying) state.pause();
      } else {
        // Returning to foreground — resume the AudioContext if iOS suspended it.
        try {
          await getEngine().start();
        } catch {
          // ignore — first user gesture will retry.
        }
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    // pagehide fires on iOS when navigating away or switching apps.
    window.addEventListener("pagehide", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onVisibility);
    };
  }, []);

  return null;
}
