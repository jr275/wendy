import { useId } from "react";
import type { PresenceState } from "@/lib/concierge";

/**
 * Wendy's presence: an abstract halo — a luminous core, a fine ring, one small point in orbit.
 * Presentation only: it receives a state and knows nothing about the agent. Motion is CSS
 * (transform / opacity only), runs only in the states that need it, and stops entirely under
 * prefers-reduced-motion, where each state still has a distinct still form. Decorative for
 * assistive tech: the state is always also said in words next to it.
 */
const SIZE = { sm: 36, md: 64, lg: 132 } as const;

export function WendyPresence({ state, size = "md", className = "" }: { state: PresenceState; size?: keyof typeof SIZE; className?: string }) {
  const px = SIZE[size];
  // One gradient id PER instance. A shared id makes every orb borrow the first one in the document, and when that
  // first orb sits in a display:none panel (the chat column below lg) the browser cannot resolve it: the core vanishes.
  const core = `presence-core-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <span className={`presence ${className}`} data-presence={state} data-size={size} style={{ width: px, height: px }} aria-hidden>
      <svg viewBox="0 0 120 120" width={px} height={px}>
        <defs>
          <radialGradient id={core} cx="42%" cy="38%" r="70%">
            <stop offset="0%" stopColor="var(--presence-hi)" />
            <stop offset="55%" stopColor="var(--presence-mid)" />
            <stop offset="100%" stopColor="var(--presence-lo)" />
          </radialGradient>
        </defs>
        {/* calling: two soft rings travelling outwards */}
        <g className="p-sonar">
          <circle cx="60" cy="60" r="30" />
          <circle cx="60" cy="60" r="30" />
        </g>
        <circle className="p-ring" cx="60" cy="60" r="44" pathLength={100} />
        {/* planning: four quiet marks on the ring */}
        <g className="p-marks">
          <line x1="60" y1="12" x2="60" y2="18" />
          <line x1="108" y1="60" x2="102" y2="60" />
          <line x1="60" y1="108" x2="60" y2="102" />
          <line x1="12" y1="60" x2="18" y2="60" />
        </g>
        <circle className="p-core" cx="60" cy="60" r="27" fill={`url(#${core})`} />
        {/* connected: a calm three-bar voice line inside the core */}
        <g className="p-wave">
          <rect x="49" y="54" width="4" height="12" rx="2" />
          <rect x="58" y="50" width="4" height="20" rx="2" />
          <rect x="67" y="54" width="4" height="12" rx="2" />
        </g>
        <path className="p-check" d="M49 61 l7 7 l15 -16" pathLength={100} />
        <g className="p-orbit">
          <circle className="p-satellite" cx="60" cy="16" r="4" />
        </g>
      </svg>
    </span>
  );
}
