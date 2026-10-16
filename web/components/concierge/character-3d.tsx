"use client";
import dynamic from "next/dynamic";
import { Component, useState, type ReactNode } from "react";

/**
 * A character's 3D scene (Spline), laid over its 2D portrait. Only mounted when lib/scene3d.ts `shouldLoad3D` says so, and it is loaded on
 * demand (not in the main bundle). The 2D portrait is under it the whole time: while the scene loads, and if it fails, nothing changes for the
 * person. Decorative: hidden from assistive technology (the conversation announces the state in words).
 */
const Spline = dynamic(() => import("@splinetool/react-spline"), { ssr: false, loading: () => null });

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function Character3D({ scene }: { scene: string }) {
  const [ready, setReady] = useState(false);
  return (
    <Boundary>
      <span className="char-3d" data-ready={ready} aria-hidden>
        <Spline scene={scene} onLoad={() => setReady(true)} />
      </span>
    </Boundary>
  );
}
