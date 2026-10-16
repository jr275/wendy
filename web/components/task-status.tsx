import { PHASE_LABEL, PHASE_MEANING, type TaskPhase } from "@/lib/taskStatus";

/**
 * The state of a task: always an icon AND words (never colour alone). Only "Trabalhando" moves, and
 * not under reduced motion. Same component wherever a run is shown, so the same state always looks
 * and reads the same.
 */
const TONE: Record<TaskPhase, string> = {
  queued: "bg-surface-2 text-ink-2",
  running: "bg-info-soft text-info",
  waiting_for_approval: "bg-warn-soft text-warn",
  completed: "bg-accent-soft text-accent-ink",
  failed: "bg-bad-soft text-bad",
  cancelled: "bg-surface-2 text-muted",
};

function Icon({ phase }: { phase: TaskPhase }) {
  const common = { width: 12, height: 12, viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (phase) {
    case "queued":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.2" />
          <path d="M6 3.6V6l1.6 1" />
        </svg>
      );
    case "running":
      return <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-current motion-reduce:animate-none" />;
    case "waiting_for_approval":
      return (
        <svg {...common}>
          <path d="M6 1.8v5.2M6 9.6v.1" />
        </svg>
      );
    case "completed":
      return (
        <svg {...common}>
          <path d="M2.4 6.4l2.4 2.4 4.8-5" />
        </svg>
      );
    case "failed":
      return (
        <svg {...common}>
          <path d="M3 3l6 6M9 3l-6 6" />
        </svg>
      );
    case "cancelled":
      return (
        <svg {...common}>
          <path d="M2.6 6h6.8" />
        </svg>
      );
  }
}

export function TaskStatus({ phase }: { phase: TaskPhase }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-micro ${TONE[phase]}`} title={PHASE_MEANING[phase]}>
      <Icon phase={phase} />
      {PHASE_LABEL[phase]}
    </span>
  );
}
