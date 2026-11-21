/** Output folders: settings, per-kind destinations, and the checks before anything moves. */

import { chmod, mkdir, mkdtemp, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigService, createDefaultSettings, parseSettings, type Settings } from "../src/config";
import { ConfigError } from "../src/errors";
import {
  applyTransferChecks,
  checkOutputFolder,
  outputDirFor,
  outputPlanFromSettings,
  OutputFolderError,
} from "../src/output";
import { createSession } from "../src/session";
import { FakeMovieProvider, FakeMusicParser, FakeTVProvider, breakingBad, matrix, pilot, touch } from "./fakes";

let dir: string;
let media: string;
let config: ConfigService;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-output-"));
  media = path.join(dir, "media");
  await mkdir(media);
  config = new ConfigService({ configDir: path.join(dir, "config"), cacheDir: path.join(dir, "cache"), env: {} });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const names = async (d: string) => (await readdir(d)).sort();

/** Permission tests need a non-root POSIX user: root and Windows ignore the mode bits. */
const permissionsApply = process.platform !== "win32" && process.getuid?.() !== 0;

async function session(edit: (s: Settings) => void, options: Parameters<typeof createSession>[1] = {}) {
  const settings = createDefaultSettings();
  settings.api.tmdbApiKey = "key";
  settings.api.tvdbApiKey = "key";
  edit(settings);
  await config.save(settings);
  return createSession(config, {
    cache: false,
    musicParser: new FakeMusicParser(),
    providers: {
      movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }),
      tvProvider: new FakeTVProvider({ "Breaking Bad": [breakingBad] }, { 1396: pilot() }),
    },
    ...options,
  });
}

describe("[output] settings", () => {
  it("defaults to renaming in place by moving", () => {
    expect(createDefaultSettings().output).toEqual({ movie: "", tv: "", music: "", transferMode: "move" });
  });

  it("reads snake_case keys from config.toml", () => {
    const s = parseSettings('[output]\nmovie = "/m"\ntv = "/t"\nmusic = "/a"\ntransfer_mode = "hardlink"\n');
    expect(s.output).toEqual({ movie: "/m", tv: "/t", music: "/a", transferMode: "hardlink" });
  });

  it("rejects an unknown transfer mode", () => {
    expect(() => parseSettings('[output]\ntransfer_mode = "teleport"\n')).toThrow(ConfigError);
  });

  it("takes environment variables, with config.toml winning", () => {
    const s = parseSettings('[output]\nmovie = "/file"\n', {
      FILE_RENAMER_OUTPUT__MOVIE: "/env",
      FILE_RENAMER_OUTPUT__TV: "/env-tv",
      FILE_RENAMER_OUTPUT__TRANSFER_MODE: "copy",
    });
    expect(s.output).toMatchObject({ movie: "/file", tv: "/env-tv", transferMode: "copy" });
  });

  it("round-trips through save and load", async () => {
    const settings = createDefaultSettings();
    settings.output = { movie: path.join(dir, "M"), tv: "", music: 'C:\\Music "x"', transferMode: "copy" };
    await config.save(settings);
    expect((await new ConfigService({ configDir: config.configDir, cacheDir: config.cacheDir, env: {} }).load()).output).toEqual(
      settings.output,
    );
  });
});

describe("outputDirFor", () => {
  it("picks the folder per kind, and the override for every kind", () => {
    const plan = outputPlanFromSettings({ movie: "/m", tv: " ", music: "", transferMode: "move" });
    expect(outputDirFor(plan, "movie")).toBe("/m");
    expect(outputDirFor(plan, "tv")).toBeUndefined();
    expect(outputDirFor(plan, undefined)).toBeUndefined();
    const all = outputPlanFromSettings({ movie: "/m", tv: "", music: "", transferMode: "move" }, "/all");
    expect(outputDirFor(all, "tv")).toBe("/all");
  });
});

describe("checkOutputFolder", () => {
  it("accepts a writable folder and leaves nothing behind", async () => {
    await checkOutputFolder(media, "movie");
    expect(await names(media)).toEqual([]);
  });

  it("reports a missing folder", async () => {
    const missing = path.join(dir, "Unmounted");
    await expect(checkOutputFolder(missing, "movie")).rejects.toMatchObject({
      reason: "missing",
      folder: missing,
      kind: "movie",
    });
  });

  it("creates a missing override folder only when asked", async () => {
    const out = path.join(dir, "new", "out");
    await checkOutputFolder(out, undefined, { create: true, dryRun: true });
    await expect(names(dir)).resolves.not.toContain("new");
    await checkOutputFolder(out, undefined, { create: true });
    expect(await names(path.join(dir, "new"))).toEqual(["out"]);
  });

  it("reports a file in place of a folder, and a relative path", async () => {
    const file = await touch(dir, "file.txt");
    await expect(checkOutputFolder(file, "tv")).rejects.toMatchObject({ reason: "not_directory" });
    await expect(checkOutputFolder("relative/path", "tv")).rejects.toMatchObject({ reason: "not_absolute" });
  });

  it.skipIf(!permissionsApply)("reports a folder that cannot be written to (skipped on Windows and as root)", async () => {
    const locked = path.join(dir, "locked");
    await mkdir(locked);
    await chmod(locked, 0o555);
    try {
      const error = await checkOutputFolder(locked, "music").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OutputFolderError);
      expect(error).toBeInstanceOf(ConfigError);
      expect(error).toMatchObject({ reason: "not_writable", kind: "music" });
    } finally {
      await chmod(locked, 0o755);
    }
  });
});

