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
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
}

const POPOVER_WIDTH = 224;
const POPOVER_MIN_HEIGHT = 112;
const VIEWPORT_PADDING = 12;
const POPOVER_GAP = 8;

export function AddTrackButton({ variant, stripHeight }: Props) {
  const addTrack = useCypher((s) => s.addTrack);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PopoverPos | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const focusedForOpenRef = useRef(false);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const update = () => {
      const r = btnRef.current!.getBoundingClientRect();
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const width = Math.min(
        POPOVER_WIDTH,
        Math.max(0, viewportWidth - VIEWPORT_PADDING * 2),
      );
      const rightCandidate = r.right + POPOVER_GAP;
      const leftCandidate = r.left - POPOVER_GAP - width;
      const left =
        rightCandidate + width <= viewportWidth - VIEWPORT_PADDING
          ? rightCandidate
          : Math.max(
              VIEWPORT_PADDING,
              Math.min(leftCandidate, viewportWidth - VIEWPORT_PADDING - width),
            );
      const spaceBelow = viewportHeight - r.bottom - POPOVER_GAP - VIEWPORT_PADDING;
      const spaceAbove = r.top - POPOVER_GAP - VIEWPORT_PADDING;

      if (Math.max(spaceBelow, spaceAbove) < POPOVER_MIN_HEIGHT) {
        setPos({
          top: VIEWPORT_PADDING,
          left,
          width,
          maxHeight: Math.max(0, viewportHeight - VIEWPORT_PADDING * 2),
        });
      } else if (spaceBelow >= POPOVER_MIN_HEIGHT || spaceBelow >= spaceAbove) {
        setPos({
          top: r.bottom + POPOVER_GAP,
          left,
          width,
          maxHeight: Math.max(0, spaceBelow),
        });
      } else {
        setPos({
          bottom: viewportHeight - r.top + POPOVER_GAP,
          left,
          width,
          maxHeight: Math.max(0, spaceAbove),
        });
      }
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [open]);

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
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      focusedForOpenRef.current = false;
      return;
    }
    if (!pos || focusedForOpenRef.current) return;
    focusedForOpenRef.current = true;
    const frame = requestAnimationFrame(() => {
      popRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
        ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, pos]);

  const choose = (kind: TrackKind) => {
    setOpen(false);
    void addTrack(kind);
    requestAnimationFrame(() => btnRef.current?.focus());
  };

  // Wide: two explicit side-by-side buttons, no popover needed.
  if (variant === "wide") {
    return (
      <div className="flex gap-1.5">
        <button
          onClick={() => void addTrack("audio")}
          className="glass flex-1 rounded-xl text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] px-4 py-2.5 text-sm font-medium active:scale-[0.99] transition-colors flex items-center justify-center gap-2"
          aria-label="Add audio track"
        >
          <MicIcon />
          Add Audio Track
        </button>
        <button
          onClick={() => void addTrack("sampler")}
          className="glass flex-1 rounded-xl text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] px-4 py-2.5 text-sm font-medium active:scale-[0.99] transition-colors flex items-center justify-center gap-2"
          aria-label="Add sampler track"
        >
          <PadGridIcon />
          Add Sampler
        </button>
      </div>
    );
  }

  // Strip: compact + button with popover (used in non-track-list contexts).
  const popover = open && pos ? (
    <div
      ref={popRef}
      role="menu"
      aria-label="Choose track type"
      onKeyDown={(e) => {
        const items = Array.from(
          e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
        );
        if (items.length === 0) return;
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const delta = e.key === "ArrowDown" ? 1 : -1;
          items[(current + delta + items.length) % items.length]?.focus();
        } else if (e.key === "Home") {
          e.preventDefault();
          items[0]?.focus();
        } else if (e.key === "End") {
          e.preventDefault();
          items.at(-1)?.focus();
        }
      }}
      style={{
        position: "fixed",
        top: pos.top,
        bottom: pos.bottom,
        left: pos.left,
        width: pos.width,
        maxHeight: pos.maxHeight,
        zIndex: 9999,
      }}
      className="overflow-y-auto overscroll-contain glass-raised rounded-xl p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
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

function MicIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="9" y1="22" x2="15" y2="22" />
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
