"use client";

interface ReorderGripProps {
  trackId: string;
  trackName: string;
  onDragStart?: (trackId: string, pointerX: number, pointerY: number) => void;
  onMove?: (trackId: string, direction: -1 | 1) => void;
}

export function ReorderGrip({
  trackId,
  trackName,
  onDragStart,
  onMove,
}: ReorderGripProps) {
  return (
    <button
      type="button"
      aria-label={`Reorder ${trackName}. Use Arrow Up or Arrow Down.`}
      title={`Drag to reorder ${trackName}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        onDragStart?.(trackId, event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp") {
          event.preventDefault();
          onMove?.(trackId, -1);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          onMove?.(trackId, 1);
        }
      }}
      className="-mr-1 h-7 w-6 flex items-center justify-center shrink-0 text-[var(--text-faint)] hover:text-[var(--text-primary)] cursor-grab active:cursor-grabbing touch-none rounded-md"
    >
      <svg
        width="10"
        height="14"
        viewBox="0 0 10 14"
        fill="currentColor"
        aria-hidden="true"
      >
        <circle cx="3" cy="2.5" r="1.2" />
        <circle cx="7" cy="2.5" r="1.2" />
        <circle cx="3" cy="7" r="1.2" />
        <circle cx="7" cy="7" r="1.2" />
        <circle cx="3" cy="11.5" r="1.2" />
        <circle cx="7" cy="11.5" r="1.2" />
      </svg>
    </button>
  );
}
