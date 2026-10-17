"use client";
import dynamic from "next/dynamic";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { orbPose, ORB_PARTS, WENDY_SKIN, type OrbSkin, type OrbState } from "@/lib/orbPose";

/**
 * The Wendy orb (Spline), laid over the 2D halo. The halo stays under it the whole time: while the scene loads, if it fails, or if the scene does not
 * contain the expected parts. The scene itself is only artwork; every movement is computed here from the REAL state (lib/orbPose.ts) and written onto the
 * named parts once per frame. Hidden from assistive technology (the conversation says the state in words).
 */
const Spline = dynamic(() => import("@splinetool/react-spline"), { ssr: false, loading: () => null });

/** The part of the Spline runtime this component uses. */
interface Obj {
  visible?: boolean;
  scale: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  position: { x: number; y: number; z: number };
}
interface App {
  findObjectByName(name: string): Obj | undefined;
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * `skin` says which scene objects are the orb's parts (the neutral Wendy orb by default; an emotion orb passes its own prefix). `hide` lists scene
 * groups to hide on load: the emotion scene holds eight orbs and only the presenting character's is shown.
 */
export function Orb3D({ scene, state, skin = WENDY_SKIN, hide = [] }: { scene: string; state: OrbState; skin?: OrbSkin; hide?: string[] }) {
  const [ready, setReady] = useState(false);
  // The state the frame loop reads. It is written in an effect (never during render); `since` is when the state last changed.
  const stateRef = useRef<{ state: OrbState; since: number } | null>(null);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    if (stateRef.current?.state !== state) stateRef.current = { state, since: performance.now() };
  }, [state]);
  useEffect(() => () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
  }, []);

  const onLoad = (app: App) => {
    const parts = new Map<string, Obj>();
    for (const part of ORB_PARTS) {
      const o = app.findObjectByName(skin[part]);
      if (o) parts.set(part, o);
    }
    for (const name of hide) {
      const o = app.findObjectByName(name);
      if (o) o.visible = false;
    }
    // A scene that is not the orb (a wrong address) has none of the parts: the halo stays, nothing is shown, nothing is driven.
    if (!parts.has("Orb Core")) return;
    const base = new Map([...parts].map(([n, o]) => [n, { x: o.position.x, ry: o.rotation.y }]));
    const t0 = performance.now();
    const tick = (now: number) => {
      raf.current = document.hidden ? null : requestAnimationFrame(tick);
      if (document.hidden) return;
      const cur = stateRef.current ?? { state: "idle" as OrbState, since: now };
      const { state: s, since } = cur;
      const pose = orbPose(s, (now - t0) / 1000, (now - since) / 1000);
      for (const [name, p] of Object.entries(pose)) {
        const o = parts.get(name);
        if (!o || !p) continue;
        if (p.scale !== undefined) o.scale.x = o.scale.y = o.scale.z = p.scale;
        if (p.rotZ !== undefined) o.rotation.z = p.rotZ;
        if (p.rotY !== undefined) o.rotation.y = (base.get(name)?.ry ?? 0) + p.rotY;
        if (p.posX !== undefined) o.position.x = (base.get(name)?.x ?? 0) + p.posX;
      }
    };
    raf.current = requestAnimationFrame(tick);
    const resume = () => {
      if (!document.hidden && raf.current === null) raf.current = requestAnimationFrame(tick);
    };
    document.addEventListener("visibilitychange", resume);
    setReady(true);
  };

  return (
    <Boundary>
      <span className="char-3d orb-3d" data-ready={ready} aria-hidden>
        <Spline scene={scene} onLoad={onLoad} />
      </span>
    </Boundary>
  );
}
