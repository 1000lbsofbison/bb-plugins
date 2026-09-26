import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mirrors the `@/*` alias from tsconfig so tests resolve exactly the way
  // `bb plugin build` does.
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  // Default `node`, because the SQLite tests open real database files. The
  // render tests opt into jsdom with a `@vitest-environment` docblock.
  test: { include: ["tests/**/*.test.{ts,tsx}"] },
});
