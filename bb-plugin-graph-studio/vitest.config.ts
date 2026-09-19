import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mirror the `@/*` alias from tsconfig so component tests resolve the
  // vendored UI the same way `bb plugin build` does.
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/setup-plugin-runtime.ts"],
    // Three suites load the whole plugin bundle in `beforeAll`
    // (`loadPluginApp(() => import("../app"))`). With a cold Vite cache that
    // first transform exceeds the 10 s default, and the hook does not fail
    // loudly — it skips 16 tests. A green run that quietly tested nothing is
    // worse than a slow one.
    hookTimeout: 30_000,
  },
});
