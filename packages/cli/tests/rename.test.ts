import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { AuthenticationError, ProviderError } from "@tidytitles/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CancelledError } from "../src/errors";
import { runCli } from "../src/program";
import {
  BB_FILE,
  FakeMovieProvider,
  FakePrompter,
  FakeTVProvider,
  MATRIX_FILE,
  OutputBuffer,
  breakingBad,
  createSandbox,
  matrix,
  matrixReloaded,
  pilot,
  runIn,
  strip,
  touch,
  writeKeys,
  type RunOptions,
  type Sandbox,
} from "./helpers";

let sb: Sandbox;

beforeEach(async () => {
  sb = await createSandbox();
  await writeKeys(sb.configDir, { tmdb: "tmdb-secret-key", tvdb: "tvdb-secret-key" });
});

afterEach(async () => {
  await sb.cleanup();
});

function movies(results: Record<string, unknown> = { "The Matrix": [matrix] }) {
  return new FakeMovieProvider(results as ConstructorParameters<typeof FakeMovieProvider>[0]);
}

function rename(args: string[], options: RunOptions = {}, movieProvider = movies()) {
  return runIn(["rename", ...args, "--config-dir", sb.configDir], {
    session: { providers: { movieProvider, tvProvider: new FakeTVProvider() } },
    ...options,
  });
}

async function history(): Promise<unknown[]> {
  const file = path.join(sb.configDir, "history.json");
  return existsSync(file) ? (JSON.parse(await readFile(file, "utf8")) as unknown[]) : [];
}

