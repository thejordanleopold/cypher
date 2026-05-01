"use client";

import { useEffect, useRef } from "react";
import { getEngine } from "@/audio/engine";

interface Props {
  trackId: string;
}

const HISTORY_LEN = 240; // visual bars

export function LiveWaveform({ trackId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaksRef = useRef<Float32Array>(new Float32Array(HISTORY_LEN));
  const writeIdxRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const peaks = peaksRef.current;
    peaks.fill(0);
    writeIdxRef.current = 0;

    let raf = 0;
    let cancelled = false;
    const frameBuf = new Float32Array(1024);

    const tick = () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const analyser = getEngine().getRecordingAnalyser(trackId);
      if (analyser) {
        const buf =
          frameBuf.length === analyser.fftSize ? frameBuf : new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = Math.abs(buf[i]);
          if (v > peak) peak = v;
        }
        peaks[writeIdxRef.current] = peak;
        writeIdxRef.current = (writeIdxRef.current + 1) % HISTORY_LEN;
      }
      draw(ctx2d, canvas, peaks, writeIdxRef.current);
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
    <div className="h-11 bg-neutral-900/50 rounded overflow-hidden ring-1 ring-red-600/40 relative">
      <canvas
        ref={canvasRef}
        className="block w-full h-full"
        aria-label="Live recording waveform"
      />
      <div className="absolute top-1 right-2 flex items-center gap-1 text-[10px] uppercase tracking-wider text-red-400">
        <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
        REC
      </div>
    </div>
  );
}

function draw(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  peaks: Float32Array,
  writeIdx: number,
) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  const mid = h / 2;
  const barCount = HISTORY_LEN;
  const gap = 1;
  const totalGap = gap * (barCount - 1);
  const barW = Math.max(1, (w - totalGap) / barCount);
  ctx.fillStyle = "#ef4444";
  for (let i = 0; i < barCount; i++) {
    // Read peaks chronologically: oldest at left, newest at right.
    const idx = (writeIdx + i) % barCount;
    const peak = peaks[idx];
    const amp = Math.min(1, peak * 1.5);
    const barH = Math.max(1, amp * (h - 4));
    const x = i * (barW + gap);
    ctx.fillRect(x, mid - barH / 2, barW, barH);
  }
}
