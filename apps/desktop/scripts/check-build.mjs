// Fails the production build if test-only code reached `out/`, or if the
// renderer's Content-Security-Policy was not filled in.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "out");
const forbidden = [
  "TIDYTITLES_E2E_FAKE_PROVIDERS",
  "FakeMovieProvider",
  "createFakeSessionOverrides",
  "ScriptedUpdateEngine",
  "__tidytitlesFakeUpdates",
  "__tidytitlesE2eFeedback",
];
const problems = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(c?js|mjs|html)$/.test(name)) {
      const text = readFileSync(full, "utf8");
      for (const word of forbidden) {
        if (text.includes(word)) problems.push(`${path.relative(root, full)} contains test-only code (${word})`);
      }
    }
  }
}

walk(root);

const html = readFileSync(path.join(root, "renderer", "index.html"), "utf8");
if (!html.includes("Content-Security-Policy") || html.includes("%CONTENT_SECURITY_POLICY%") || html.includes("unsafe-inline")) {
  problems.push("renderer/index.html does not carry the strict Content-Security-Policy");
}

// The update feed is fixed at build time; only `--mode update-test` sets a local one.
const mainBundle = readFileSync(path.join(root, "main", "index.js"), "utf8");
if (/http:\/\/(127\.0\.0\.1|localhost):\d+/.test(mainBundle) || mainBundle.includes("Local update test: stay out")) {
  problems.push("main/index.js contains the local update test feed or folder (built with --mode update-test?)");
}

// The renderer must not bundle core or Node built-ins (core runs in main only).
for (const name of readdirSync(path.join(root, "renderer", "assets"))) {
  if (!name.endsWith(".js")) continue;
  const text = readFileSync(path.join(root, "renderer", "assets", name), "utf8");
  if (/["']node:[a-z]/.test(text)) problems.push(`renderer/assets/${name} imports a Node built-in`);
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("check-build: out/ has no test-only code, no test update feed, and a strict CSP");
