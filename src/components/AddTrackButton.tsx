"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useCypher, type TrackKind } from "@/state/store";

type Variant = "wide" | "strip";

interface Props {
  variant: Variant;
  stripHeight?: number;
}

interface PopoverPos {
  top: number;
  left: number;
  width: number;
}

export function AddTrackButton({ variant, stripHeight }: Props) {
  const addTrack = useCypher((s) => s.addTrack);
  const tracks = useCypher((s) => s.tracks);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PopoverPos | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Measure trigger position so the portal-rendered popover lines up.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const update = () => {
      const r = btnRef.current!.getBoundingClientRect();
      setPos({
        top: r.bottom + 6,
        left: variant === "strip" ? r.right + 8 : r.left + r.width / 2,
        width: r.width,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, variant]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        !btnRef.current?.contains(e.target as Node) &&
        !popRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (kind: TrackKind) => {
    setOpen(false);
    void addTrack(kind);
  };

  const popover = open && pos ? (
    <div
      ref={popRef}
      role="menu"
      aria-label="Choose track type"
      style={
        variant === "strip"
          ? { position: "fixed", top: pos.top, left: pos.left, zIndex: 9999 }
          : {
              position: "fixed",
              top: pos.top,
              left: pos.left,
              transform: "translateX(-50%)",
              zIndex: 9999,
            }
      }
      className="w-56 glass-raised rounded-xl p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
    >
      <MenuOption
        onClick={() => choose("audio")}
        title="Audio Track"
        subtitle="Record or import a clip"
        icon={<WaveIcon />}
      />
      <MenuOption
        onClick={() => choose("sampler")}
        title="Sampler"
        subtitle="Drum-pad style sample player"
        icon={<PadGridIcon />}
      />
    </div>
  ) : null;

  if (variant === "wide") {
    return (
      <>
        <button
          ref={btnRef}
          onClick={() => setOpen((v) => !v)}
          className="glass block w-full rounded-xl text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] px-4 py-2.5 text-sm font-medium active:scale-[0.99] transition-colors flex items-center justify-center gap-2"
          aria-label="Add new track"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <PlusIcon />
          {tracks.length === 0 ? "Add your first track" : "Add track"}
        </button>
        {typeof document !== "undefined" && createPortal(popover, document.body)}
      </>
    );
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        aria-label="Add new track"
        aria-haspopup="menu"
        aria-expanded={open}
        style={stripHeight ? { height: stripHeight } : undefined}
        className="glass shrink-0 w-12 rounded-xl text-[var(--text-faint)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] flex items-center justify-center transition-colors"
      >
        <PlusIcon size={16} />
      </button>
      {typeof document !== "undefined" && createPortal(popover, document.body)}
    </>
  );
}

function MenuOption({
  onClick,
  title,
  subtitle,
  icon,
}: {
  onClick: () => void;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-white/[0.06] active:bg-white/[0.09] flex items-center gap-2.5 transition-colors"
    >
      <span className="w-7 h-7 rounded-md bg-white/[0.05] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--text-primary)] shrink-0">
        {icon}
      </span>
      <span className="flex flex-col min-w-0">
        <span className="text-[13px] font-medium text-[var(--text-primary)] leading-tight">
          {title}
        </span>
        <span className="text-[11px] text-[var(--text-faint)] leading-tight">
          {subtitle}
        </span>
      </span>
    </button>
  );
}

function PlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function WaveIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M3 12h2l2-7 3 14 3-9 3 6 2-4h3" />
    </svg>
  );
}

function PadGridIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="6" height="6" rx="1.2" />
      <rect x="14" y="4" width="6" height="6" rx="1.2" />
      <rect x="4" y="14" width="6" height="6" rx="1.2" />
      <rect x="14" y="14" width="6" height="6" rx="1.2" />
    </svg>
  );
}
