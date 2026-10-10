"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { correct, DEFAULT_PREFS, INITIAL_SELECTOR, parseMood, parsePrefs, selectPresentation, stepSelector, type MoodPrefs, type MoodPresentation, type SelectorState, type Selection } from "@/lib/mood";
import type { Interaction } from "./character-presence";

const KEY = "wendy.mood.v1";

/** The user's preferences live in localStorage; this is the tiny store React reads them from. */
const SERVER_PREFS: MoodPrefs = DEFAULT_PREFS;
const listeners = new Set<() => void>();
let cache: MoodPrefs | null = null;
const subscribePrefs = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
function readPrefs(): MoodPrefs {
  if (cache) return cache;
  try {
    const saved = localStorage.getItem(KEY);
    cache = saved ? parsePrefs(JSON.parse(saved)) : DEFAULT_PREFS;
  } catch {
    cache = DEFAULT_PREFS;
  }
  return cache;
}

/**
 * Turns Wendy's transient mood state (agent state "mood", validated again here) and the user's own
 * preferences into one stabilized selection, plus the interaction state (a separate dimension).
 * Nothing here is stored except the user's preferences, in this browser only.
 */
export function useMoodPresentation(rawMood: unknown, run: { running: boolean; step: string | null; failed: boolean; awaiting?: boolean }) {
  const prefs = useSyncExternalStore(subscribePrefs, readPrefs, () => SERVER_PREFS);
  const [selector, setSelector] = useState<SelectorState>(INITIAL_SELECTOR);
  const [now, setNow] = useState(() => new Date());
  const [finished, setFinished] = useState(false);
  const wasRunning = useRef(false);

  const setPrefs = useCallback((p: MoodPrefs) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(p));
    } catch {
      /* best effort */
    }
    cache = p;
    listeners.forEach((l) => l());
  }, []);

  const reading: MoodPresentation | null = parseMood(rawMood);
  const stamp = reading ? `${reading.updatedAt}|${reading.category}` : "";
  // A new reading is folded in once, during render (the "derive state from props" pattern).
  const [seen, setSeen] = useState("");
  if (stamp !== seen) {
    const at = new Date();
    setSeen(stamp);
    setNow(at);
    setSelector(stepSelector(selector, reading, at));
  }

  // Expiry: when the shown mood runs out, re-evaluate (back to neutral).
  useEffect(() => {
    if (!selector.shown) return;
    const ms = Math.max(0, Date.parse(selector.shown.expiresAt) - Date.now()) + 50;
    const t = setTimeout(() => {
      const at = new Date();
      setNow(at);
      setSelector((s) => stepSelector(s, null, at));
    }, ms);
    return () => clearTimeout(t);
  }, [selector.shown]);

  // "Completed" shows briefly when a run ends without failing.
  useEffect(() => {
    if (wasRunning.current && !run.running && !run.failed) {
      setFinished(true);
      const t = setTimeout(() => setFinished(false), 2500);
      wasRunning.current = false;
      return () => clearTimeout(t);
    }
    wasRunning.current = run.running;
  }, [run.running, run.failed]);

  const selection: Selection = selectPresentation(selector, prefs, now);
  const interaction: Interaction = run.failed ? "error" : run.running ? (run.step === "executando" ? "executing" : "thinking") : run.awaiting ? "awaiting" : finished ? "completed" : "idle";
  const onCorrect = useCallback(() => setSelector(correct(new Date())), []);
  return { selection, interaction, reading, prefs, setPrefs, onCorrect };
}
