"use client";
import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether the person wants 3D characters. OFF by default, per device (localStorage, this browser only), because loading a scene contacts a
 * third party. Also reads the two browser signals that must switch it off: reduced motion and "save data".
 */
const KEY = "wendy.char3d.v1";
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const read = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};

export function use3dEnabled(): [boolean, (v: boolean) => void] {
  const on = useSyncExternalStore(subscribe, read, () => false);
  const set = useCallback((v: boolean) => {
    try {
      localStorage.setItem(KEY, v ? "1" : "0");
    } catch {
      /* best effort */
    }
    listeners.forEach((l) => l());
  }, []);
  return [on, set];
}

/** `prefers-reduced-motion: reduce`, live. On the server and before the first read it is "reduced": nothing loads until the browser has answered. */
const subscribeMotion = (fn: () => void) => {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", fn);
  return () => mq.removeEventListener("change", fn);
};
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, () => window.matchMedia("(prefers-reduced-motion: reduce)").matches, () => true);
}

/** The browser's "save data" request. Unknown (server) means "do not load". */
const noSubscription = () => () => {};
export function useSaveData(): boolean {
  return useSyncExternalStore(noSubscription, () => !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData, () => true);
}
