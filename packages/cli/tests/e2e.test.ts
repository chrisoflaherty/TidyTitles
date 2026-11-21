/**
 * End-to-end: spawn the built CLI (dist/index.js and the self-contained
 * dist/tidytitles.mjs) against temp config directories. No network calls:
 * nothing here reaches a lookup that would use a real provider.
 */

import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConfigService,
  RenameSession,
  createArtist,
  createDefaultSettings,
  createRenameOperation,
  createTrack,
} from "@tidytitles/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MATRIX_FILE, touch, writeKeys } from "./helpers";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(pkgDir, "dist");
// Run tsup through Node (not the node_modules/.bin shim, which is a shell
// script on POSIX and a .cmd file on Windows).
const tsup = path.resolve(pkgDir, "../../node_modules/tsup/dist/cli-default.js");

let tmp: string;

beforeAll(async () => {
  // Build from the current sources so these tests never run a stale bundle.
  execFileSync(process.execPath, [tsup], { cwd: pkgDir, stdio: "pipe" });
  tmp = await mkdtemp(path.join(os.tmpdir(), "tidytitles-e2e-"));
}, 60_000);

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** The environment without anything that could point at real settings. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toUpperCase().startsWith("FILE_RENAMER_") || k === "TIDYTITLES_CONFIG_DIR") continue;
    if (k === "FORCE_COLOR" || k === "DEBUG") continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

interface Spawned {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runBin(
  file: string,
  args: string[],
  options: {
    input?: string;
    cwd?: string;
    env?: Record<string, string>;
    /** Called with the child once `stderr` contains `waitFor`. */
    onStderr?: { waitFor: string; then: (child: ReturnType<typeof spawn>) => void };
  } = {},
): Promise<Spawned> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], {
      cwd: options.cwd ?? tmp,
      env: cleanEnv(options.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let triggered = false;
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (options.onStderr && !triggered && stderr.includes(options.onStderr.waitFor)) {
        triggered = true;
        options.onStderr.then(child);
      }
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    if (options.input !== undefined) child.stdin.end(options.input);
    else if (!options.onStderr) child.stdin.end();
  });
}

const binaries = [
  ["dist/index.js", () => path.join(dist, "index.js")],
  ["dist/tidytitles.mjs", () => path.join(dist, "tidytitles.mjs")],
] as const;

