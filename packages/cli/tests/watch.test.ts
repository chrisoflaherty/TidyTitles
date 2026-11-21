/**
 * `watch` in-process, with fake providers, real files in a temp folder, and
 * no file-system events (the watcher rescans every 100 ms instead).
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { nodeWatchFileSystem, type WatchFileSystem } from "@tidytitles/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/program";
import type { WatchOverrides } from "../src/commands/watch";
import {
  FakeMovieProvider,
  FakePrompter,
  MATRIX_FILE,
  OutputBuffer,
  createSandbox,
  matrix,
  matrixReloaded,
  strip,
  touch,
  writeKeys,
  type Sandbox,
} from "./helpers";

const noEvents: WatchFileSystem = { ...nodeWatchFileSystem, watch: () => ({ close() {} }) };
const FAST: WatchOverrides = { fs: noEvents, rescanMs: 100, pollingRescanMs: 100, checkMs: 50, gatherMs: 20, settleMs: 300 };

let sb: Sandbox;

beforeEach(async () => {
  sb = await createSandbox();
  await writeKeys(sb.configDir, { tmdb: "tmdb-secret-key", tvdb: "tvdb-secret-key" });
});

afterEach(async () => {
  await sb.cleanup();
});

interface Running {
  stdout: OutputBuffer;
  stderr: OutputBuffer;
  stop(): Promise<number>;
  waitFor(text: string | RegExp, timeoutMs?: number): Promise<void>;
}

function start(args: string[], movies = new FakeMovieProvider({ "The Matrix": [matrix], Inception: [matrixReloaded] })): Running {
  const stdout = new OutputBuffer();
  const stderr = new OutputBuffer();
  const abort = new AbortController();
  const prompter = new FakePrompter();
  const done = runCli(["watch", ...args, "--config-dir", sb.configDir], {
    stdout,
    stderr,
    prompter,
    env: {},
    signal: abort.signal,
    session: { providers: { movieProvider: movies } },
    watch: FAST,
  });
  return {
    stdout,
    stderr,
    async stop() {
      abort.abort();
      const code = await done;
      expect(prompter.calls).toEqual([]); // never prompts
      return code;
    },
    async waitFor(text, timeoutMs = 8_000) {
      const deadline = Date.now() + timeoutMs;
      const has = () => (typeof text === "string" ? strip(stdout.text).includes(text) : text.test(strip(stdout.text)));
      while (!has()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${String(text)}:\n${stdout.text}\n${stderr.text}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
}

describe("watch", () => {
  it("reports new files in review mode and renames nothing", async () => {
    const run = start([sb.media]);
    await run.waitFor("Watching");
    await touch(sb.media, MATRIX_FILE);
    await run.waitFor("Ready for review");
    expect(await run.stop()).toBe(0);
    const out = strip(run.stdout.text);
    expect(out).toContain(`New file: ${MATRIX_FILE}`);
    expect(out).toContain(`Ready for review: ${MATRIX_FILE} → The Matrix (1999).mkv`);
    expect(out).toMatch(/^\d{1,2}:\d{2}:\d{2} (AM|PM) {2}/m);
    expect(await readdir(sb.media)).toEqual([MATRIX_FILE]);
    expect(strip(run.stderr.text)).toContain("tidytitles rename <folder>");
    expect(strip(run.stderr.text)).toContain("Stopped watching. Renamed: 0, waiting for review: 1");
  });

  it("renames unambiguous files with --auto and leaves ambiguous ones", async () => {
    await touch(sb.media, "Already.Here.2001.mkv");
    const run = start([sb.media, "--auto"], new FakeMovieProvider({ "The Matrix": [matrix], Inception: [matrix, matrixReloaded] }));
    await run.waitFor("Watching");
    await touch(sb.media, MATRIX_FILE);
    await touch(sb.media, "Inception.2010.mkv");
    await run.waitFor("Renamed:");
    await run.waitFor("Needs review");
    expect(await run.stop()).toBe(0);
    const out = strip(run.stdout.text);
    expect(out).toContain("1 media file(s) already there left alone");
    expect(out).toContain("Needs review: Inception.2010.mkv (several matches found; choose one)");
    expect((await readdir(sb.media)).sort()).toEqual(["Already.Here.2001.mkv", "Inception.2010.mkv", "The Matrix (1999).mkv"]);
  });

  it("prints one JSON object per line with --json", async () => {
    const run = start([sb.media, "--auto", "--json"]);
    await run.waitFor('"event":"started"');
    await touch(sb.media, MATRIX_FILE);
    await run.waitFor('"event":"renamed"');
    await run.stop();
    const lines = run.stdout.text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const kinds = lines.map((l) => l.event);
    expect(kinds[0]).toBe("started");
    expect(kinds).toEqual(expect.arrayContaining(["arriving", "ready", "looking_up", "renamed", "history_saved", "summary"]));
    const renamed = lines.find((l) => l.event === "renamed")!;
    expect(renamed).toMatchObject({ path: path.join(sb.media, MATRIX_FILE), destination: path.join(sb.media, "The Matrix (1999).mkv") });
    expect(lines.at(-1)).toMatchObject({ event: "summary", renamed: 1, review: 0 });
  });

  it("processes files already there with --existing", async () => {
    await touch(sb.media, MATRIX_FILE);
    const run = start([sb.media, "--auto", "--existing"]);
    await run.waitFor("Renamed:");
    await run.stop();
    expect(await readdir(sb.media)).toEqual(["The Matrix (1999).mkv"]);
  });

  it("uses the [watch] folders when none are named, and says when there are none", async () => {
    const none = start([]);
    expect(await none.stop()).toBe(2);
    expect(strip(none.stderr.text)).toContain("Name a folder to watch");

    await writeKeys(sb.configDir, { tmdb: "k" }, `[watch]\nfolders = [${JSON.stringify(sb.media)}]\n`);
    const run = start([]);
    await run.waitFor(`Watching ${sb.media}`);
    await run.stop();
  });

  it("rejects a folder that does not exist (exit 2)", async () => {
    const run = start([path.join(sb.root, "nope")]);
    expect(await run.stop()).toBe(2);
    expect(strip(run.stderr.text)).toContain("does not exist");
  });

  it("needs API keys for movie and TV lookups (exit 1)", async () => {
    await writeKeys(sb.configDir, {});
    const run = start([sb.media]);
    expect(await run.stop()).toBe(1);
    expect(strip(run.stderr.text)).toContain("No API keys configured");
  });
});
