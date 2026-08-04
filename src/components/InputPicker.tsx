"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useCypher } from "@/state/store";
import { getEngine } from "@/audio/engine";

interface Props {
  trackId: string;
  selectedDeviceId: string;
  disabled?: boolean;
}

interface PopupRect {
  // Distance from the top of the viewport (measured in dvh units via
  // window.innerHeight, which on iOS reflects the visible area).
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
}

const MIN_POPUP_HEIGHT = 200;
const VIEWPORT_PADDING = 12;

export function InputPicker({ trackId, selectedDeviceId, disabled }: Props) {
  const inputDevices = useCypher((state) => state.inputDevices);
  const refreshInputDevices = useCypher((state) => state.refreshInputDevices);
  const setInputDevice = useCypher((state) => state.setInputDevice);
  const [open, setOpen] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [rect, setRect] = useState<PopupRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const focusedForOpenRef = useRef(false);
  const initialFocusFrameRef = useRef<number | null>(null);

  const closeAndRestoreFocus = useCallback(() => {
    if (initialFocusFrameRef.current !== null) {
      cancelAnimationFrame(initialFocusFrameRef.current);
      initialFocusFrameRef.current = null;
    }
    focusedForOpenRef.current = false;
    setOpen(false);
    buttonRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!open) return;
    refreshInputDevices();
  }, [open, refreshInputDevices]);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const el = buttonRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // window.innerHeight tracks the visible viewport on iOS (matches
      // 100dvh), so measurements stay correct as the URL bar shows/hides.
      const viewportH = window.innerHeight;
      const gap = 4;
      const spaceBelow = viewportH - r.bottom - VIEWPORT_PADDING - gap;
      const spaceAbove = r.top - VIEWPORT_PADDING - gap;
      // Prefer below; flip above when there's not enough room and the
      // upward gap is bigger.
      if (spaceBelow >= MIN_POPUP_HEIGHT || spaceBelow >= spaceAbove) {
        setRect({
          top: r.bottom + gap,
          left: r.left,
          width: r.width,
          maxHeight: Math.max(MIN_POPUP_HEIGHT, spaceBelow),
        });
      } else {
        setRect({
          bottom: viewportH - r.top + gap,
          left: r.left,
          width: r.width,
          maxHeight: Math.max(MIN_POPUP_HEIGHT, spaceAbove),
        });
      }
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (
        buttonRef.current?.contains(e.target as Node) ||
        popupRef.current?.contains(e.target as Node)
      ) {
        return;
      }
      if (initialFocusFrameRef.current !== null) {
        cancelAnimationFrame(initialFocusFrameRef.current);
        initialFocusFrameRef.current = null;
      }
      focusedForOpenRef.current = false;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeAndRestoreFocus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closeAndRestoreFocus, open]);

  useEffect(() => {
    if (!open) {
      focusedForOpenRef.current = false;
      return;
    }
    if (!rect || focusedForOpenRef.current) return;

    initialFocusFrameRef.current = requestAnimationFrame(() => {
      initialFocusFrameRef.current = null;
      const firstOption =
        popupRef.current?.querySelector<HTMLButtonElement>("button");
      if (!firstOption) return;
      focusedForOpenRef.current = true;
      firstOption.focus({ preventScroll: true });
    });

    return () => {
      if (initialFocusFrameRef.current !== null) {
        cancelAnimationFrame(initialFocusFrameRef.current);
        initialFocusFrameRef.current = null;
      }
    };
  }, [open, rect]);

  const selected =
    inputDevices.find((d) => d.deviceId === selectedDeviceId) ?? null;
  const label =
    selectedDeviceId === "default"
      ? "Default mic"
      : selected?.label || "Selected mic";

  const isBluetooth = isBluetoothDevice(selected?.label ?? "");

  async function rescan() {
    setRescanning(true);
    try {
      try {
        await getEngine().requestMicPermission();
      } catch {
        // user denied — still try to enumerate so we show what we can
      }
      await refreshInputDevices();
    } finally {
      setRescanning(false);
    }
  }

  return (
    <div className="relative w-full">
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="h-9 w-full px-2.5 rounded-md bg-neutral-800 text-neutral-200 text-xs flex items-center gap-2 disabled:opacity-50 active:scale-[0.98]"
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <MicIcon />
        <span className="truncate flex-1 text-left">{label}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-neutral-500 shrink-0">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && rect && typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popupRef}
            role="dialog"
            aria-label="Select audio input"
            style={{
              position: "fixed",
              top: rect.top,
              bottom: rect.bottom,
              left: rect.left,
              width: rect.width,
              maxHeight: rect.maxHeight,
            }}
            className="z-[80] overflow-auto bg-neutral-900 border border-neutral-700 rounded-md shadow-xl"
          >
            <DeviceOption
              label="Default mic (system)"
              selected={selectedDeviceId === "default"}
              onPick={() => {
                setInputDevice(trackId, "default");
                closeAndRestoreFocus();
              }}
            />
            {inputDevices
              .filter((d) => d.deviceId !== "default" && d.deviceId !== "")
              .map((d) => (
                <DeviceOption
                  key={d.deviceId}
                  label={d.label || `Mic ${d.deviceId.slice(0, 6)}`}
                  selected={selectedDeviceId === d.deviceId}
                  onPick={() => {
                    setInputDevice(trackId, d.deviceId);
                    closeAndRestoreFocus();
                  }}
                />
              ))}
            <div className="border-t border-neutral-800 px-3 py-2.5 space-y-2">
              <button
                onClick={rescan}
                disabled={rescanning}
                className="w-full h-8 rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-100 text-xs font-medium active:scale-[0.98] disabled:opacity-50"
              >
                {rescanning ? "Scanning…" : "Rescan devices"}
              </button>
              <p className="text-[10px] text-neutral-500 leading-snug">
                Wired headsets and USB mics show up here. Bluetooth like AirPods may not — iOS keeps that mic for phone calls only. To stop the speaker bleeding into the mic, plug in wired headphones.
              </p>
              {isBluetooth && (
                <div className="flex gap-2 rounded-md bg-amber-950/50 border border-amber-800/40 px-2.5 py-2">
                  <span className="text-amber-400 text-[11px] mt-px shrink-0">ⓘ</span>
                  <p className="text-[10px] text-amber-300/80 leading-snug">
                    <strong className="text-amber-300 font-semibold">Voice Isolation</strong> may be filtering your mic. To disable it during recording: swipe open iOS <strong className="text-amber-300 font-semibold">Control Center</strong>, tap <strong className="text-amber-300 font-semibold">Mic Mode</strong>, and choose <strong className="text-amber-300 font-semibold">Standard</strong>. iOS remembers this per app.
                    {"\n\n"}Note: Bluetooth headset microphones commonly switch to reduced-bandwidth mono while you monitor audio. For full-bandwidth recording, keep AirPods as the output and select the built-in, wired, or USB mic as the input.
                  </p>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

function isBluetoothDevice(label: string): boolean {
  const l = label.toLowerCase();
  return (
    l.includes("airpod") ||
    l.includes("bluetooth") ||
    l.includes(" bt ") ||
    l.startsWith("bt ") ||
    l.includes("wireless") ||
    l.includes("headset")
  );
}

function DeviceOption({
  label,
  selected,
  onPick,
}: {
  label: string;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      onClick={onPick}
      className={`block w-full text-left px-3 py-3 text-sm truncate hover:bg-neutral-800 active:bg-neutral-800 ${
        selected ? "text-[var(--accent)]" : "text-neutral-100"
      }`}
      aria-pressed={selected}
    >
      {selected ? "✓ " : ""}
      {label}
    </button>
  );
}

function MicIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-neutral-400 shrink-0">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <path d="M12 19v3"/>
    </svg>
  );
}
