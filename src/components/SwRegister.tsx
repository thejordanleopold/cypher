"use client";

import { useEffect } from "react";
import { getBasePath } from "@/base-path";

export function SwRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;
    const base = getBasePath();

    navigator.serviceWorker
      .register(`${base}/sw.js`, {
        scope: `${base}/`,
        updateViaCache: "none",
      })
      .catch((error) => {
        console.error("Failed to register the service worker", error);
      });
  }, []);
  return null;
}
