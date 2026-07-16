"use client";

import { useCypher } from "@/state/store";

export function Toaster() {
  const toasts = useCypher((s) => s.toasts);
  const dismiss = useCypher((s) => s.dismissToast);

  return (
    <div
      role="region"
      aria-label="Notifications"
      className="fixed left-3 right-3 bottom-3 z-50 flex flex-col gap-2 pointer-events-none sm:left-auto sm:right-4 sm:bottom-4 sm:max-w-sm"
    >
      {toasts.map((t) => {
        const accent =
          t.variant === "error"
            ? "border-red-700 bg-red-950/90 text-red-100"
            : t.variant === "warn"
            ? "border-amber-700 bg-amber-950/90 text-amber-100"
            : "border-neutral-700 bg-neutral-900/95 text-neutral-100";
        return (
          <div
            key={t.id}
            role={t.variant === "info" ? "status" : "alert"}
            className={`pointer-events-auto rounded-lg border ${accent} backdrop-blur shadow-lg p-3 flex items-start gap-3`}
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold">{t.title}</div>
              {t.message && (
                <div className="text-xs text-neutral-300 mt-0.5 leading-snug">
                  {t.message}
                </div>
              )}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              className="text-neutral-500 hover:text-neutral-200 active:scale-95 shrink-0 -mr-1 p-1"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden="true">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
