/**
 * The plugin's own glyph: three nodes in a vertical flow with a dashed
 * back-edge — a graph that may loop. Matches `assets/icon.svg` (the
 * host-rendered branding icon in the sidebar) stroke for stroke, so the
 * sidebar, the thread panel button, the run banner and the `#` mention rows
 * all show the same mark instead of a generic workflow icon.
 */

interface GlyphProps {
  className?: string;
}

import { GRAPH_STUDIO_ICON } from "../lib/icon";

export { GRAPH_STUDIO_ICON };

export function GraphStudioFlow({ className }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-icon={GRAPH_STUDIO_ICON}
      className={className}
    >
      <circle cx="12" cy="4.5" r="2.4" />
      <circle cx="12" cy="12" r="2.4" />
      <circle cx="12" cy="19.5" r="2.4" />
      <path d="M12 6.9v2.7M12 14.4v2.7" />
      <path
        d="M14.4 12h2.6a2.6 2.6 0 0 1 2.6 2.6v0a2.6 2.6 0 0 1-2.6 2.6h-2.8"
        strokeDasharray="2.5 2"
      />
    </svg>
  );
}