describe.each(binaries)("%s", (_name, bin) => {
  let n = 0;
  const freshDir = () => path.join(tmp, `cfg-${_name.replace(/\W/g, "")}-${++n}`);

  it("--help and --version", async () => {
    const help = await runBin(bin(), ["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: tidytitles");
    expect(help.stdout).toContain("rename");
    const version = await runBin(bin(), ["--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("config set-key, then config show masks the key", async () => {
    const dir = freshDir();
    const set = await runBin(bin(), ["config", "set-key", "tmdb", "E2E-SECRET", "--config-dir", dir]);
    expect(set.code).toBe(0);
    expect(set.stdout).toContain("API key for TMDB saved.");
    const show = await runBin(bin(), ["config", "show", "--json", "--config-dir", dir]);
    expect(show.code).toBe(0);
    expect(JSON.parse(show.stdout).apiKeys).toEqual({ tmdb: "configured", tvdb: "not set" });
    expect(show.stdout + show.stderr).not.toContain("E2E-SECRET");
    expect(await readFile(path.join(dir, "config.toml"), "utf8")).toContain("E2E-SECRET");
  });

  it("honors TIDYTITLES_CONFIG_DIR", async () => {
    const dir = freshDir();
    const r = await runBin(bin(), ["config", "show", "--json"], { env: { TIDYTITLES_CONFIG_DIR: dir } });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).configFile).toBe(path.join(dir, "config.toml"));
  });

  it("plain output (no colors) when stdout is a pipe", async () => {
    const r = await runBin(bin(), ["config", "show", "--config-dir", freshDir()]);
    expect(r.stdout).toContain("Current Configuration");
    expect(r.stdout).not.toContain("\x1b[");
  });

  it("exit codes: missing keys 1, missing path 2", async () => {
    const dir = freshDir();
    const media = path.join(tmp, "media-empty");
    await touch(media, MATRIX_FILE);
    const noKeys = await runBin(bin(), ["rename", media, "-n", "--config-dir", dir]);
    expect(noKeys.code).toBe(1);
    expect(noKeys.stderr.trim()).toBe(
      "Error: No API keys configured. Run 'tidytitles config set-key tmdb YOUR_API_KEY' (or 'tvdb') to configure, or use --type music.",
    );
    const missing = await runBin(bin(), ["rename", path.join(tmp, "nope"), "--config-dir", dir]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).not.toMatch(/\n\s+at /);
  });

  it("rename runs the real pipeline without network when no provider applies", async () => {
    const dir = freshDir();
    // Only a TVDB key: movies get no provider, so nothing is looked up.
    await writeKeys(dir, { tvdb: "x" });
    const media = path.join(tmp, `media-${n}`);
    await touch(media, MATRIX_FILE);
    const r = await runBin(bin(), ["rename", media, "-t", "movie", "--json", "--config-dir", dir]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.operations[0]).toMatchObject({ status: "skipped", skipReason: "no_match" });
  });

  it("undo puts back the tags a rename wrote (the tag writer runs inside the built file)", async () => {
    const dir = freshDir();
    const media = path.join(tmp, `media-tags-${_name.replace(/\W/g, "")}`);
    await mkdir(media, { recursive: true });
    const source = path.join(media, "song.flac");
    await copyFile(path.resolve(pkgDir, "../core/tests/fixtures/audio/tagged.flac"), source);
    const original = await readFile(source);
    const config = new ConfigService({ configDir: dir, cacheDir: path.join(dir, "cache"), env: {} });
    const settings = createDefaultSettings();
    settings.writeMetadata.musicTags = true;
    const session = new RenameSession(settings, { config, requireApiKeys: false, cache: false });
    const queen = createArtist({ id: "q-1", name: "Queen" });
    const destination = path.join(media, "Bohemian Rhapsody.flac");
    const ops = [
      createRenameOperation({
        source,
        destination,
        mediaFile: {
          path: source,
          parsedInfo: { title: "song", mediaType: "music", rawFilename: "song.flac" },
          matchedMetadata: createTrack({ id: "rec-1", title: "Bohemian Rhapsody", artist: queen }),
        },
      }),
    ];
    await session.execute(ops);
    await session.saveHistory(ops);
    expect(ops[0]!.metadataWrites?.tags?.status).toBe("written");

    const r = await runBin(bin(), ["undo", "-y", "--config-dir", dir]);
    expect(r.code).toBe(0);
    expect((await readFile(source)).equals(original)).toBe(true);
  });

  it("preview parses filenames", async () => {
    const media = path.join(tmp, `preview-${n}`);
    await touch(media, MATRIX_FILE);
    const r = await runBin(bin(), ["preview", media, "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).files[0]).toMatchObject({ title: "The Matrix", year: 1999, mediaType: "movie" });
  });

  it("confirmations read y/n from a piped stdin; end of input aborts", async () => {
    const dir = freshDir();
    expect((await runBin(bin(), ["config", "init", "--config-dir", dir])).code).toBe(0);
    await writeKeys(dir, { tmdb: "KEEPME" });

    const no = await runBin(bin(), ["config", "init", "--config-dir", dir], { input: "n\n" });
    expect(no.code).toBe(0);
    expect(no.stderr).toContain("Config file exists. Overwrite? [y/N]:");
    expect(await readFile(path.join(dir, "config.toml"), "utf8")).toContain("KEEPME");

    const eof = await runBin(bin(), ["config", "init", "--config-dir", dir], { input: "" });
    expect(eof.code).toBe(1);
    expect(eof.stderr).toContain("Aborted!");

    const yes = await runBin(bin(), ["config", "init", "--config-dir", dir], { input: "y\n" });
    expect(yes.code).toBe(0);
    expect(await readFile(path.join(dir, "config.toml"), "utf8")).not.toContain("KEEPME");
  });

  // Windows cannot deliver SIGINT to a child process: kill() ends it outright.
  it.skipIf(process.platform === "win32")("Ctrl+C at a prompt exits 130 without a stack trace", async () => {
    const dir = freshDir();
    await writeKeys(dir, { tmdb: "k" });
    const r = await runBin(bin(), ["config", "init", "--config-dir", dir], {
      onStderr: { waitFor: "Overwrite?", then: (child) => child.kill("SIGINT") },
    });
    expect(r.code).toBe(130);
    expect(r.stderr).toContain("Canceled.");
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });
});

describe("standalone bundle", () => {
  it("runs alone from an empty directory", async () => {
    const lonely = await mkdtemp(path.join(os.tmpdir(), "tidytitles-standalone-"));
    try {
      const copy = path.join(lonely, "tidytitles.mjs");
      await copyFile(path.join(dist, "tidytitles.mjs"), copy);
      const help = await runBin(copy, ["--help"], { cwd: lonely });
      expect(help.code).toBe(0);
      expect(help.stdout).toContain("rename");
      const show = await runBin(copy, ["config", "show", "--config-dir", path.join(lonely, "cfg")], { cwd: lonely });
      expect(show.code).toBe(0);
      expect(show.stdout).toContain("Current Configuration");
      const bundle = await readFile(copy, "utf8");
      // Only Node built-ins are imported.
      const imports = [...bundle.matchAll(/^import .* from "([^"]+)";?$/gm)].map((m) => m[1]);
      for (const spec of imports) expect(spec).toMatch(/^node:|^(fs|path|os|url|module|readline|tty|util|events|stream|crypto|child_process|process|buffer|assert|string_decoder|zlib|worker_threads|perf_hooks|async_hooks|net|http|https|timers|fs\/promises)$/);
      expect(bundle).not.toMatch(/\bimport\(\s*["'](?!node:)[^"']+["']\s*\)/);
    } finally {
      await rm(lonely, { recursive: true, force: true });
    }
  });
});
