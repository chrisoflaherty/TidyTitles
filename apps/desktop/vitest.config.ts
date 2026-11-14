import { defineConfig } from "vitest/config";

/** Unit tests: main-side logic in Node, renderer components in jsdom (per-file environment comment). */
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/setup.ts"],
  },
});
