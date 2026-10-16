"use client";
import { createContext, useContext } from "react";

/**
 * Whether actions that need the agent can run, as the SERVER decided (lib/wendy.ts ACTION_UNAVAILABLE_REASON): a
 * sentence when the environment says the agent is off, undefined otherwise ("not known", never "available").
 * It travels as plain presentation text from the server page; the setting itself never reaches the browser. The
 * server action (lib/actions.ts) enforces the same rule, so disabling the controls is not the only protection.
 */
const Ctx = createContext<string | undefined>(undefined);

/** One id for the shared note on pages that list many controls (memories); controls point at it. */
export const ACTIONS_OFF_NOTE_ID = "agent-actions-off";

export function AgentAvailability({ actionReason, children }: { actionReason?: string; children: React.ReactNode }) {
  return <Ctx.Provider value={actionReason}>{children}</Ctx.Provider>;
}

/** The reason actions are unavailable, or undefined (available or not known). */
export function useActionsOffReason(): string | undefined {
  return useContext(Ctx);
}

/** The visible, accessible explanation, rendered only when actions are unavailable. */
export function ActionsOffNote({ id, className = "" }: { id?: string; className?: string }) {
  const reason = useContext(Ctx);
  if (!reason) return null;
  return (
    <p id={id} role="status" className={`rounded-lg bg-info-soft px-3 py-2 text-sm text-info ${className}`}>
      {reason}
    </p>
  );
}
