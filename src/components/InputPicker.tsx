"use client";

import { useEffect, useState } from "react";
import { useCypher } from "@/state/store";

interface Props {
  trackId: string;
  selectedDeviceId: string;
  disabled?: boolean;
}

export function InputPicker({ trackId, selectedDeviceId, disabled }: Props) {
  const {
    inputDevices,
    refreshInputDevices,
    setInputDevice,
  } = useCypher();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    refreshInputDevices();
  }, [open, refreshInputDevices]);

  useEffect(() => {
    const handler = () => {
      if (useCypher.getState().inputDevices.length > 0) refreshInputDevices();
    };
    navigator.mediaDevices?.addEventListener?.("devicechange", handler);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", handler);
  }, [refreshInputDevices]);

  const selected =
    inputDevices.find((d) => d.deviceId === selectedDeviceId) ?? null;
  const label =
    selectedDeviceId === "default"
      ? "Default mic"
      : selected?.label || "Selected mic";

  return (
    <div className="relative w-full">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="h-9 w-full px-2.5 rounded-md bg-neutral-800 text-neutral-200 text-xs flex items-center gap-2 disabled:opacity-50 active:scale-[0.98]"
        title={label}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <MicIcon />
        <span className="truncate flex-1 text-left">{label}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-neutral-500 shrink-0">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-full mt-1 z-30 max-h-72 overflow-auto bg-neutral-900 border border-neutral-700 rounded-md shadow-xl"
        >
          <DeviceOption
            label="Default mic (system)"
            selected={selectedDeviceId === "default"}
            onPick={() => {
              setInputDevice(trackId, "default");
              setOpen(false);
            }}
          />
          {inputDevices.length === 0 && (
            <div className="px-3 py-2 text-xs text-neutral-500">
              Tap to grant mic permission, then reopen.
            </div>
          )}
          {inputDevices.map((d) => (
            <DeviceOption
              key={d.deviceId}
              label={d.label || `Mic ${d.deviceId.slice(0, 6)}`}
              selected={selectedDeviceId === d.deviceId}
              onPick={() => {
                setInputDevice(trackId, d.deviceId);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
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
        selected ? "text-emerald-400" : "text-neutral-100"
      }`}
      role="option"
      aria-selected={selected}
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
