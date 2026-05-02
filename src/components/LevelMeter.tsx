"use client";

import { useEffect, useRef } from "react";
import { getEngine } from "@/audio/engine";

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const buf = new Float32Array(1024);
    let peakHold = 0;
    let peakDecayAt = 0;
    let smoothed = 0;

    let raf = 0;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const analyser = getEngine().getRecordingAnalyser(trackId);
      if (analyser) {
        const sized =
          buf.length === analyser.fftSize ? buf : new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(sized);
        let sum = 0;
        let peak = 0;
        for (let i = 0; i < sized.length; i++) {
          const a = Math.abs(sized[i]);
          sum += a * a;
          if (a > peak) peak = a;
        }
        const rms = Math.sqrt(sum / sized.length);
        smoothed = smoothed * 0.7 + rms * 0.3;

        const now = performance.now();
        if (peak >= peakHold) {
          peakHold = peak;
          peakDecayAt = now + 600;
        } else if (now > peakDecayAt) {
          peakHold *= 0.94;
        }
      } else {
        smoothed *= 0.9;
        peakHold *= 0.9;
      }
      draw(ctx, canvas, smoothed, peakHold);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [trackId]);

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
  canvas: HTMLCanvasElement,
  rms: number,
  peak: number,
) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  // Background gradient: blue low → amber mid → red high.
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "#dc2626"); // red top (clipping zone)
  grad.addColorStop(0.2, "#f59e0b"); // amber
  grad.addColorStop(0.5, "#60a5fa"); // blue
  grad.addColorStop(1, "#60a5fa");

  // Filled portion (RMS).
  const fillH = Math.min(h, Math.max(0, h * Math.min(1, rms * 2.5)));
  ctx.fillStyle = grad;
  ctx.fillRect(0, h - fillH, w, fillH);

  // Peak hold tick.
  if (peak > 0.02) {
    const peakY = h - Math.min(h, h * Math.min(1, peak * 2.5));
    ctx.fillStyle = peak > 0.95 ? "#fca5a5" : "#ffffff";
    ctx.fillRect(0, peakY - 1, w, 1.5);
  }
}