describe("rename", () => {
  it("--dry-run shows the preview and renames nothing", async () => {
    const file = await touch(sb.media, MATRIX_FILE);
    await touch(sb.media, MATRIX_FILE.replace(/\.mkv$/, ".en.srt"));
    const r = await rename([sb.media, "--dry-run"]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Found 1 file(s) to process.");
    expect(r.stdout).toContain("Rename Preview");
    expect(r.stdout).toContain("The Matrix (1999).mkv");
    expect(r.stdout).toContain("└─ Subtitle");
    expect(r.stdout).toContain("The Matrix (1999).en.srt");
    expect(r.stdout).toContain("Total: 1 video file(s) + 1 associated file(s) = 2 file(s)");
    expect(r.stdout).toContain("Dry run - no files were renamed.");
    expect(existsSync(file)).toBe(true);
    expect(await history()).toEqual([]);
  });

  it("-n is --dry-run", async () => {
    const file = await touch(sb.media, MATRIX_FILE);
    const r = await rename([sb.media, "-n"]);
    expect(r.code).toBe(0);
    expect(existsSync(file)).toBe(true);
  });

  it("renames after the user confirms, and saves history", async () => {
    await touch(sb.media, MATRIX_FILE);
    await touch(sb.media, MATRIX_FILE.replace(/\.mkv$/, ".nfo"));
    const prompter = new FakePrompter([true]);
    const r = await rename([sb.media], { prompter });

    expect(r.code).toBe(0);
    expect(prompter.calls).toEqual([{ kind: "confirm", message: "Proceed with rename?" }]);
    expect((await readdir(sb.media)).sort()).toEqual(["The Matrix (1999).mkv", "The Matrix (1999).nfo"]);
    expect(r.stdout).toContain("Completed: 1");
    const h = (await history()) as Array<{ operations: Array<{ source: string; associated_files: unknown[] }> }>;
    expect(h).toHaveLength(1);
    expect(h[0]!.operations[0]!.source).toBe(path.join(sb.media, MATRIX_FILE));
    expect(h[0]!.operations[0]!.associated_files).toHaveLength(1);
  });

  it("does nothing when the user declines", async () => {
    const file = await touch(sb.media, MATRIX_FILE);
    const r = await rename([sb.media], { prompter: new FakePrompter([false]) });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Canceled.");
    expect(existsSync(file)).toBe(true);
    expect(await history()).toEqual([]);
  });

  it("--yes / -y skips the confirmation", async () => {
    await touch(sb.media, MATRIX_FILE);
    const prompter = new FakePrompter();
    const r = await rename([sb.media, "-y"], { prompter });
    expect(r.code).toBe(0);
    expect(prompter.calls).toEqual([]);
    expect(await readdir(sb.media)).toEqual(["The Matrix (1999).mkv"]);
  });

  it("renames a single file given directly", async () => {
    const file = await touch(sb.media, MATRIX_FILE);
    const r = await rename([file, "--yes"]);
    expect(r.code).toBe(0);
    expect(await readdir(sb.media)).toEqual(["The Matrix (1999).mkv"]);
  });

  it("--output / -o moves renamed files to a directory", async () => {
    await touch(sb.media, MATRIX_FILE);
    const out = path.join(sb.root, "out");
    const r = await rename([sb.media, "-y", "-o", out]);
    expect(r.code).toBe(0);
    expect(await readdir(out)).toEqual(["The Matrix (1999).mkv"]);
    expect(await readdir(sb.media)).toEqual([]);
  });

  describe("output folders and transfer modes", () => {
    it("sends files to the [output] folder for their kind and says so", async () => {
      await touch(sb.media, MATRIX_FILE);
      const movies = path.join(sb.root, "Movies");
      await mkdir(movies);
      await writeKeys(sb.configDir, { tmdb: "k", tvdb: "k" }, `[output]\nmovie = ${JSON.stringify(movies)}\n`);
      const r = await rename([sb.media, "-y"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`Output folder: ${movies}`);
      expect(await readdir(movies)).toEqual(["The Matrix (1999).mkv"]);
      expect(await readdir(sb.media)).toEqual([]);
    });

    it("stops before renaming anything when an [output] folder is missing", async () => {
      await touch(sb.media, MATRIX_FILE);
      const missing = path.join(sb.root, "Unmounted");
      await writeKeys(sb.configDir, { tmdb: "k", tvdb: "k" }, `[output]\nmovie = ${JSON.stringify(missing)}\n`);
      const r = await rename([sb.media, "-y"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`The movie output folder doesn't exist (is the drive connected?): ${missing}`);
      expect(await readdir(sb.media)).toEqual([MATRIX_FILE]);
      expect(await history()).toEqual([]);
    });

    it("--output overrides the [output] folders", async () => {
      await touch(sb.media, MATRIX_FILE);
      const out = path.join(sb.root, "out");
      await writeKeys(sb.configDir, { tmdb: "k", tvdb: "k" }, `[output]\nmovie = "/nonexistent/folder"\n`);
      const r = await rename([sb.media, "-y", "-o", out]);
      expect(r.code).toBe(0);
      expect(await readdir(out)).toEqual(["The Matrix (1999).mkv"]);
    });

    it("--transfer copy leaves the original, and undo removes only the copy", async () => {
      const file = await touch(sb.media, MATRIX_FILE, "DATA");
      const r = await rename([sb.media, "-y", "--transfer", "copy"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Transfer: copy (the originals stay where they are)");
      expect((await readdir(sb.media)).sort()).toEqual([MATRIX_FILE, "The Matrix (1999).mkv"].sort());
      const u = await runIn(["undo", "-y", "--config-dir", sb.configDir]);
      expect(u.code).toBe(0);
      expect(await readdir(sb.media)).toEqual([MATRIX_FILE]);
      expect(await readFile(file, "utf8")).toBe("DATA");
    });

    it("--transfer hardlink, and transfer_mode from config.toml", async () => {
      await touch(sb.media, MATRIX_FILE, "DATA");
      await writeKeys(sb.configDir, { tmdb: "k", tvdb: "k" }, `[output]\ntransfer_mode = "hardlink"\n`);
      const r = await rename([sb.media, "-y", "--json"]);
      const out = JSON.parse(r.stdout);
      expect(out.transfer).toBe("hardlink");
      expect(out.operations[0].status).toBe("completed");
      expect((await readdir(sb.media)).sort()).toEqual([MATRIX_FILE, "The Matrix (1999).mkv"].sort());
    });

    it("rejects an unknown --transfer mode", async () => {
      const r = await rename([sb.media, "--transfer", "teleport"]);
      expect(r.code).toBe(2);
    });
  });

  describe("multiple matches", () => {
    const two = { "The Matrix": [matrix, matrixReloaded] };

    it("--auto-select / -a takes the first match without prompting", async () => {
      await touch(sb.media, MATRIX_FILE);
      const prompter = new FakePrompter();
      const r = await rename([sb.media, "-a", "-y"], { prompter, stdinIsTTY: true }, movies(two));
      expect(r.code).toBe(0);
      expect(prompter.calls).toEqual([]);
      expect(await readdir(sb.media)).toEqual(["The Matrix (1999).mkv"]);
    });

    it("asks the user to choose on a terminal", async () => {
      await touch(sb.media, MATRIX_FILE);
      const prompter = new FakePrompter([], [1]);
      const r = await rename([sb.media, "-y"], { prompter, stdinIsTTY: true }, movies(two));

      expect(r.code).toBe(0);
      expect(r.stderr).toContain(`Multiple matches found for: ${MATRIX_FILE}`);
      expect(r.stderr).toContain("Select Match");
      expect(r.stderr).toContain("The Matrix Reloaded");
      const call = prompter.calls[0]!;
      expect(call.message).toBe("Select match (1-2) or skip:");
      expect(call.choices!.map((c) => c.name)).toEqual([
        "1. The Matrix (1999)",
        "2. The Matrix Reloaded (2003)",
        "Skip this file",
      ]);
      expect(await readdir(sb.media)).toEqual(["The Matrix Reloaded (2003).mkv"]);
    });

    it("leaves the file alone when the user skips", async () => {
      const file = await touch(sb.media, MATRIX_FILE);
      const prompter = new FakePrompter([], [undefined]);
      const r = await rename([sb.media], { prompter, stdinIsTTY: true }, movies(two));
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("(skipped: no match)");
      expect(r.stdout).toContain("No matches found.");
      expect(prompter.calls.map((c) => c.kind)).toEqual(["select"]);
      expect(existsSync(file)).toBe(true);
    });

    it("never prompts when stdin is not a terminal: skips and says so", async () => {
      const file = await touch(sb.media, MATRIX_FILE);
      const prompter = new FakePrompter();
      const r = await rename([sb.media, "-y"], { prompter, stdinIsTTY: false }, movies(two));
      expect(r.code).toBe(0);
      expect(prompter.calls).toEqual([]);
      expect(r.stderr).toContain("1 file(s) had several matches and were skipped because stdin is not a terminal");
      expect(existsSync(file)).toBe(true);
    });

    it("counts every non-interactive skip, though the same question is asked once", async () => {
      await touch(sb.media, MATRIX_FILE);
      await touch(sb.media, "The.Matrix.1999.720p.mkv");
      const r = await rename([sb.media, "-n", "--json"], {}, movies(two));
      const out = JSON.parse(r.stdout) as { skippedSelections: string[] };
      expect(out.skippedSelections.sort()).toEqual(["The.Matrix.1999.720p.mkv", MATRIX_FILE].sort());
    });

    it("asks once for several files with the same matches", async () => {
      await touch(sb.media, MATRIX_FILE);
      await touch(sb.media, "The.Matrix.1999.720p.mkv");
      const prompter = new FakePrompter([], [0]);
      const r = await rename([sb.media, "-n"], { prompter, stdinIsTTY: true }, movies(two));
      expect(r.code).toBe(0);
      expect(prompter.calls.filter((c) => c.kind === "select")).toHaveLength(1);
    });

    it("lists non-interactive skips in --json", async () => {
      await touch(sb.media, MATRIX_FILE);
      const r = await rename([sb.media, "-n", "--json"], {}, movies(two));
      const out = JSON.parse(r.stdout) as { skippedSelections: string[] };
      expect(out.skippedSelections).toEqual([MATRIX_FILE]);
    });

    it("-a also works without a terminal", async () => {
      await touch(sb.media, MATRIX_FILE);
      const r = await rename([sb.media, "-a", "-y"], { stdinIsTTY: false }, movies(two));
      expect(r.code).toBe(0);
      expect(await readdir(sb.media)).toEqual(["The Matrix (1999).mkv"]);
    });
  });

  it("--recursive / -r scans subdirectories", async () => {
    await touch(sb.media, path.join("sub", MATRIX_FILE));
    const flat = await rename([sb.media, "-n"]);
    expect(flat.stdout).toContain("No media files found.");

    const deep = await rename([sb.media, "-r", "-y"]);
    expect(deep.code).toBe(0);
    expect(await readdir(path.join(sb.media, "sub"))).toEqual(["The Matrix (1999).mkv"]);
  });

  describe("progress and prompts", () => {
    it("never draws progress while a selection prompt is open", async () => {
      // File 1 has one show; its episode arrives while the question for
      // file 2 (two shows) is on screen.
      const other = { ...breakingBad, id: 2, title: "Zebra Show" };
      const remake = { ...breakingBad, id: 3, title: "Zebra Show (2030)" };
      const tv = new FakeTVProvider({ "Breaking Bad": [breakingBad], "Zebra Show": [other, remake] });
      tv.getEpisode = async (showId: number) => {
        if (showId === breakingBad.id) await new Promise((resolve) => setTimeout(resolve, 20));
        return { ...pilot, show: showId === breakingBad.id ? breakingBad : other };
      };
      await touch(sb.media, "Breaking.Bad.S01E01.mkv");
      await touch(sb.media, "Zebra.Show.S01E01.mkv");

      const stderr = new OutputBuffer();
      const writtenDuringPrompt: string[] = [];
      const prompter = new FakePrompter([], [
        async () => {
          const before = stderr.text.length;
          await new Promise((resolve) => setTimeout(resolve, 80));
          writtenDuringPrompt.push(stderr.text.slice(before));
          return 0;
        },
      ]);
      const code = await runCli(["rename", sb.media, "-n", "--config-dir", sb.configDir], {
        prompter,
        env: {},
        stdout: new OutputBuffer(),
        stderr,
        stdinIsTTY: true,
        stderrIsTTY: true,
        session: { providers: { movieProvider: movies(), tvProvider: tv } },
      });

      expect(code).toBe(0);
      expect(prompter.calls.map((c) => c.kind)).toEqual(["select"]);
      expect(writtenDuringPrompt).toEqual([""]);
      // Progress resumes after the prompt and counts up to the total.
      expect(strip(stderr.text)).toContain("[2/2] Fetching:");
    });
  });

  describe("--type / -t", () => {
    it("forces the media type for lookups", async () => {
      await touch(sb.media, BB_FILE);
      const movieProvider = movies({});
      const tvProvider = new FakeTVProvider({ "Breaking Bad": [breakingBad] }, { 1396: pilot });

      const asMovie = await runIn(["rename", sb.media, "-t", "movie", "-n", "--config-dir", sb.configDir], {
        session: { providers: { movieProvider, tvProvider } },
      });
      expect(asMovie.code).toBe(0);
      expect(movieProvider.calls.map((c) => c[0])).toEqual(["Breaking Bad"]);
      expect(tvProvider.searchCalls).toEqual([]);

      const asTv = await runIn(["rename", sb.media, "--type", "tv", "-y", "--config-dir", sb.configDir], {
        session: { providers: { movieProvider, tvProvider } },
      });
      expect(asTv.code).toBe(0);
      expect(await readdir(sb.media)).toEqual(["Breaking Bad - S01E01 - Pilot.mkv"]);
    });

    it("music scans only music files", async () => {
      await touch(sb.media, MATRIX_FILE);
      const r = await rename([sb.media, "-t", "music", "-n"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("No music files found.");
    });

    it("rejects an unknown type with a usage error", async () => {
      const r = await rename([sb.media, "-t", "anime"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("anime");
    });
  });

  describe("API keys and --provider / -p", () => {
    it("explains how to set a key when none is configured", async () => {
      await writeKeys(sb.configDir, {});
      await touch(sb.media, MATRIX_FILE);
      const r = await rename([sb.media, "-n"]);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr.trim().split("\n")).toHaveLength(1);
      expect(r.stderr).toContain("Error: No API keys configured. Run 'tidytitles config set-key tmdb YOUR_API_KEY'");
    });

    it("needs no keys for music", async () => {
      await writeKeys(sb.configDir, {});
      const r = await rename([sb.media, "-t", "music", "-n"]);
      expect(r.code).toBe(0);
    });

    it("needs the chosen provider's key", async () => {
      await writeKeys(sb.configDir, { tvdb: "x" });
      const r = await rename([sb.media, "-p", "tmdb", "-n"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("Error: TMDB API key not configured. Run 'tidytitles config set-key tmdb YOUR_API_KEY'");

      const tvdb = await rename([sb.media, "--provider", "tvdb", "-n"]);
      expect(tvdb.code).toBe(0);
    });

    it("musicbrainz needs no keys", async () => {
      await writeKeys(sb.configDir, {});
      const r = await rename([sb.media, "-p", "musicbrainz", "-n"]);
      expect(r.code).toBe(0);
    });

    it("rejects an unknown provider", async () => {
      const r = await rename([sb.media, "-p", "imdb"]);
      expect(r.code).toBe(2);
    });

    it("uses the program name it was invoked as in hints", async () => {
      await writeKeys(sb.configDir, {});
      const r = await rename([sb.media], { programName: "file-renamer" });
      expect(r.stderr).toContain("'file-renamer config set-key tmdb YOUR_API_KEY'");
    });
  });

  it("reports when no media files are found", async () => {
    const r = await rename([sb.media]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No media files found.");
  });

  it("reports when nothing matched", async () => {
    await touch(sb.media, MATRIX_FILE);
    const prompter = new FakePrompter();
    const r = await rename([sb.media], { prompter }, movies({}));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No matches found.");
    expect(prompter.calls).toEqual([]);
  });

  it("fails with a usage error when PATH does not exist", async () => {
    const r = await rename([path.join(sb.root, "nope")]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Error: Invalid value for 'PATH': Path");
    expect(r.stderr).toContain("does not exist.");
  });

  it("exits 1 and explains when a lookup fails with a bad key", async () => {
    await touch(sb.media, MATRIX_FILE);
    const r = await rename(
      [sb.media, "-y"],
      {},
      movies({ "The Matrix": new AuthenticationError("Invalid TMDB API key") }),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Error: Metadata lookup failed for 1 file(s): Invalid TMDB API key");
    expect(r.stderr).toContain("config set-key");
    expect(r.stdout).toContain("(skipped: lookup failed: Invalid TMDB API key)");
  });

  it("still renames the files that matched when another lookup fails", async () => {
    await touch(sb.media, MATRIX_FILE);
    await touch(sb.media, "Inception.2010.mkv");
    const r = await rename(
      [sb.media, "-y"],
      {},
      movies({ "The Matrix": [matrix], Inception: new ProviderError("Server error") }),
    );
    expect(r.code).toBe(1);
    expect(await readdir(sb.media)).toContain("The Matrix (1999).mkv");
    expect(r.stderr).not.toContain("config set-key");
  });

  it("exits 1 when a rename fails", async () => {
    const file = await touch(sb.media, MATRIX_FILE);
    // The file disappears between planning and renaming.
    const prompter = new FakePrompter([
      async () => {
        await rm(file);
        return true;
      },
    ]);
    const r = await rename([sb.media], { prompter });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Failed: 1");
    expect(r.stdout).toContain(`Error: ${MATRIX_FILE}: Source file does not exist`);
  });

  it("--cover-art / -c downloads posters after renaming", async () => {
    await touch(sb.media, MATRIX_FILE);
    const urls: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as typeof globalThis.fetch;
    const r = await runIn(["rename", sb.media, "-y", "-c", "--config-dir", sb.configDir], {
      session: { providers: { movieProvider: movies(), tvProvider: new FakeTVProvider() }, fetch },
    });
    expect(r.code).toBe(0);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/matrix.jpg");
    expect(r.stdout).toContain("Downloaded 1 cover art file(s)");
    expect((await readdir(sb.media)).sort()).toEqual(["The Matrix (1999).mkv", "poster.jpg"]);
  });

  describe("--json", () => {
    it("prints one JSON object and nothing else on stdout", async () => {
      await touch(sb.media, MATRIX_FILE);
      await touch(sb.media, MATRIX_FILE.replace(/\.mkv$/, ".en.srt"));
      const r = await rename([sb.media, "-y", "--json"]);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out).toMatchObject({
        command: "rename",
        path: sb.media,
        dryRun: false,
        files: 1,
        confirmed: true,
        skippedSelections: [],
        coverArt: [],
        historySaved: 1,
        summary: { total: 1, completed: 1, failed: 0, skipped: 0, pending: 0, associatedFiles: 1, totalFiles: 2 },
      });
      expect(out.operations).toEqual([
        {
          source: path.join(sb.media, MATRIX_FILE),
          destination: path.join(sb.media, "The Matrix (1999).mkv"),
          status: "completed",
          skipReason: null,
          error: null,
          lookupError: null,
          mediaType: "movie",
          match: {
            kind: "movie",
            id: 603,
            title: "The Matrix",
            year: 1999,
            provider: "tmdb",
            verificationStatus: "auto_matched",
          },
          associatedFiles: [
            {
              source: path.join(sb.media, MATRIX_FILE.replace(/\.mkv$/, ".en.srt")),
              destination: path.join(sb.media, "The Matrix (1999).en.srt"),
              fileType: "subtitle",
            },
          ],
        },
      ]);
      expect(JSON.stringify(out)).not.toContain("secret");
    });

    it("reports skips and lookup errors with typed fields", async () => {
      await touch(sb.media, MATRIX_FILE);
      await touch(sb.media, "Inception.2010.mkv");
      const r = await rename(
        [sb.media, "-n", "--json"],
        {},
        movies({ Inception: new AuthenticationError("bad key") }),
      );
      expect(r.code).toBe(1);
      const out = JSON.parse(r.stdout);
      expect(out.dryRun).toBe(true);
      expect(out.confirmed).toBeNull();
      const byName = Object.fromEntries(
        out.operations.map((op: { source: string }) => [path.basename(op.source), op]),
      );
      expect(byName["Inception.2010.mkv"]).toMatchObject({
        status: "skipped",
        skipReason: "lookup_failed",
        lookupError: { kind: "authentication", name: "AuthenticationError", message: "bad key" },
        match: null,
      });
      expect(byName[MATRIX_FILE]).toMatchObject({ status: "skipped", skipReason: "no_match" });
    });

    it("prints a JSON result when no files are found", async () => {
      const r = await rename([sb.media, "--json"]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ files: 0, operations: [], summary: { total: 0 } });
    });

    it("records a declined confirmation", async () => {
      await touch(sb.media, MATRIX_FILE);
      const r = await rename([sb.media, "--json"], { prompter: new FakePrompter([false]) });
      const out = JSON.parse(r.stdout);
      expect(out.confirmed).toBe(false);
      expect(out.operations[0].status).toBe("pending");
    });
  });

  describe("cancellation", () => {
    it("exits 130 when Ctrl+C interrupts a lookup", async () => {
      await touch(sb.media, MATRIX_FILE);
      const controller = new AbortController();
      const hanging = movies({
        "The Matrix": () => {
          setTimeout(() => controller.abort(), 5);
          return new Promise(() => {});
        },
      });
      const r = await rename([sb.media, "-y"], { signal: controller.signal }, hanging);
      expect(r.code).toBe(130);
      expect(r.stderr).toContain("Canceled.");
      expect(r.stderr).not.toContain("at ");
      expect(await readdir(sb.media)).toEqual([MATRIX_FILE]);
    });

    it("exits 130 when a selection prompt is canceled", async () => {
      await touch(sb.media, MATRIX_FILE);
      const prompter = new FakePrompter([], [
        () => {
          throw new CancelledError();
        },
      ]);
      const r = await rename(
        [sb.media],
        { prompter, stdinIsTTY: true },
        movies({ "The Matrix": [matrix, matrixReloaded] }),
      );
      expect(r.code).toBe(130);
      expect(r.stderr).toContain("Canceled.");
    });

    it("treats an @inquirer ExitPromptError (Ctrl+C) as a cancel", async () => {
      await touch(sb.media, MATRIX_FILE);
      const exit = new Error("User force closed the prompt");
      exit.name = "ExitPromptError";
      const prompter = new FakePrompter([
        () => {
          throw exit;
        },
      ]);
      const r = await rename([sb.media], { prompter });
      expect(r.code).toBe(130);
    });

    it("finishes renaming and saves history before honoring Ctrl+C", async () => {
      await touch(sb.media, MATRIX_FILE);
      const controller = new AbortController();
      const prompter = new FakePrompter([
        () => {
          controller.abort();
          return true;
        },
      ]);
      const r = await rename([sb.media], { prompter, signal: controller.signal });
      expect(r.code).toBe(130);
      expect(await readdir(sb.media)).toEqual(["The Matrix (1999).mkv"]);
      expect(await history()).toHaveLength(1);
    });
  });
});
