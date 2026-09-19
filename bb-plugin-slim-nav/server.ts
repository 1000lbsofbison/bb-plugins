// bb-plugin-slim-nav — backend entry.
//
// The navigation itself is pure frontend: app.tsx renders BB's own navigation
// component inside a scoped wrapper and restyles it. The server exists only to
// declare the two appearance settings, so their values reach the frontend
// through `useSettings()`.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Button edge length in px per density, used by app.tsx. */
export const DENSITY_SIZES = { compact: 28, cozy: 34, roomy: 40 } as const;
export type Density = keyof typeof DENSITY_SIZES;

export default function slimNav(bb: BbPluginApi) {
  bb.settings.define({
    density: {
      type: "select",
      label: "Icon density",
      description:
        "Button size for the sidebar icons. Touch devices always use the roomy size.",
      options: Object.keys(DENSITY_SIZES),
      default: "compact",
    },
    hideDivider: {
      type: "boolean",
      label: "Hide the divider below navigation",
      description: "Removes the separator between navigation and the thread list.",
      default: true,
    },
  });
}
