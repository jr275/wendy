"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ConversationItem } from "@/lib/conversation";
import { DEFAULT_VOICE_PREFS, parseVoicePrefs } from "@/lib/speech/prefs";
import { decideReply } from "@/lib/speech/reply";
import { VoiceSession } from "@/lib/speech/session";
import { INITIAL_VOICE_STATE } from "@/lib/speech/machine";
import type { VoiceInfo, VoiceMachineState, VoicePreferences } from "@/lib/speech/types";
import { createWebSpeechRecognition, createWebSpeechSynthesis, type SpeechWindow } from "@/lib/speech/webSpeech";

/**
 * Connects the voice session to the conversation that is already on screen — the same thread "main", the same agent, the same `send` the
 * keyboard uses. Voice adds NO second conversation, memory or agent: a transcript is just a message the person reviewed and sent.
 *
 *  - Wendy's answer is spoken only for a turn the person started BY VOICE, and only the answer to that message (never the history).
 *  - Approvals are untouched: nothing is approved by voice; the person still decides on the card (or by a message they sent after review).
 */
const KEY = "wendy.voice.v1";
const listeners = new Set<() => void>();
let cache: VoicePreferences | null = null;
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
function readPrefs(): VoicePreferences {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = raw ? parseVoicePrefs(JSON.parse(raw)) : DEFAULT_VOICE_PREFS;
  } catch {
    cache = DEFAULT_VOICE_PREFS;
  }
  return cache;
}
function writePrefs(p: VoicePreferences) {
  cache = p;
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* best effort */
  }
  listeners.forEach((l) => l());
}
const SERVER_PREFS = DEFAULT_VOICE_PREFS;

export interface VoiceConversationArgs {
  /** The conversation's send. Resolves true when it started and finished a run, false when it refused (a run is already going). */
  send: (text: string, opts?: { id?: string }) => Promise<boolean>;
  /** Stop the current run (the conversation's Stop). */
  stopRun: () => void;
  items: ConversationItem[];
  error: string | null;
  running: boolean;
  getText: () => string;
  setText: (t: string) => void;
}

export function useVoiceConversation(a: VoiceConversationArgs) {
  const prefs = useSyncExternalStore(subscribe, readPrefs, () => SERVER_PREFS);
  const [state, setState] = useState<VoiceMachineState>(INITIAL_VOICE_STATE);
  const [supported, setSupported] = useState<boolean | null>(null); // null until the browser has been asked
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [askConsent, setAskConsent] = useState(false);
  const session = useRef<VoiceSession | null>(null);
  const prefsRef = useRef(prefs);
  const argsRef = useRef(a);
  const turn = useRef<{ turn: number; userId: string; done: boolean } | null>(null);
  const mirrored = useRef("");

  useEffect(() => {
    prefsRef.current = prefs;
    argsRef.current = a;
  });

  // Reading aloud for a turn: once the run is over, find the answer to THAT message.
  const check = useCallback(() => {
    const t = turn.current;
    const s = session.current;
    if (!t || !s || s.snapshot.kind !== "THINKING" || s.snapshot.turn !== t.turn) return;
    const { items, error, running } = argsRef.current;
    const d = decideReply({ items, userId: t.userId, error, running, runDone: t.done });
    if (d.do === "wait") return;
    turn.current = null;
    if (d.do === "failed") s.dispatch({ type: "REPLY_FAILED", turn: t.turn });
    else s.dispatch({ type: "REPLY", turn: t.turn, text: d.text });
  }, []);

  useEffect(() => {
    const win = window as unknown as SpeechWindow;
    const recognition = createWebSpeechRecognition(win);
    const synthesis = createWebSpeechSynthesis(win);
    const s = new VoiceSession({
      recognition,
      synthesis,
      prefs: () => prefsRef.current,
      submit: (text, n) => {
        const userId = crypto.randomUUID();
        turn.current = { turn: n, userId, done: false };
        void argsRef.current.send(text, { id: userId }).then((ok) => {
          if (!ok) {
            turn.current = null;
            s.dispatch({ type: "REPLY_FAILED", turn: n });
            return;
          }
          if (turn.current?.turn === n) turn.current.done = true;
          check();
        });
      },
      cancelTurn: () => {
        turn.current = null;
        argsRef.current.stopRun();
      },
      onChange: setState,
    });
    session.current = s;
    // Feature detection is the only thing done at mount: the microphone is not touched until the person presses the button.
    const ok = recognition.availability().ok;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of what this browser offers
    setSupported(ok);
    const load = () => setVoices(synthesis.voices());
    load();
    const synthTarget = win.speechSynthesis as unknown as EventTarget | undefined;
    if (synthTarget && typeof synthTarget.addEventListener === "function") synthTarget.addEventListener("voiceschanged", load);
    return () => {
      if (synthTarget && typeof synthTarget.removeEventListener === "function") synthTarget.removeEventListener("voiceschanged", load);
      s.dispose();
      session.current = null;
    };
  }, [check]);

  // The preferences that change behaviour are pushed to the machine (e.g. reading aloud off stops her at once).
  useEffect(() => {
    session.current?.setPrefs();
  }, [prefs.speakReplies, prefs.autoSend]);

  // The conversation moved on (answer arrived, run ended, failure): see whether the spoken turn can be answered.
  useEffect(() => {
    check();
  }, [a.items, a.error, a.running, check]);

  // The transcript is placed in the composer (editable); a discarded one is taken back out.
  useEffect(() => {
    const { getText, setText } = argsRef.current;
    if (state.kind === "TRANSCRIBING" && state.transcript !== mirrored.current) {
      mirrored.current = state.transcript;
      setText(state.transcript);
    } else if (state.kind === "IDLE" && mirrored.current) {
      if (getText() === mirrored.current) setText("");
      mirrored.current = "";
    }
  }, [state.kind, state.transcript]);

  const press = useCallback(() => {
    if (!prefsRef.current.consented) return setAskConsent(true);
    session.current?.pressMic();
  }, []);
  const consent = useCallback(() => {
    writePrefs({ ...prefsRef.current, consented: true });
    setAskConsent(false);
    // The press that asked for consent continues now that it is given.
    requestAnimationFrame(() => session.current?.pressMic());
  }, []);
  const decline = useCallback(() => setAskConsent(false), []);
  const cancel = useCallback(() => session.current?.dispatch({ type: "CANCEL" }), []);
  const reset = useCallback(() => session.current?.dispatch({ type: "RESET" }), []);
  /** The composer's text changed by typing while a transcript is being reviewed. */
  const edited = useCallback((text: string) => {
    if (session.current?.snapshot.kind === "TRANSCRIBING") {
      mirrored.current = text;
      session.current.dispatch({ type: "TRANSCRIPT_EDITED", text });
    }
  }, []);
  /** The composer was submitted. Returns true when voice took it (a reviewed transcript), false when it is an ordinary typed message. */
  const submitReviewed = useCallback((text: string): boolean => {
    const s = session.current;
    if (!s || s.snapshot.kind !== "TRANSCRIBING") return false;
    s.dispatch({ type: "TRANSCRIPT_EDITED", text });
    s.dispatch({ type: "SEND" });
    mirrored.current = "";
    return true;
  }, []);
  const setPrefs = useCallback((p: Partial<VoicePreferences>) => writePrefs(parseVoicePrefs({ ...prefsRef.current, ...p })), []);

  return { state, supported, prefs, voices, askConsent, press, consent, decline, cancel, reset, edited, submitReviewed, setPrefs };
}
