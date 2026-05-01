"use client";

import { useEffect, useRef, useState } from "react";
import { useCypher } from "@/state/store";
import { estimateStorage, type StorageEstimate } from "@/persistence/db";

export function LibraryMenu() {
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
    deleteCurrentProject,
    saveNow,
  } = useCypher();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(currentProjectName);
  const [storage, setStorage] = useState<StorageEstimate | null>(null);
  const [tick, setTick] = useState(0);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    refreshProjects();
    estimateStorage().then(setStorage).catch(() => setStorage(null));
  }, [open, refreshProjects]);

  // Re-render the "saved 5s ago" relative timestamp.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => clearInterval(id);
  }, [open]);

  useEffect(() => {
    setDraftName(currentProjectName);
  }, [currentProjectName]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="relative" ref={popoverRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="h-9 px-4 rounded-md bg-neutral-800 text-neutral-100 text-sm font-medium active:scale-95"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Library
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 w-72 bg-neutral-900 border border-neutral-700 rounded-md shadow-xl overflow-hidden">
          <div className="px-3 py-2 border-b border-neutral-800">
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
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  className="flex-1 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-sm"
                />
                <button
                  type="submit"
                  className="text-emerald-400 text-xs font-semibold"
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
                className="w-full text-left text-sm text-neutral-100 truncate hover:text-emerald-400"
                title="Rename"
              >
                {currentProjectName} ✏︎
              </button>
            )}
          </div>

          <div className="px-1 py-1">
            <MenuButton
              label="Save now"
              onClick={async () => {
                await saveNow();
              }}
            />
            <MenuButton
              label="New project"
              onClick={async () => {
                setOpen(false);
                await createProject("Untitled");
              }}
            />
            <MenuButton
              label="Save as new project…"
              onClick={async () => {
                const name = window.prompt(
                  "Name for the duplicated project",
                  `${currentProjectName} copy`,
                );
                if (!name) return;
                setOpen(false);
                await saveProjectAs(name.trim() || "Untitled");
              }}
            />
            <MenuButton
              label="Delete this project"
              destructive
              onClick={async () => {
                if (!window.confirm(`Delete "${currentProjectName}"? This cannot be undone.`))
                  return;
                setOpen(false);
                await deleteCurrentProject();
              }}
            />
          </div>

          <div className="border-t border-neutral-800 px-3 py-2 text-[10px] text-neutral-500 flex items-center justify-between gap-2">
            <span>{describeSave(lastSavedAt, tick)}</span>
            {storage && <StorageBar s={storage} />}
          </div>

          <div className="border-t border-neutral-800 max-h-64 overflow-y-auto">
            <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-neutral-500">
              Open project
            </div>
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
                    setOpen(false);
                    if (!isCurrent) await openProject(p.id);
                  }}
                  className={`block w-full text-left px-3 py-2 text-sm hover:bg-neutral-800 ${
                    isCurrent ? "text-emerald-400" : "text-neutral-100"
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
        </div>
      )}
    </div>
  );
}

function MenuButton({
  label,
  onClick,
  destructive,
}: {
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`block w-full text-left px-3 py-2 rounded text-sm hover:bg-neutral-800 ${
        destructive ? "text-red-400" : "text-neutral-100"
      }`}
    >
      {label}
    </button>
  );
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

function describeSave(lastSavedAt: number | null, _tick: number): string {
  if (!lastSavedAt) return "Not saved yet";
  return `Saved ${formatRelative(lastSavedAt)}`;
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
      <div className="w-16 h-1.5 rounded bg-neutral-800 overflow-hidden">
        <div
          className={`h-full ${warn ? "bg-red-500" : "bg-emerald-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={warn ? "text-red-400" : ""}>
        {formatBytes(s.usageBytes)}
      </span>
    </div>
  );
}
