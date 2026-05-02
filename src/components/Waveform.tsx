"use client";

import { useEffect, useRef } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/dist/plugins/regions.js";
import { getEngine } from "@/audio/engine";
import { audioBufferToWavBlob } from "@/audio/wav";
import { useCypher } from "@/state/store";

interface WaveformProps {
  trackId: string;
  hasAudio: boolean;
  bufferRevision: number;
  trimInSec: number;
  trimOutSec: number | null;
  durationSec: number;
}

export function Waveform({
  trackId,
  hasAudio,
  bufferRevision,
  trimInSec,
  trimOutSec,
  durationSec,
}: WaveformProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const trimRegionRef = useRef<Region | null>(null);
  const setTrim = useCypher((s) => s.setTrim);

  useEffect(() => {
    if (!containerRef.current) return;
    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container: containerRef.current,
      height: 44,
      waveColor: "#324264",
      progressColor: "#60a5fa",
      cursorColor: "transparent",
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      interact: false,
      normalize: true,
      plugins: [regions],
    });
    wsRef.current = ws;
    regionsRef.current = regions;

    const onUpdated = (region: Region) => {
      if (region !== trimRegionRef.current) return;
      const dur = ws.getDuration() || durationSec;
      const inS = Math.max(0, region.start);
      const outS = Math.min(dur, region.end);
      setTrim(trackId, inS, outS >= dur - 0.01 ? null : outS);
    };
    regions.on("region-updated", onUpdated);

    return () => {
      ws.destroy();
      wsRef.current = null;
      regionsRef.current = null;
      trimRegionRef.current = null;
    };
  }, [trackId, setTrim, durationSec]);

  // Load buffer into wavesurfer.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !hasAudio) return;
    const buf = getEngine().getTrack(trackId)?.buffer;
    if (!buf) return;
    const blob = audioBufferToWavBlob(buf);
    ws.loadBlob(blob).catch(() => {});
  }, [trackId, hasAudio, bufferRevision]);

  // Sync trim region with state.
  useEffect(() => {
    const ws = wsRef.current;
    const regions = regionsRef.current;
    if (!ws || !regions || !hasAudio) return;
    const apply = () => {
      const dur = ws.getDuration() || durationSec;
      if (!dur) return;
      const start = trimInSec;
      const end = trimOutSec ?? dur;
      if (trimRegionRef.current) {
        trimRegionRef.current.setOptions({ start, end });
      } else {
        trimRegionRef.current = regions.addRegion({
          start,
          end,
          color: "rgba(16, 185, 129, 0.18)",
          drag: false,
          resize: true,
        });
      }
    };
    if (ws.getDuration() > 0) apply();
    else {
      const onReady = () => {
        apply();
        ws.un("ready", onReady);
      };
      ws.on("ready", onReady);
    }
  }, [hasAudio, trimInSec, trimOutSec, durationSec, bufferRevision]);

  return (
    <div
      ref={containerRef}
      className="h-11 bg-neutral-900/50 rounded overflow-hidden"
      aria-label="Waveform with trim region"
    />
  );
}
