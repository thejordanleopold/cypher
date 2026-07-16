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
import { estimateStorage, type StorageEstimate } from "@/persistence/db";
import { useShallow } from "zustand/react/shallow";

interface PopupRect {
  top: number;
  right: number;
  width: number;
  maxHeight: number;
}

const POPUP_WIDTH = 320;
const VIEWPORT_PADDING = 12;
const RECOVERY_CONFLICT_PREFIX = "cypher:conflicted-project-snapshot:";
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (element) =>
      element.getAttribute("aria-hidden") !== "true" &&
      element.getClientRects().length > 0,
  );
}

interface LocalRecoveryBackup {
  key: string;
  projectName: string;
  conflictedAt: number | null;
}

function readLocalRecoveryBackups(): LocalRecoveryBackup[] {
  if (typeof localStorage === "undefined") return [];
  const backups: LocalRecoveryBackup[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(RECOVERY_CONFLICT_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as {
          project?: { name?: unknown };
          conflictedAt?: unknown;
        };
        backups.push({
          key,
          projectName:
            typeof parsed.project?.name === "string"
              ? parsed.project.name
              : "Unknown project",
          conflictedAt:
            typeof parsed.conflictedAt === "number"
              ? parsed.conflictedAt
              : null,
        });
      } catch {
        backups.push({ key, projectName: "Unreadable backup", conflictedAt: null });
      }
    }
  } catch {
    return [];
  }
  return backups.sort(
    (a, b) => (b.conflictedAt ?? 0) - (a.conflictedAt ?? 0),
  );
}

