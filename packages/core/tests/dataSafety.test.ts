/**
 * Regression tests for data-safety defects found in review: files lost,
 * overwritten, moved outside the chosen folder, or left without a working
 * undo.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigService } from "../src/config";
import { CoverArtDownloader } from "../src/coverArt";
import { createRenameOperation, createMovie } from "../src/models";
import { FileRenamer } from "../src/renamer";
import { RenameService } from "../src/renameService";
import { recordHistory, undoLastRename } from "../src/session";
import { TemplateEngine } from "../src/template";
import { FakeMovieProvider, FakeMusicParser, completeTags, matrix, matrixReloaded, touch } from "./fakes";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-safety-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function config(): ConfigService {
  return new ConfigService({ configDir: path.join(dir, "config"), cacheDir: path.join(dir, "cache"), env: {} });
}

describe("overwrite strategy within a batch", () => {
  it("never overwrites a file that another operation in the batch still has to move", async () => {
    // "Old.Name.2000.mkv" maps to "The Matrix (1999).mkv", which is itself in
    // the batch and maps to "The Matrix Reloaded (2003).mkv".
    const a = await touch(dir, "Old.Name.2000.mkv", "A");
    const b = await touch(dir, "The Matrix (1999).mkv", "B");
    const movies = new FakeMovieProvider({ "Old Name": [matrix], "The Matrix": [matrixReloaded] });
    const service = new RenameService({
      movieProvider: movies,
      musicParser: new FakeMusicParser(),
      conflictStrategy: "overwrite",
      fileRenamer: new FileRenamer({ overwrite: true }),
    });
    const ops = await service.processFiles([a, b]);
    await service.executeRename(ops);

    const contents = await Promise.all(
      (await readdir(dir)).map((name) => readFile(path.join(dir, name), "utf8")),
    );
    // Both files' contents must still exist somewhere.
    expect(contents.sort()).toEqual(["A", "B"]);
  });

  it("never overwrites a file this batch already renamed", async () => {
    const a = await touch(dir, "a.mkv", "A");
    const b = await touch(dir, "b.mkv", "B");
    // Two destinations that name the same file (as on a case-insensitive
    // volume): simulate with identical paths, as a plan built elsewhere could.
    const dest = path.join(dir, "Movie.mkv");
    const ops = [
      createRenameOperation({ source: a, destination: dest, mediaFile: { path: a, parsedInfo: { title: "a", mediaType: "movie", rawFilename: "a.mkv" } } }),
      createRenameOperation({ source: b, destination: dest, mediaFile: { path: b, parsedInfo: { title: "b", mediaType: "movie", rawFilename: "b.mkv" } } }),
    ];
    await new FileRenamer({ overwrite: true }).execute(ops);
    expect(await readFile(dest, "utf8")).toBe("A");
    expect(await readFile(b, "utf8")).toBe("B");
    expect(ops[1]!.status).toBe("skipped");
  });
});

describe("overwrite strategy and skipped batch files", () => {
  it("never overwrites a batch file whose own operation is skipped", async () => {
    // "Song.mp3" is already correctly named (its operation is skipped), and
    // another file in the batch maps onto the same name.
    const keep = await touch(dir, "Song.mp3", "KEEP");
    const other = await touch(dir, "song-copy.mp3", "OTHER");
    const info = (name: string) => ({ title: "Song", mediaType: "music" as const, rawFilename: name });
    const ops = [
      createRenameOperation({
        source: keep,
        destination: keep,
        status: "skipped",
        mediaFile: { path: keep, parsedInfo: info("Song.mp3") },
      }),
      createRenameOperation({
        source: other,
        destination: keep,
        mediaFile: { path: other, parsedInfo: info("song-copy.mp3") },
      }),
    ];
    await new FileRenamer({ overwrite: true }).execute(ops);
    expect(await readFile(keep, "utf8")).toBe("KEEP");
    expect(await readFile(other, "utf8")).toBe("OTHER");
    expect(ops[1]!.status).toBe("skipped");
  });

  it("still overwrites an existing file that is not part of the batch", async () => {
    const existing = await touch(dir, "Movie.mkv", "OLD");
    const incoming = await touch(dir, "movie.2020.mkv", "NEW");
    const ops = [
      createRenameOperation({
        source: incoming,
        destination: existing,
        mediaFile: { path: incoming, parsedInfo: { title: "Movie", mediaType: "movie", rawFilename: "movie.2020.mkv" } },
      }),
    ];
    await new FileRenamer({ overwrite: true }).execute(ops);
    expect(ops[0]!.status).toBe("completed");
    expect(await readFile(existing, "utf8")).toBe("NEW");
    expect(existsSync(incoming)).toBe(false);
  });
});

describe("templates and metadata cannot leave the chosen folder", () => {
  it.each(["../../../escaped", "..", "../.."])(
    "keeps a file inside its folder when a tag is %j",
    async (artist) => {
      const library = path.join(dir, "library", "inbox");
      const song = await touch(library, "song.mp3");
      const service = new RenameService({
        musicParser: new FakeMusicParser({ "song.mp3": { ...completeTags, artist } }),
      });
      const ops = await service.processFiles([song]);
      expect(ops[0]!.status).toBe("pending");
      const relative = path.relative(library, ops[0]!.destination);
      // No ".." component (a name that merely begins with dots is fine).
      expect(relative.split(path.sep)).not.toContain("..");
      expect(path.isAbsolute(relative)).toBe(false);
    },
  );

  it("drops '.' and '..' components from a template", () => {
    const engine = new TemplateEngine({ movieTemplate: "../../{title}/./{title} ({year})" });
    expect(engine.renderMovie(matrix, ".mkv")).toBe("The Matrix/The Matrix (1999).mkv");
  });
});

describe("associated files that failed to move", () => {
  async function renameWithBlockedSubtitle() {
    const movie = await touch(dir, "The.Matrix.1999.mkv", "movie");
    await touch(dir, "The.Matrix.1999.srt", "subtitle");
    // An unrelated file already has the subtitle's new name.
    await touch(dir, "The Matrix (1999).srt", "unrelated");
    const service = new RenameService({
      movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }),
      musicParser: new FakeMusicParser(),
    });
    const ops = await service.processFiles([movie]);
    await service.executeRename(ops);
    expect(ops[0]!.status).toBe("completed");
    expect(ops[0]!.errorMessage).toMatch(/Associated files/);
    return { service, ops };
  }

  it("does not record them for undo, so undo restores the main file", async () => {
    const { service, ops } = await renameWithBlockedSubtitle();
    await service.undoRename(ops);
    expect(await readFile(path.join(dir, "The.Matrix.1999.mkv"), "utf8")).toBe("movie");
    expect(await readFile(path.join(dir, "The.Matrix.1999.srt"), "utf8")).toBe("subtitle");
    expect(await readFile(path.join(dir, "The Matrix (1999).srt"), "utf8")).toBe("unrelated");
  });

  it("does not leave a history entry that can never be undone", async () => {
    const { ops } = await renameWithBlockedSubtitle();
    const cfg = config();
    await recordHistory(cfg, ops);
    const result = await undoLastRename(cfg);
    expect(result.failed).toBe(0);
    expect(result.undone).toBe(1);
    expect(await cfg.loadHistory()).toEqual([]);
    expect(await readFile(path.join(dir, "The Matrix (1999).srt"), "utf8")).toBe("unrelated");
  });
});

describe("history shared by several processes", () => {
  it("keeps an entry another process saved while an undo was running", async () => {
    const original = await touch(dir, "renamed.mkv", "x");
    const cfg = config();
    await cfg.saveHistory([{ source: path.join(dir, "orig.mkv"), destination: original, associatedFiles: [] }]);
    const other = config();
    const newer = [{ source: "/a/one.mkv", destination: "/a/two.mkv", associatedFiles: [] }];

    await undoLastRename(cfg, {
      progressCallback: () => {
        // Another process (the CLI or the app) records a rename mid-undo.
        void other.saveHistory(newer);
      },
    });
    // Let the other save finish.
    await new Promise((r) => setTimeout(r, 200));
    const history = await cfg.loadHistory();
    expect(history.map((e) => e.operations)).toEqual([newer]);
  });

  it("keeps both entries when two processes save at the same time", async () => {
    const a = config();
    const b = config();
    const opsA = [{ source: "/x/a1", destination: "/x/a2", associatedFiles: [] }];
    const opsB = [{ source: "/x/b1", destination: "/x/b2", associatedFiles: [] }];
    await Promise.all([a.saveHistory(opsA), b.saveHistory(opsB)]);
    const history = await a.loadHistory();
    expect(history).toHaveLength(2);
  });

  it("refuses to undo a different entry from the one that was confirmed", async () => {
    const file = await touch(dir, "renamed.mkv", "x");
    const cfg = config();
    await cfg.saveHistory([{ source: path.join(dir, "orig.mkv"), destination: file, associatedFiles: [] }]);
    const shown = (await cfg.loadHistory())[0]!;
    await new Promise((r) => setTimeout(r, 5));
    const other = await touch(dir, "other-renamed.mkv", "y");
    await config().saveHistory([{ source: path.join(dir, "other.mkv"), destination: other, associatedFiles: [] }]);

    await expect(undoLastRename(cfg, { expectedTimestamp: shown.timestamp })).rejects.toThrow(/changed/);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(await cfg.loadHistory()).toHaveLength(2);
  });
});

describe("cover art", () => {
  it("does not overwrite an existing image when the content type changes the extension", async () => {
    const existing = await touch(dir, "poster.png", "my own poster");
    const fetchFn = async () =>
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
    const downloader = new CoverArtDownloader({ fetch: fetchFn, overwrite: false });
    const movie = createMovie({ id: 1, title: "X", originalTitle: "X", year: 2000, posterPath: "/x.jpg" });
    await downloader.downloadForMetadata(movie, dir);
    expect(await readFile(existing, "utf8")).toBe("my own poster");
  });
});


describe.each(["copy", "hardlink"] as const)("overwrite strategy within a batch, %s mode", (transferMode) => {
  it("never overwrites a file that another operation in the batch still has to transfer", async () => {
    const a = await touch(dir, "Old.Name.2000.mkv", "A");
    const b = await touch(dir, "The Matrix (1999).mkv", "B");
    const movies = new FakeMovieProvider({ "Old Name": [matrix], "The Matrix": [matrixReloaded] });
    const service = new RenameService({
      movieProvider: movies,
      musicParser: new FakeMusicParser(),
      conflictStrategy: "overwrite",
      fileRenamer: new FileRenamer({ overwrite: true, transferMode }),
    });
    const ops = await service.processFiles([a, b]);
    await service.executeRename(ops);
    expect(await readFile(a, "utf8")).toBe("A");
    expect(await readFile(b, "utf8")).toBe("B");
    expect(ops[0]!.status).toBe("skipped");
  });

  it("never overwrites a file this batch already created", async () => {
    const a = await touch(dir, "a.mkv", "A");
    const b = await touch(dir, "b.mkv", "B");
    const dest = path.join(dir, "Movie.mkv");
    const info = (name: string) => ({ title: name, mediaType: "movie" as const, rawFilename: name });
    const ops = [
      createRenameOperation({ source: a, destination: dest, mediaFile: { path: a, parsedInfo: info("a.mkv") } }),
      createRenameOperation({ source: b, destination: dest, mediaFile: { path: b, parsedInfo: info("b.mkv") } }),
    ];
    await new FileRenamer({ overwrite: true, transferMode }).execute(ops);
    expect(await readFile(dest, "utf8")).toBe("A");
    expect(await readFile(a, "utf8")).toBe("A");
    expect(await readFile(b, "utf8")).toBe("B");
    expect(ops[1]!.status).toBe("skipped");
  });

  it("undo after a later rename replaced the result leaves both files", async () => {
    const a = await touch(dir, "a.mkv", "A");
    const dest = path.join(dir, "Movie.mkv");
    const info = { title: "a", mediaType: "movie" as const, rawFilename: "a.mkv" };
    const ops = [createRenameOperation({ source: a, destination: dest, mediaFile: { path: a, parsedInfo: info } })];
    await new FileRenamer({ transferMode }).execute(ops);
    await recordHistory(config(), ops);
    await rm(dest);
    await writeFile(dest, "NEW");
    const result = await undoLastRename(config());
    expect(result.kept).toBe(1);
    expect(await readFile(dest, "utf8")).toBe("NEW");
    expect(await readFile(a, "utf8")).toBe("A");
  });
});
