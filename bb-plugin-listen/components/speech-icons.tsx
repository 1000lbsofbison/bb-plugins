/**
 * The handful of glyphs this plugin needs and BB's icon set does not have.
 *
 * BB's registry is a curated subset — it has `Mic`, but no speaker, no cross
 * and no checkmark. Asking for a name it does not know renders the generic
 * plugin fallback, which is how a speaker button ends up looking like a bolt.
 * Drawing them here keeps that decision visible instead of depending on what
 * a future registry happens to include.
 *
 * All four follow the host's icon conventions: 24-unit box, stroke-based,
 * `currentColor`, sized by the caller's class.
 */

interface GlyphProps {
  className?: string;
}

function Svg({ className, children }: GlyphProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

/** A speaker with sound coming out of it: answers are being read aloud. */
export function SpeakerOn({ className }: GlyphProps) {
  return (
    <Svg className={className}>
      <path d="M4 9.5v5h3.2L12 18.5v-13L7.2 9.5H4Z" />
      <path d="M15.5 9.2a4 4 0 0 1 0 5.6" />
      <path d="M18 6.8a7.5 7.5 0 0 1 0 10.4" />
    </Svg>
  );
}

/** The same speaker, struck through: this thread stays quiet. */
export function SpeakerOff({ className }: GlyphProps) {
  return (
    <Svg className={className}>
      <path d="M4 9.5v5h3.2L12 18.5v-13L7.2 9.5H4Z" />
      <path d="M16 10l4 4" />
      <path d="M20 10l-4 4" />
    </Svg>
  );
}

export function Close({ className }: GlyphProps) {
  return (
    <Svg className={className}>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </Svg>
  );
}

export function Check({ className }: GlyphProps) {
  return (
    <Svg className={className}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Svg>
  );
}