function downloadRecoveryBackup(key: string, projectName: string) {
  const raw = localStorage.getItem(key);
  if (!raw) return;
  const url = URL.createObjectURL(
    new Blob([raw], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${projectName.replace(/[^\w-]+/g, "_") || "cypher"}-recovery.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function MainMenu() {
  const {
    projects,
    currentProjectId,
    currentProjectName,
    lastSavedAt,
    refreshProjects,
    createProject,
    openProject,
    renameProject,
    saveProjectAs,
    compactCurrentProject,
    restoreRecoveryBackup,
    deleteRecoveryBackup,
    deleteCurrentProject,
    saveNow,
    exportMix,
    exportStems,
    exportProgress,
    latencyOffsetMs,
    setLatencyOffsetMs,
    calibrateLatency,
    isCalibrating,
    outputDevices,
    currentOutputDeviceId,
    outputSelectable,
    refreshOutputDevices,
    setOutputDevice,
    inputDevices,
    defaultInputDeviceId,
    refreshInputDevices,
    setDefaultInputDevice,
  } = useCypher(
    useShallow((state) => ({
      projects: state.projects,
      currentProjectId: state.currentProjectId,
      currentProjectName: state.currentProjectName,
      lastSavedAt: state.lastSavedAt,
      refreshProjects: state.refreshProjects,
      createProject: state.createProject,
      openProject: state.openProject,
      renameProject: state.renameProject,
      saveProjectAs: state.saveProjectAs,
      compactCurrentProject: state.compactCurrentProject,
      restoreRecoveryBackup: state.restoreRecoveryBackup,
      deleteRecoveryBackup: state.deleteRecoveryBackup,
      deleteCurrentProject: state.deleteCurrentProject,
      saveNow: state.saveNow,
      exportMix: state.exportMix,
      exportStems: state.exportStems,
      exportProgress: state.exportProgress,
      latencyOffsetMs: state.latencyOffsetMs,
      setLatencyOffsetMs: state.setLatencyOffsetMs,
      calibrateLatency: state.calibrateLatency,
      isCalibrating: state.isCalibrating,
      outputDevices: state.outputDevices,
      currentOutputDeviceId: state.currentOutputDeviceId,
      outputSelectable: state.outputSelectable,
      refreshOutputDevices: state.refreshOutputDevices,
      setOutputDevice: state.setOutputDevice,
      inputDevices: state.inputDevices,
      defaultInputDeviceId: state.defaultInputDeviceId,
      refreshInputDevices: state.refreshInputDevices,
      setDefaultInputDevice: state.setDefaultInputDevice,
    })),
  );
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(currentProjectName);
  const [storage, setStorage] = useState<StorageEstimate | null>(null);
  const [recoveryBackups, setRecoveryBackups] = useState<LocalRecoveryBackup[]>(
    [],
  );
  const [restoringBackupKey, setRestoringBackupKey] = useState<string | null>(
    null,
  );
  const [, forceTick] = useState(0);
  const [rect, setRect] = useState<PopupRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const focusedForOpenRef = useRef(false);
  const initialFocusFrameRef = useRef<number | null>(null);
  const exporting = exportProgress !== null;

  const restoreTriggerFocus = useCallback(() => {
    if (initialFocusFrameRef.current !== null) {
      cancelAnimationFrame(initialFocusFrameRef.current);
      initialFocusFrameRef.current = null;
    }
    buttonRef.current?.focus({ preventScroll: true });
  }, []);

  const closeAndRestoreFocus = useCallback(() => {
    focusedForOpenRef.current = false;
    setOpen(false);
    restoreTriggerFocus();
  }, [restoreTriggerFocus]);

  useEffect(() => {
    if (!open) return;
    refreshProjects();
    refreshOutputDevices();
    refreshInputDevices();
    estimateStorage().then(setStorage).catch(() => setStorage(null));
  }, [open, refreshProjects, refreshOutputDevices, refreshInputDevices]);

  // Keep "saved Xm ago" relative timestamp fresh.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => forceTick((t) => t + 1), 15_000);
    return () => clearInterval(id);
  }, [open]);

  // Position the portaled popover anchored to the trigger button, with the
  // right edge inset from the viewport. Recompute on resize/scroll because
  // the trigger sits in a sticky header that moves as the page scrolls.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const el = buttonRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const viewportH = window.innerHeight;
      const viewportW = window.innerWidth;
      const gap = 6;
      const width = Math.min(POPUP_WIDTH, viewportW - VIEWPORT_PADDING * 2);
      const right = Math.max(VIEWPORT_PADDING, viewportW - r.right);
      const top = r.bottom + gap;
      const maxHeight = Math.max(200, viewportH - top - VIEWPORT_PADDING);
      setRect({ top, right, width, maxHeight });
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
    if (!open) {
      focusedForOpenRef.current = false;
      return;
    }
    if (!rect || focusedForOpenRef.current) return;

    initialFocusFrameRef.current = requestAnimationFrame(() => {
      initialFocusFrameRef.current = null;
      const popover = popoverRef.current;
      if (!popover) return;
      focusedForOpenRef.current = true;
      (getFocusableElements(popover)[0] ?? popover).focus({
        preventScroll: true,
      });
    });

    return () => {
      if (initialFocusFrameRef.current !== null) {
        cancelAnimationFrame(initialFocusFrameRef.current);
        initialFocusFrameRef.current = null;
      }
    };
  }, [open, rect]);

  // Close on outside click + Escape, and keep keyboard focus inside the
  // portaled dialog while it is open.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      // Focus the trigger before the pointer's default focus behavior runs;
      // a focusable outside target can still receive focus normally.
      closeAndRestoreFocus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeAndRestoreFocus();
        return;
      }
      if (e.key !== "Tab") return;

      const popover = popoverRef.current;
      if (!popover) return;
      const focusable = getFocusableElements(popover);
      if (focusable.length === 0) {
        e.preventDefault();
        popover.focus({ preventScroll: true });
        return;
      }

      const active = document.activeElement;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!popover.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus({ preventScroll: true });
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [closeAndRestoreFocus, open]);

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => {
          if (open) closeAndRestoreFocus();
          else {
            setRecoveryBackups(readLocalRecoveryBackups());
            setOpen(true);
          }
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Library and export menu"
        className="h-9 w-9 rounded-md bg-neutral-800 text-neutral-100 flex items-center justify-center active:scale-95 hover:bg-neutral-700 shrink-0"
      >
        <HamburgerIcon />
      </button>

      {exporting &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            role="status"
            aria-live="polite"
            className="fixed z-[70] left-1/2 -translate-x-1/2 bottom-[max(env(safe-area-inset-bottom),1rem)] min-w-52 rounded-xl border border-[var(--border-strong)] bg-neutral-900/95 px-4 py-3 shadow-2xl backdrop-blur"
          >
            <div className="flex items-center justify-between gap-4 text-xs text-neutral-100">
              <span>Exporting audio…</span>
              <span className="tabular-nums text-[var(--accent)]">
                {Math.round((exportProgress ?? 0) * 100)}%
              </span>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full bg-[var(--accent)] transition-[width] duration-150"
                style={{ width: `${Math.round((exportProgress ?? 0) * 100)}%` }}
              />
            </div>
          </div>,
          document.body,
        )}

      {open && rect && typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="Project, audio, and export settings"
            tabIndex={-1}
            style={{
              position: "fixed",
              top: rect.top,
              right: rect.right,
              width: rect.width,
              maxHeight: rect.maxHeight,
            }}
            className="z-50 overflow-y-auto overscroll-contain bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl"
          >
          {/* Project name + rename */}
          <div className="px-3 py-2.5 border-b border-neutral-800">
            <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
              Current project
            </div>
            {renaming ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  renameProject(draftName.trim() || "Untitled");
                  setRenaming(false);
                }}
                className="flex gap-2"
              >
                <input
                  autoFocus
                  aria-label="Project name"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  className="flex-1 bg-neutral-800 border border-neutral-700 rounded px-2 py-1.5 text-sm"
                />
                <button
                  type="submit"
                  className="text-[var(--accent)] text-xs font-semibold px-2"
                >
                  Save
                </button>
              </form>
            ) : (
              <button
                onClick={() => {
                  setDraftName(currentProjectName);
                  setRenaming(true);
                }}
                className="w-full text-left text-sm text-neutral-100 truncate hover:text-[var(--accent)] flex items-center gap-1.5"
              >
                <span className="truncate">{currentProjectName}</span>
                <PencilIcon />
              </button>
            )}
          </div>

          {/* Project actions */}
          <div className="py-1">
            <Section label="Project" />
            <MenuItem onClick={() => saveNow()}>Save now</MenuItem>
            <MenuItem
              onClick={async () => {
                closeAndRestoreFocus();
                await createProject("Untitled");
              }}
            >
              New project
            </MenuItem>
            <MenuItem
              onClick={async () => {
                const name = window.prompt(
                  "Name for the duplicated project",
                  `${currentProjectName} copy`,
                );
                if (!name) return;
                closeAndRestoreFocus();
                await saveProjectAs(name.trim() || "Untitled");
              }}
            >
              Save as new project…
            </MenuItem>
            <MenuItem
              onClick={async () => {
                if (
                  !window.confirm(
                    "Compact this project now? Cypher will keep the current mix, preserve recovery versions, remove unused takes, and clear undo history.",
                  )
                ) {
                  return;
                }
                closeAndRestoreFocus();
                await compactCurrentProject().catch(() => {});
              }}
            >
              Compact project storage…
            </MenuItem>
            <MenuItem
              destructive
              onClick={async () => {
                const cannotCoordinateTabs =
                  typeof navigator.locks?.request !== "function";
                if (
                  !window.confirm(
                    `Delete "${currentProjectName}"? This cannot be undone.${
                      cannotCoordinateTabs
                        ? " Close other Cypher tabs first because this browser cannot coordinate them."
                        : ""
                    }`,
                  )
                  )
                  return;
                closeAndRestoreFocus();
                await deleteCurrentProject();
              }}
            >
              Delete this project
            </MenuItem>
          </div>

          {/* Save + storage status */}
          <div className="px-3 py-2 border-t border-neutral-800 flex items-center justify-between gap-2 text-[10px] text-neutral-500">
            <span>{describeSave(lastSavedAt)}</span>
            {storage && <StorageBar s={storage} />}
          </div>

          {recoveryBackups.length > 0 && (
            <div className="border-t border-amber-700/50 py-1">
              <Section label="Recovery backups" />
              <p className="px-3 pb-2 text-[10px] leading-snug text-amber-200/80">
                These pending versions could not be copied automatically. Retry
                after freeing storage, or download the metadata for review.
              </p>
              {recoveryBackups.map((backup) => (
                <div
                  key={backup.key}
                  className="border-t border-neutral-800 px-3 py-2"
                >
                  <div className="truncate text-xs text-neutral-100">
                    {backup.projectName}
                  </div>
                  {backup.conflictedAt && (
                    <div className="mt-0.5 text-[10px] text-neutral-500">
                      Preserved {formatRelative(backup.conflictedAt)}
                    </div>
                  )}
                  <div className="mt-2 grid grid-cols-3 gap-1.5">
                    <button
                      type="button"
                      disabled={restoringBackupKey !== null}
                      onClick={async () => {
                        setRestoringBackupKey(backup.key);
                        const restored = await restoreRecoveryBackup(backup.key);
                        setRestoringBackupKey(null);
                        if (restored) {
                          setRecoveryBackups((items) =>
                            items.filter((item) => item.key !== backup.key),
                          );
                        }
                      }}
                      className="h-9 rounded-md bg-amber-500/15 text-xs font-medium text-amber-200 hover:bg-amber-500/25 disabled:opacity-50"
                    >
                      {restoringBackupKey === backup.key ? "Restoring…" : "Restore"}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        downloadRecoveryBackup(backup.key, backup.projectName)
                      }
                      className="h-9 rounded-md bg-neutral-800 text-xs text-neutral-100 hover:bg-neutral-700"
                    >
                      Download
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        if (!window.confirm("Delete this recovery backup?")) return;
                        const deleted = await deleteRecoveryBackup(backup.key);
                        if (deleted) {
                          setRecoveryBackups((items) =>
                            items.filter((item) => item.key !== backup.key),
                          );
                        }
                      }}
                      className="h-9 rounded-md bg-neutral-800 text-xs text-red-300 hover:bg-neutral-700"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Recent projects */}
          <div className="border-t border-neutral-800 max-h-56 overflow-y-auto">
            <Section label="Recent projects" />
            {projects.length === 0 && (
              <div className="px-3 pb-2 text-xs text-neutral-500">
                No saved projects yet.
              </div>
            )}
            {projects.map((p) => {
              const isCurrent = p.id === currentProjectId;
              return (
                <button
                  key={p.id}
                  onClick={async () => {
                    closeAndRestoreFocus();
                    if (!isCurrent) await openProject(p.id);
                  }}
                  className={`block w-full text-left px-3 py-2 text-sm hover:bg-neutral-800 ${
                    isCurrent ? "text-[var(--accent)]" : "text-neutral-100"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">
                      {isCurrent ? "✓ " : ""}
                      {p.name}
                    </span>
                    <span className="text-[10px] text-neutral-500 shrink-0">
                      {p.trackCount} {p.trackCount === 1 ? "track" : "tracks"}
                    </span>
                  </div>
                  <div className="text-[10px] text-neutral-500">
                    {formatRelative(p.updatedAt)}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Input device */}
          <div className="border-t border-neutral-800 px-3 py-2.5 space-y-2">
            <Section label="Audio input" />
            <select
              value={defaultInputDeviceId}
              onChange={(e) => setDefaultInputDevice(e.target.value)}
              aria-label="Default audio input device"
              className="w-full h-9 bg-neutral-800 border border-neutral-700 rounded-md px-2 text-sm text-neutral-100"
            >
              <option value="default">System default mic</option>
              {inputDevices
                .filter((d) => d.deviceId !== "default" && d.deviceId !== "")
                .map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Mic ${d.deviceId.slice(0, 6)}`}
                  </option>
                ))}
            </select>
            <p className="text-[10px] text-neutral-500 leading-snug">
              Default mic for recording. Applies to all tracks; you can still override per track.
              Device names appear after the first recording — granting mic access early can lower playback quality on iOS, so we hold off until you actually need it.
            </p>
          </div>

          {/* Output device */}
          {outputSelectable && (
            <div className="border-t border-neutral-800 px-3 py-2.5 space-y-2">
              <Section label="Audio output" />
              <select
                value={currentOutputDeviceId}
                onChange={(e) => setOutputDevice(e.target.value)}
                aria-label="Audio output device"
                className="w-full h-9 bg-neutral-800 border border-neutral-700 rounded-md px-2 text-sm text-neutral-100"
              >
                <option value="default">System default</option>
                {outputDevices
                  .filter((d) => d.deviceId !== "default" && d.deviceId !== "")
                  .map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Output ${d.deviceId.slice(0, 6)}`}
                    </option>
                  ))}
              </select>
              <p className="text-[10px] text-neutral-500 leading-snug">
                Routes playback to a specific speaker or headphones. If the list is empty, tap it once to grant device permission, then reopen.
              </p>
            </div>
          )}

          {/* Latency calibration */}
          <div className="border-t border-neutral-800 px-3 py-2.5 space-y-2">
            <div className="flex items-center justify-between">
              <Section label="Recording latency" />
              <span className="text-[11px] tabular-nums text-[var(--accent)]">
                {latencyOffsetMs} ms
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={400}
              step={1}
              value={latencyOffsetMs}
              onChange={(e) => setLatencyOffsetMs(Number(e.target.value))}
              aria-label="Recording latency offset in milliseconds"
              className="w-full accent-[var(--accent)]"
            />
            <button
              onClick={async () => {
                closeAndRestoreFocus();
                await calibrateLatency("default");
              }}
              disabled={isCalibrating}
              className="w-full h-9 rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-100 text-sm font-medium active:scale-[0.98] disabled:opacity-50"
            >
              {isCalibrating ? "Calibrating…" : "Auto-calibrate (3 s)"}
            </button>
            <p className="text-[10px] text-neutral-500 leading-snug">
              Plays four short clicks through the speaker and listens for them on the mic. Hold the phone close enough that the mic can hear it. New recordings are shifted earlier by this amount so they line up with playback.
            </p>
          </div>

          {/* Export */}
          <div className="border-t border-neutral-800 py-1">
            <Section
              label={
                exporting
                  ? `Exporting ${Math.round((exportProgress ?? 0) * 100)}%`
                  : "Export song"
              }
            />
            <MenuItem
              disabled={exporting}
              onClick={async () => {
                closeAndRestoreFocus();
                await exportMix("wav");
              }}
            >
              Mixdown · WAV
            </MenuItem>
            <MenuItem
              disabled={exporting}
              onClick={async () => {
                closeAndRestoreFocus();
                await exportMix("mp3");
              }}
            >
              Mixdown · MP3 (192 kbps)
            </MenuItem>
            <MenuItem
              disabled={exporting}
              onClick={async () => {
                closeAndRestoreFocus();
                await exportStems("wav");
              }}
            >
              Stems · WAV (one file per track)
            </MenuItem>
            <MenuItem
              disabled={exporting}
              onClick={async () => {
                closeAndRestoreFocus();
                await exportStems("mp3");
              }}
            >
              Stems · MP3 (one file per track)
            </MenuItem>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function MenuItem({
  children,
  onClick,
  destructive,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`block w-full text-left px-3 py-2 text-sm hover:bg-neutral-800 disabled:opacity-50 disabled:hover:bg-transparent ${
        destructive ? "text-red-400" : "text-neutral-100"
      }`}
    >
      {children}
    </button>
  );
}

function Section({ label }: { label: string }) {
  return (
    <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-neutral-500">
      {label}
    </div>
  );
}

function HamburgerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden="true">
      <path d="M3 6h18M3 12h18M3 18h18" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-neutral-500 shrink-0">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

function describeSave(lastSavedAt: number | null): string {
  if (!lastSavedAt) return "Not saved yet";
  return `Saved ${formatRelative(lastSavedAt)}`;
}

function formatRelative(ts: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function StorageBar({ s }: { s: StorageEstimate }) {
  const warn = s.percent > 80;
  const pct = Math.min(100, s.percent);
  return (
    <div className="flex items-center gap-2 shrink-0" title={`${formatBytes(s.usageBytes)} of ${formatBytes(s.quotaBytes)}`}>
      <div className="w-12 h-1.5 rounded bg-neutral-800 overflow-hidden">
        <div
          className={`h-full ${warn ? "bg-red-500" : "bg-[var(--accent)]"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={warn ? "text-red-400" : ""}>
        {formatBytes(s.usageBytes)}
      </span>
    </div>
  );
}
