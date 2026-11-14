import { defineConfig } from "vitest/config";

/** End-to-end tests: drive the built `out-e2e/` app with Playwright. Run with `npm run test:e2e`. */
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 90_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