describe("sessions with output folders", () => {
  it("sends each kind to its folder and keeps the template's folders", async () => {
    const movies = path.join(dir, "Movies");
    const shows = path.join(dir, "Shows");
    await mkdir(movies);
    await mkdir(shows);
    const movie = await touch(media, "The.Matrix.1999.mkv", "M");
    const srt = await touch(media, "The.Matrix.1999.en.srt", "S");
    const episode = await touch(media, "Breaking.Bad.S01E01.mkv", "E");
    const s = await session((settings) => {
      settings.output.movie = movies;
      settings.output.tv = shows;
      settings.templates.tv = "{title}/Season {season}/{title} - S{season2}E{episode2}";
    });

    const ops = await s.plan([movie, episode]);
    expect(ops.map((o) => o.destination)).toEqual([
      path.join(movies, "The Matrix (1999).mkv"),
      path.join(shows, "Breaking Bad", "Season 1", "Breaking Bad - S01E01.mkv"),
    ]);
    expect(ops[0]!.associatedFiles[0]!.destination).toBe(path.join(movies, "The Matrix (1999).en.srt"));
    expect(s.outputDirFor(ops[0]!)).toBe(movies);
    expect(s.outputDirFor(ops[1]!)).toBe(shows);

    await s.execute(ops);
    expect(await names(media)).toEqual([]);
    expect(await names(movies)).toEqual(["The Matrix (1999).en.srt", "The Matrix (1999).mkv"]);
    void srt;
  });

  it("refuses to plan with a missing folder and moves nothing", async () => {
    const movie = await touch(media, "The.Matrix.1999.mkv", "M");
    const s = await session((settings) => {
      settings.output.movie = path.join(dir, "Unmounted Drive");
    });
    await expect(s.plan([movie])).rejects.toMatchObject({ name: "OutputFolderError", reason: "missing", kind: "movie" });
    expect(await names(media)).toEqual(["The.Matrix.1999.mkv"]);
  });

  it("ignores a broken folder for a kind the batch does not use", async () => {
    const episode = await touch(media, "Breaking.Bad.S01E01.mkv", "E");
    const s = await session((settings) => {
      settings.output.movie = path.join(dir, "Unmounted Drive");
    });
    const ops = await s.plan([episode]);
    expect(ops[0]!.status).toBe("pending");
  });

  it("stops the whole batch before anything moves when a folder vanished after planning", async () => {
    const movies = path.join(dir, "Movies");
    const shows = path.join(dir, "Shows");
    await mkdir(movies);
    await mkdir(shows);
    const movie = await touch(media, "The.Matrix.1999.mkv", "M");
    const episode = await touch(media, "Breaking.Bad.S01E01.mkv", "E");
    const s = await session((settings) => {
      settings.output.movie = movies;
      settings.output.tv = shows;
    });
    const ops = await s.plan([episode, movie]);
    await rmdir(movies);

    await expect(s.execute(ops)).rejects.toBeInstanceOf(OutputFolderError);
    expect(ops.map((o) => o.status)).toEqual(["pending", "pending"]);
    expect(await names(media)).toEqual(["Breaking.Bad.S01E01.mkv", "The.Matrix.1999.mkv"]);
    expect(await names(shows)).toEqual([]);
  });

  it("uses outputDir for every kind and creates it, as the CLI's --output always did", async () => {
    const movie = await touch(media, "The.Matrix.1999.mkv", "M");
    const out = path.join(dir, "out");
    const s = await session(
      (settings) => {
        settings.output.movie = path.join(dir, "ignored");
      },
      { outputDir: out },
    );
    const ops = await s.plan([movie]);
    expect(ops[0]!.destination).toBe(path.join(out, "The Matrix (1999).mkv"));
    await s.execute(ops);
    expect(await names(out)).toEqual(["The Matrix (1999).mkv"]);
  });

  it("does not create the outputDir in a dry run", async () => {
    const movie = await touch(media, "The.Matrix.1999.mkv", "M");
    const out = path.join(dir, "out");
    const s = await session(() => {}, { outputDir: out, dryRun: true });
    await s.plan([movie]);
    expect(await names(dir)).not.toContain("out");
  });

  it("reports an outputDir that is a file", async () => {
    const movie = await touch(media, "The.Matrix.1999.mkv", "M");
    const file = await touch(dir, "out");
    const s = await session(() => {}, { outputDir: file });
    await expect(s.plan([movie])).rejects.toMatchObject({ reason: "not_directory", kind: undefined });
    await writeFile(file, "still here");
  });
});

describe("applyTransferChecks", () => {
  it("only marks hard links, and clears its own marks when the mode changes", async () => {
    const movie = await touch(media, "The.Matrix.1999.mkv", "M");
    const s = await session(() => {});
    const ops = await s.plan([movie]);
    // Pretend the destination is on another volume.
    ops[0]!.destination = path.join(dir, "elsewhere", "x.mkv");
    applyTransferChecks(ops, "copy");
    expect(ops[0]!.status).toBe("pending");
    ops[0]!.status = "skipped";
    ops[0]!.skipReason = "cross_device_link";
    applyTransferChecks(ops, "move");
    expect(ops[0]).toMatchObject({ status: "pending" });
    expect(ops[0]!.skipReason).toBeUndefined();
  });
});
