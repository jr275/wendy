"use client";
import { useEffect, useRef, useState } from "react";
import { orbScene, resolveCharacter, sceneOf } from "@/lib/characters";
import { shouldLoad3D } from "@/lib/scene3d";
import type { Selection } from "@/lib/mood";
import { Character3D } from "./character-3d";
import { Orb3D } from "./orb-3d";
import type { OrbState } from "@/lib/orbPose";
import { use3dEnabled, useReducedMotion, useSaveData } from "./use-3d-preference";
import { WendyPresence } from "./presence";

/** What Wendy is doing — a separate dimension from the mood. */
export type Interaction = "idle" | "thinking" | "executing" | "awaiting" | "completed" | "error";

/** Pauses CSS animation while the element is off-screen (the CSS reads data-visible). */
function useVisible<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setVisible(!!e?.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, visible] as const;
}

const NEUTRAL_HALO = { idle: "idle", thinking: "thinking", executing: "planning", awaiting: "awaiting", completed: "done", error: "error" } as const;

/**
 * One or two characters beside the conversation, or the neutral halo. Decorative: hidden from
 * assistive technology (the conversation itself announces the state in words). A fixed-size slot, so
 * nothing moves when it changes. Motion is CSS only, paused off-screen, and off with reduced motion.
 * While an approval is pending there is no motion at all: nothing competes with the approval card.
 */
export function EmotionalPresence({ selection, interaction }: { selection: Selection; interaction: Interaction }) {
  const [ref, visible] = useVisible<HTMLSpanElement>();
  const primary = resolveCharacter(selection.primary);
  const secondary = resolveCharacter(selection.secondary);
  const [enabled3d] = use3dEnabled();
  const reducedMotion = useReducedMotion();
  const saveData = useSaveData();
  // The 3D scene replaces nothing: it is laid over the 2D portrait, and only when every condition in lib/scene3d.ts holds.
  const scene = shouldLoad3D({ sceneUrl: sceneOf(primary), enabled: enabled3d, reducedMotion, visible, awaiting: interaction === "awaiting", saveData }) ? sceneOf(primary) : null;
  // With no character presenting, the neutral Wendy orb may replace the halo — same conditions, its own scene address, and the real interaction as its state.
  const orb = !primary && shouldLoad3D({ sceneUrl: orbScene(), enabled: enabled3d, reducedMotion, visible, awaiting: interaction === "awaiting", saveData }) ? orbScene() : null;
  const orbState: OrbState = interaction === "completed" ? "completed" : interaction;
  return (
    <span ref={ref} className="char-slot" data-visible={visible} aria-hidden>
      {primary ? (
        <span className="char" data-interaction={interaction} data-size="primary" style={{ "--char-accent": primary.accent } as React.CSSProperties}>
          {/* eslint-disable-next-line @next/next/no-img-element -- small local avatar; next/image adds nothing here */}
          <img src={primary.src} alt="" width={48} height={48} draggable={false} />
          {scene ? <Character3D scene={scene} /> : null}
        </span>
      ) : (
        <span className="orb-slot">
          <WendyPresence state={NEUTRAL_HALO[interaction]} size="sm" />
          {orb ? <Orb3D scene={orb} state={orbState} /> : null}
        </span>
      )}
      {primary && secondary ? (
        <span className="char" data-interaction="idle" data-size="secondary" style={{ "--char-accent": secondary.accent } as React.CSSProperties}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={secondary.src} alt="" width={28} height={28} draggable={false} />
        </span>
      ) : null}
    </span>
  );
}
