// bb-plugin-aside — frontend entry point.
//
// Exactly one surface: the replacement for bb's thread list in the sidenav.
// Enable it under Settings → Appearance → Sidebar.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { Sidenav } from "@/components/sidenav/sidenav";

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "aside",
    title: "Aside (Projects)",
    description:
      "Projects, sections and threads — sortable, collapsible, without filters.",
    component: Sidenav,
  });
});
