"use client";

import { useEffect, useRef } from "react";
import { getEngine } from "@/audio/engine";
import { useCypher } from "@/state/store";

interface Props {
  trackId: string;
}

/**
 * Vertical RMS / peak level meter driven by the recording session's
 * AnalyserNode. Holds peaks for ~600 ms, decays smoothly, paints a
 * small column with green / amber / red zones.
 */
export function LevelMeter({ trackId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isActive = useCypher(
    (state) =>
      state.recordingTrackId === trackId ||
      (state.isMultiRecording &&
        state.tracks.some((track) => track.id === trackId && track.armed)),
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = 0;
    let height = 0;
    let gradient: CanvasGradient | null = null;
    const resize = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      gradient = createMeterGradient(ctx, height);
      draw(ctx, width, height, gradient, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // Mixer strips render meters for every track. When this track is not
    // recording, keep the canvas static instead of running an idle rAF loop.
    if (!isActive) return () => ro.disconnect();

    let samples = new Float32Array(1024);
    let peakHold = 0;
    let peakDecayAt = 0;
    let smoothed = 0;

    let raf = 0;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let visible = !document.hidden;

    const scheduleFrame = () => {
      if (cancelled || !visible || raf) return;
      raf = requestAnimationFrame(tick);
    };

    const schedulePoll = () => {
      if (cancelled || !visible || pollTimer) return;
      pollTimer = setTimeout(() => {
        pollTimer = null;
        scheduleFrame();
      }, 125);
    };

    const tick = () => {
      raf = 0;
      if (cancelled) return;
      if (!visible) return;
      const analyser = getEngine().getRecordingAnalyser(trackId);
      if (analyser) {
        if (samples.length !== analyser.fftSize) {
          samples = new Float32Array(analyser.fftSize);
        }
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        let peak = 0;
        for (let i = 0; i < samples.length; i++) {
          const a = Math.abs(samples[i]);
          sum += a * a;
          if (a > peak) peak = a;
        }
        const rms = Math.sqrt(sum / samples.length);
        smoothed = smoothed * 0.7 + rms * 0.3;

        const now = performance.now();
        if (peak >= peakHold) {
          peakHold = peak;
          peakDecayAt = now + 600;
        } else if (now > peakDecayAt) {
          peakHold *= 0.94;
        }
        draw(ctx, width, height, gradient, smoothed, peakHold);
        scheduleFrame();
      } else {
        smoothed *= 0.9;
        peakHold *= 0.9;
        draw(ctx, width, height, gradient, smoothed, peakHold);
        // Finalizing a recording can temporarily remove the analyser while
        // the store still reports an active take. Decay smoothly, then poll
        // at low frequency instead of burning a full-rate animation loop.
        if (smoothed > 0.001 || peakHold > 0.01) scheduleFrame();
        else schedulePoll();
      }
    };

    const onVisibilityChange = () => {
      visible = !document.hidden;
      if (!visible) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = null;
      } else {
        scheduleFrame();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    scheduleFrame();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      if (pollTimer) clearTimeout(pollTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      ro.disconnect();
    };
  }, [trackId, isActive]);

  return (
    <canvas
      ref={canvasRef}
      className="w-2 h-9 rounded-sm bg-neutral-950 ring-1 ring-neutral-800"
      aria-label="Input level"
    />
  );
}

function draw(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  gradient: CanvasGradient | null,
  rms: number,
  peak: number,
) {
  if (width === 0 || height === 0) return;
  ctx.clearRect(0, 0, width, height);

  // Filled portion (RMS).
  const fillH = Math.min(
    height,
    Math.max(0, height * Math.min(1, rms * 2.5)),
  );
  if (gradient && fillH > 0) {
    ctx.fillStyle = gradient;
    ctx.fillRect(0, height - fillH, width, fillH);
  }

  // Peak hold tick.
  if (peak > 0.02) {
    const peakY =
      height - Math.min(height, height * Math.min(1, peak * 2.5));
    ctx.fillStyle = peak > 0.95 ? "#fca5a5" : "#ffffff";
    ctx.fillRect(0, peakY - 1, width, 1.5);
  }
}

function createMeterGradient(
  ctx: CanvasRenderingContext2D,
  height: number,
) {
  if (height === 0) return null;
  // Background gradient: blue low → amber mid → red high. It only depends on
  // canvas geometry, so rebuild it on resize rather than on every frame.
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "#dc2626");
  gradient.addColorStop(0.2, "#f59e0b");
  gradient.addColorStop(0.5, "#60a5fa");
  gradient.addColorStop(1, "#60a5fa");
  return gradient;
}
