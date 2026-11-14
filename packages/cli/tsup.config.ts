import { defineConfig } from "tsup";

export default defineConfig([
  // dist/index.js: the npm bin; dependencies stay external.
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    platform: "node",
    target: "node20",
    dts: false,
    clean: false,
    sourcemap: true,
    splitting: false,
  },
  // dist/tidytitles.mjs: one self-contained file with every dependency inlined
  // (shipped by the desktop app and run with ELECTRON_RUN_AS_NODE=1).
  {
    entry: { tidytitles: "src/index.ts" },
    format: ["esm"],
    platform: "node",
    target: "node20",
    dts: false,
    clean: false,
    sourcemap: false,
    splitting: false,
    noExternal: [/.*/],
    outExtension: () => ({ js: ".mjs" }),
    // CommonJS dependencies (picocolors, cli-table3) call require() on Node built-ins.
    banner: {
      js: 'import { createRequire as __tidytitlesCreateRequire } from "node:module"; const require = __tidytitlesCreateRequire(import.meta.url);',
    },
  },
]);
