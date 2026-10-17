/**
 * The Wendy orb (Spline scene "Orbe Wendy"): how each named part moves in each state. Pure — no browser, no Spline, no clock: a pose is a function of
 * the state, the seconds since the scene started and the seconds since the state last changed. The component (components/concierge/orb-3d.tsx) writes
 * these values onto the scene's objects every frame; nothing here comes from a model or a message, and the motion only ever reflects the REAL state.
 *
 * Part names are the ones authored in the Spline file: Orb Core, Orb Glow, Orb Ring 1/2 (spin on their own tilted axis), Orb Orbit 1/2 (carry a dot
 * around a ring), and Orbe Wendy (the whole group). Rotations are RADIANS (the Spline runtime's unit); scale is absolute.
 */
export type OrbState = "idle" | "listening" | "thinking" | "executing" | "awaiting" | "completed" | "error" | "unavailable";

export const ORB_PARTS = ["Orb Core", "Orb Glow", "Orb Ring 1", "Orb Ring 2", "Orb Orbit 1", "Orb Orbit 2", "Orbe Wendy"] as const;
export type OrbPart = (typeof ORB_PARTS)[number];

export interface PartPose {
  /** Uniform scale. */
  scale?: number;
  /** Rotation around the part's own Z axis (rings, orbits) or Y (the group), in radians. */
  rotZ?: number;
  rotY?: number;
  /** Sideways offset of the whole group (the error shake). */
  posX?: number;
}
export type OrbPose = Partial<Record<OrbPart, PartPose>>;

const TAU = Math.PI * 2;
const breathe = (t: number, speed: number, amp: number, phase = 0) => 1 + amp * Math.sin(t * speed + phase);

/** States with no motion at all: an approval is waiting (nothing competes with it) or Wendy is not available. */
export const STILL_STATES: readonly OrbState[] = ["awaiting", "unavailable"];

export function orbPose(state: OrbState, t: number, sinceChange: number): OrbPose {
  switch (state) {
    case "idle":
      return {
        "Orb Core": { scale: breathe(t, 1.2, 0.02) },
        "Orb Glow": { scale: breathe(t, 1.2, 0.04, 0.5) },
        "Orb Ring 1": { rotZ: (t * 0.15) % TAU },
        "Orb Ring 2": { rotZ: (-t * 0.1) % TAU },
        "Orb Orbit 1": { rotZ: (t * 0.3) % TAU },
        "Orb Orbit 2": { rotZ: (-t * 0.25) % TAU },
      };
    case "listening":
      // Attentive: a quicker, deeper breath and the glow opens up.
      return {
        "Orb Core": { scale: breathe(t, 3, 0.04) },
        "Orb Glow": { scale: 1.06 + 0.07 * Math.sin(t * 3 + 0.4) },
        "Orb Ring 1": { rotZ: (t * 0.12) % TAU },
        "Orb Ring 2": { rotZ: (-t * 0.08) % TAU },
        "Orb Orbit 1": { rotZ: (t * 0.25) % TAU },
        "Orb Orbit 2": { rotZ: (-t * 0.2) % TAU },
      };
    case "thinking":
      return {
        "Orb Core": { scale: breathe(t, 2, 0.03) },
        "Orb Glow": { scale: breathe(t, 2, 0.05, 0.7) },
        "Orb Ring 1": { rotZ: (t * 1.4) % TAU },
        "Orb Ring 2": { rotZ: (-t * 1.1) % TAU },
        "Orb Orbit 1": { rotZ: (t * 1.2) % TAU },
        "Orb Orbit 2": { rotZ: (-t * 1.0) % TAU },
      };
    case "executing":
      // Working: the dots race around their rings.
      return {
        "Orb Core": { scale: 1.02 },
        "Orb Glow": { scale: 1.06 },
        "Orb Ring 1": { rotZ: (t * 0.9) % TAU },
        "Orb Ring 2": { rotZ: (-t * 0.7) % TAU },
        "Orb Orbit 1": { rotZ: (t * 3.2) % TAU },
        "Orb Orbit 2": { rotZ: (-t * 2.6) % TAU },
      };
    case "completed": {
      // Answering: a pulse with a speech-like cadence (squared so it has rests between beats).
      const beat = Math.pow(0.5 + 0.5 * Math.sin(t * 5), 2);
      return {
        "Orb Core": { scale: 1 + 0.06 * beat },
        "Orb Glow": { scale: 1.03 + 0.1 * beat },
        "Orb Ring 1": { rotZ: (t * 0.3) % TAU },
        "Orb Ring 2": { rotZ: (-t * 0.2) % TAU },
        "Orb Orbit 1": { rotZ: (t * 0.6) % TAU },
        "Orb Orbit 2": { rotZ: (-t * 0.5) % TAU },
      };
    }
    case "error": {
      // A short shake that dies out, then the orb sits a little smaller with its rings stopped. Not a loop: an error is not a rhythm.
      const tau = Math.max(0, sinceChange);
      return {
        "Orbe Wendy": { posX: 10 * Math.exp(-3 * tau) * Math.sin(tau * 38) },
        "Orb Core": { scale: 0.97 },
        "Orb Glow": { scale: 0.96 },
        "Orb Ring 1": { rotZ: 0 },
        "Orb Ring 2": { rotZ: 0 },
        "Orb Orbit 1": { rotZ: 0 },
        "Orb Orbit 2": { rotZ: 0 },
      };
    }
    case "awaiting":
      return { "Orb Core": { scale: 1 }, "Orb Glow": { scale: 1.02 }, "Orbe Wendy": { posX: 0 } };
    case "unavailable":
      return { "Orb Core": { scale: 0.94 }, "Orb Glow": { scale: 0.88 }, "Orbe Wendy": { posX: 0 } };
  }
}

export const isStill = (s: OrbState): boolean => STILL_STATES.includes(s);

/**
 * Which scene object each logical part is. The neutral Wendy orb uses the names authored as "Orb Core"… and "Orbe Wendy". The emotion scene holds eight
 * orbs, one group per character, with the character's name as prefix ("Joy Core", "Joy Ring 1"…, and the group itself "Joy").
 */
export type OrbSkin = Record<OrbPart, string>;
export const WENDY_SKIN: OrbSkin = Object.fromEntries(ORB_PARTS.map((p) => [p, p])) as OrbSkin;
export function emotionSkin(label: string): OrbSkin {
  return {
    "Orb Core": `${label} Core`,
    "Orb Glow": `${label} Glow`,
    "Orb Ring 1": `${label} Ring 1`,
    "Orb Ring 2": `${label} Ring 2`,
    "Orb Orbit 1": `${label} Orbit 1`,
    "Orb Orbit 2": `${label} Orbit 2`,
    "Orbe Wendy": label,
  };
}
