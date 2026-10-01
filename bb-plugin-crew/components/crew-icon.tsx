/**
 * The plugin's own glyph: three nodes in a triangle, each connected to the
 * other two — a team where everyone talks to everyone, as the counterpart to
 * Graph Studio's vertical flow with its dashed back-edge. Matches
 * `assets/icon.svg` (the host-rendered branding icon) stroke for stroke so
 * both surfaces show the same mark.
 */

interface GlyphProps {
  className?: string;
}

export const CREW_ICON = "CrewTeam";

export function CrewTeam({ className }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="12" cy="5" r="2.4" />
      <circle cx="6" cy="18" r="2.4" />
      <circle cx="18" cy="18" r="2.4" />
      <path d="M11 7.2L7 15.8" />
      <path d="M13 7.2L17 15.8" />
      <path d="M8.4 18h7.2" />
    </svg>
  );
}
