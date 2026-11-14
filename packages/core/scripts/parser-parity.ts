/**
 * Parser parity check: runs the Python GuessItParser (real guessit) and the
 * TypeScript GuessItParser over scripts/parser-corpus.txt and reports
 * per-field agreement plus every disagreement.
 *
 * Usage (from packages/core):
 *   npx tsx scripts/parser-parity.ts [--corpus FILE] [--fields a,b] [--json OUT]
 *
 * Requires python3 with guessit installed. The Python source is found at
 * ../../src relative to this package (override with TIDYTITLES_PY_SRC).
 * --json writes the guessit results to OUT for building test fixtures.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GuessItParser } from "../src/parser";
import type { ParsedInfo } from "../src/models";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argValue = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

const corpusPath = argValue("--corpus") ?? path.join(here, "parser-corpus.txt");
const pySrc = process.env.TIDYTITLES_PY_SRC ?? path.resolve(here, "../../../src");
const jsonOut = argValue("--json");

const FIELDS = [
  "mediaType",
  "title",
  "year",
  "season",
  "episode",
  "episodeTitle",
  "quality",
  "source",
  "codec",
  "group",
] as const;
type Field = (typeof FIELDS)[number];
const KEY_FIELDS: readonly Field[] = ["mediaType", "title", "year", "season", "episode"];

const fields: Field[] = argValue("--fields")
  ? (argValue("--fields")!.split(",") as Field[])
  : [...FIELDS];

const names = readFileSync(corpusPath, "utf8")
  .split("\n")
  .map((line) => line.replace(/\r$/, ""))
  .filter((line) => line.trim() && !line.startsWith("#"));

const output = execFileSync("python3", [path.join(here, "guessit-dump.py")], {
  input: names.join("\n") + "\n",
  env: { ...process.env, PYTHONPATH: pySrc },
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const expected = output
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as Record<string, unknown>);

if (expected.length !== names.length) {
  throw new Error(`guessit returned ${expected.length} rows for ${names.length} names`);
}

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(expected, null, 2) + "\n");
}

const parser = new GuessItParser();
const agree: Record<string, number> = {};
const disagreements: string[] = [];
let allKeyAgree = 0;
const fmt = (v: unknown): string => (v === undefined || v === null ? "-" : JSON.stringify(v));

names.forEach((name, i) => {
  const py = expected[i]!;
  const ts = parser.parse(name) as unknown as Record<string, unknown>;
  const diffs: string[] = [];
  let keyOk = true;
  for (const field of fields) {
    const a = py[field] ?? undefined;
    const b = (ts as Partial<ParsedInfo> & Record<string, unknown>)[field] ?? undefined;
    if (a === b) {
      agree[field] = (agree[field] ?? 0) + 1;
    } else {
      diffs.push(`    ${field.padEnd(12)} guessit=${fmt(a)}  ts=${fmt(b)}`);
      if (KEY_FIELDS.includes(field)) keyOk = false;
    }
  }
  if (keyOk) allKeyAgree++;
  if (diffs.length) disagreements.push(`  ${name}\n${diffs.join("\n")}`);
});

const total = names.length;
const pct = (count: number): string => `${((100 * count) / total).toFixed(1)}%`;

console.log(`Disagreements (${disagreements.length} filenames):`);
console.log(disagreements.join("\n") || "  none");
console.log("");
console.log(`Per-field agreement over ${total} filenames:`);
for (const field of fields) {
  const count = agree[field] ?? 0;
  console.log(`  ${field.padEnd(12)} ${String(count).padStart(4)}/${total}  ${pct(count)}`);
}
console.log(
  `  ${"key fields".padEnd(12)} ${String(allKeyAgree).padStart(4)}/${total}  ${pct(allKeyAgree)}  (mediaType, title, year, season, episode all agree)`,
);
