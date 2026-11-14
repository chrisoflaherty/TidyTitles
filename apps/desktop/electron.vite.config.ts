/**
 * electron-vite build for main, preload, and renderer.
 *
 * `--mode e2e` builds the test-only app into `out-e2e/`: its main entry is
 * `src/e2e/main.ts`, which injects fake providers. The production build
 * (`out/`, the only directory electron-builder packages) never includes it.
 */

import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

/**
 * The renderer's Content-Security-Policy. The dev server needs inline scripts
 * (React Refresh preamble) and a websocket for HMR, so only `serve` relaxes it.
 */
const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ");

const DEV_CSP = PROD_CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
  .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
  .replace("connect-src 'self'", "connect-src 'self' ws://localhost:* http://localhost:*");

function cspPlugin(): Plugin {
  return {
    name: "tidytitles-csp",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const csp = ctx.server ? DEV_CSP : PROD_CSP;
        return html.replace("%CONTENT_SECURITY_POLICY%", csp);
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const e2e = mode === "e2e";
  const outRoot = e2e ? "out-e2e" : "out";
  return {
    main: {
      build: {
        outDir: `${outRoot}/main`,
        // Bundle @tidytitles/core and its dependencies (music-metadata,
        // smol-toml, zod) into the main bundle, so the packaged app needs no
        // node_modules.
        externalizeDeps: false,
        rolldownOptions: {
          input: { index: resolve(import.meta.dirname, e2e ? "src/e2e/main.ts" : "src/main/index.ts") },
        },
        sourcemap: true,
      },
    },
    preload: {
      build: {
        outDir: `${outRoot}/preload`,
        externalizeDeps: false,
        rolldownOptions: {
          input: { index: resolve(import.meta.dirname, "src/preload/index.ts") },
          // Sandboxed preloads must be CommonJS.
          output: { format: "cjs", entryFileNames: "[name].cjs" },
        },
      },
    },
    renderer: {
      root: resolve(import.meta.dirname, "src/renderer"),
      plugins: [react(), cspPlugin()],
      build: {
        outDir: resolve(import.meta.dirname, `${outRoot}/renderer`),
        rolldownOptions: {
          input: { index: resolve(import.meta.dirname, "src/renderer/index.html") },
        },
      },
    },
  };
});
