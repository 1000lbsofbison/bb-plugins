// The sidenav's marks.
//
// Colour says exactly two things: blue means "waiting for you", red means
// "failed". Everything else is greyscale; "working" carries motion, not colour.
// The accent blue rather than amber because the product already asks its
// questions in blue, and a permission prompt is the same interruption as a
// factual question — one colour for "you are being asked something". Red stays
// reserved for failure, so the two never have to be told apart by shape alone.
//
// Every row carries one, always — a row without a mark reads as "state unknown"
// rather than "nothing going on". The five are exhaustive by construction: the
// four that report something, and `quiet` for a row with nothing pending, which
// is why that one is a deliberately small dot rather than an absence.
//
// `needs-you` is deliberately the largest mark: it is the only state that stops
// progress until someone acts. `unread` sits below it, the spinner between the
// two, and `quiet` well below all of them.
import { cn } from "@/lib/utils";
import type { ThreadState } from "@/lib/tree";

const LABELS: Readonly<Record<ThreadState, string>> = {
  failed: "Failed",
  "needs-you": "Waiting for you",
  working: "Working",
  unread: "Unread",
  quiet: "Quiet",
};

export function stateLabel(state: ThreadState): string {
  return LABELS[state];
}

/**
 * The mark for a blocked row. Larger than every other mark on purpose — size is
 * the part of the signal that survives peripheral vision, where colour does not.
 * Stays clear of the 14x14 viewport edge so the dot never looks clipped.
 */
export const NEEDS_YOU_RADIUS = 5.6;

/** A row with something new to read, but nothing waiting on an answer. */
export const UNREAD_RADIUS = 4.4;

/** A row with nothing pending. Present, but clearly below the other four. */
export const QUIET_RADIUS = 1.9;

export function StateMark({
  state,
  className,
}: {
  state: ThreadState;
  className?: string;
}) {
  const common = cn("size-3.5 shrink-0", className);
  const title = LABELS[state];
  switch (state) {
    case "working":
      return (
        <svg viewBox="0 0 14 14" fill="none" className={common} role="img" aria-label={title}>
          <title>{title}</title>
          <circle
            cx="7"
            cy="7"
            r="4.6"
            className="origin-center animate-spin text-muted-foreground motion-reduce:animate-none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeDasharray="7.2 4.4"
            style={{ animationDuration: "1.6s" }}
          />
        </svg>
      );
    case "needs-you":
      return (
        <svg viewBox="0 0 14 14" fill="none" className={common} role="img" aria-label={title}>
          <title>{title}</title>
          <circle
            cx="7"
            cy="7"
            r={NEEDS_YOU_RADIUS}
            className="animate-pulse text-[color:var(--primary,#006fee)] motion-reduce:animate-none"
            fill="currentColor"
          />
        </svg>
      );
    case "failed":
      return (
        <svg viewBox="0 0 14 14" fill="none" className={common} role="img" aria-label={title}>
          <title>{title}</title>
          <path
            d="M4 4l6 6M10 4l-6 6"
            className="text-[color:var(--destructive-text,var(--destructive))]"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </svg>
      );
    case "unread":
      return (
        <svg viewBox="0 0 14 14" fill="none" className={common} role="img" aria-label={title}>
          <title>{title}</title>
          <circle
            cx="7"
            cy="7"
            r={UNREAD_RADIUS}
            className="text-foreground/85"
            fill="currentColor"
          />
        </svg>
      );
    case "quiet":
      return (
        <svg viewBox="0 0 14 14" fill="none" className={common} role="img" aria-label={title}>
          <title>{title}</title>
          <circle
            cx="7"
            cy="7"
            r={QUIET_RADIUS}
            className="text-muted-foreground/45"
            fill="currentColor"
          />
        </svg>
      );
  }
}

export function BranchGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" fill="none" className={cn("size-2.5 shrink-0 opacity-70", className)} aria-hidden>
      <g stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="3.5" cy="3" r="1.2" />
        <circle cx="3.5" cy="9" r="1.2" />
        <circle cx="8.5" cy="4.5" r="1.2" />
        <path d="M3.5 4.2v3.6M3.5 7.8c0-2 5-1.4 5-3.3" />
      </g>
    </svg>
  );
}

export function EnvironmentGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" fill="none" className={cn("size-2.5 shrink-0 opacity-70", className)} aria-hidden>
      <rect x="2" y="2.6" width="8" height="6.8" rx="1.4" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function PinGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" fill="none" className={cn("size-2.5 shrink-0", className)} aria-label="Pinned" role="img">
      <path
        d="M6 7.4V11M3.6 2h4.8l-.8 3.2 1.2 1.2H3.2l1.2-1.2z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PlusGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 14 14" fill="none" className={cn("size-3.5", className)} aria-hidden>
      <path d="M7 3v8M3 7h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
