"use client";
import { useSyncExternalStore } from "react";

const noop = () => () => {};
/** true in the browser after hydration, false during server rendering (hydration-safe). */
export function useIsClient(): boolean {
  return useSyncExternalStore(noop, () => true, () => false);
}
