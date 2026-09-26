// bb-plugin-lanes — frontend entry point.
//
// One surface: the board, in the nav. No CLI command — `bb tasks` already
// covers the terminal, and a second verb for the same records would be a
// maintenance burden with no user.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { Board } from "@/components/board";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "lanes",
    title: "Lanes",
    icon: "Columns3",
    path: "lanes",
    component: () => <Board />,
  });
});
