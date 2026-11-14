import { existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenameError } from "../src/errors";
import {
  createParsedInfo,
  createRenameOperation,
  type RenameOperation,
} from "../src/models";
import { FileRenamer, isCaseOnlyRename } from "../src/renamer";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

let tmpdir: string;

beforeEach(async () => {
  tmpdir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-renamer-"));
});

afterEach(async () => {
  vi.mocked(fsp.rename).mockClear();
  await rm(tmpdir, { recursive: true, force: true });
});

const p = (...parts: string[]) => path.join(tmpdir, ...parts);

async function touch(name: string, content = name): Promise<string> {
  const file = p(name);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

function op(
  source: string,
  destination: string,
  extra: Partial<RenameOperation> = {},
): RenameOperation {
  return createRenameOperation({
    source,
    destination,
    mediaFile: { path: source, parsedInfo: createParsedInfo({ title: "Test" }) },
    ...extra,
  });
}

function exdev(): NodeJS.ErrnoException {
  return Object.assign(new Error("EXDEV: cross-device link not permitted"), {
    code: "EXDEV",
  });
}

describe("FileRenamer.rename", () => {
  it("moves a file", async () => {
    const src = await touch("a.mkv", "data");
    await new FileRenamer().rename(src, p("b.mkv"));
    expect(existsSync(src)).toBe(false);
    expect(await readFile(p("b.mkv"), "utf8")).toBe("data");
  });

  it("creates destination directories for templates with path separators", async () => {
    const src = await touch("track.flac");
    const dest = p("Artist", "Album (2020)", "01 - Song.flac");
    await new FileRenamer().rename(src, dest);
    expect(existsSync(dest)).toBe(true);
  });

  it("leaves the emptied source directory in place", async () => {
    const src = await touch(path.join("old", "a.mkv"));
    await new FileRenamer().rename(src, p("a.mkv"));
    expect(existsSync(p("old"))).toBe(true);
  });

  it("throws when the source does not exist", async () => {
    await expect(new FileRenamer().rename(p("missing.mkv"), p("b.mkv"))).rejects.toThrow(
      new RenameError(`Source file does not exist: ${p("missing.mkv")}`),
    );
  });

  it("refuses to overwrite by default", async () => {
    const src = await touch("a.mkv", "new");
    const dest = await touch("b.mkv", "old");
    await expect(new FileRenamer().rename(src, dest)).rejects.toThrow(
      `Destination already exists: ${dest}`,
    );
    expect(await readFile(dest, "utf8")).toBe("old");
    expect(existsSync(src)).toBe(true);
  });

  it("overwrites when enabled", async () => {
    const src = await touch("a.mkv", "new");
    const dest = await touch("b.mkv", "old");
    await new FileRenamer({ overwrite: true }).rename(src, dest);
    expect(await readFile(dest, "utf8")).toBe("new");
    expect(existsSync(src)).toBe(false);
  });

  it("validates but changes nothing in dry-run mode", async () => {
    const src = await touch("a.mkv");
    const dest = p("new-dir", "b.mkv");
    await new FileRenamer({ dryRun: true }).rename(src, dest);
    expect(existsSync(src)).toBe(true);
    expect(existsSync(p("new-dir"))).toBe(false);
    await expect(
      new FileRenamer({ dryRun: true }).rename(p("missing"), dest),
    ).rejects.toThrow(RenameError);
  });

  it("falls back to copy + delete on a cross-device move (EXDEV)", async () => {
    const src = await touch("a.mkv", "payload");
    const mtime = new Date("2020-01-02T03:04:05Z");
    await utimes(src, mtime, mtime);
    vi.mocked(fsp.rename).mockRejectedValueOnce(exdev());

    await new FileRenamer().rename(src, p("b.mkv"));

    expect(existsSync(src)).toBe(false);
    expect(await readFile(p("b.mkv"), "utf8")).toBe("payload");
    expect((await stat(p("b.mkv"))).mtime.getTime()).toBe(mtime.getTime());
  });

  it("reports other rename errors without copying", async () => {
    const src = await touch("a.mkv");
    vi.mocked(fsp.rename).mockRejectedValueOnce(
      Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
    );
    await expect(new FileRenamer().rename(src, p("b.mkv"))).rejects.toThrow(
      "Failed to rename file: EACCES: permission denied",
    );
    expect(existsSync(src)).toBe(true);
    expect(existsSync(p("b.mkv"))).toBe(false);
  });

  it("changes only the letter case of a name", async () => {
    const src = await touch("the matrix.mkv", "neo");
    const dest = p("The Matrix.mkv");
    await new FileRenamer().rename(src, dest);
    expect(await readdir(tmpdir)).toEqual(["The Matrix.mkv"]);
    expect(await readFile(dest, "utf8")).toBe("neo");
  });
});

describe("isCaseOnlyRename", () => {
  it("is false for identical or unrelated paths", async () => {
    const a = await touch("a.mkv");
    expect(isCaseOnlyRename(a, a)).toBe(false);
    expect(isCaseOnlyRename(a, p("b.mkv"))).toBe(false);
  });

  it("matches the filesystem's case sensitivity", async () => {
    const a = await touch("probe.mkv");
    const caseInsensitive = existsSync(p("PROBE.mkv"));
    expect(isCaseOnlyRename(a, p("Probe.mkv"))).toBe(caseInsensitive);
  });
});

describe("FileRenamer.execute", () => {
  it("renames pending operations and marks them completed", async () => {
    const src = await touch("a.mkv");
    const ops = [op(src, p("Movie (1999).mkv"))];
    const result = await new FileRenamer().execute(ops);
    expect(result).toBe(ops);
    expect(ops[0]!.status).toBe("completed");
    expect(ops[0]!.errorMessage).toBeUndefined();
    expect(existsSync(p("Movie (1999).mkv"))).toBe(true);
  });

  it("skips operations whose source and destination are the same", async () => {
    const src = await touch("a.mkv");
    const ops = [op(src, src)];
    await new FileRenamer().execute(ops);
    expect(ops[0]!.status).toBe("skipped");
    expect(ops[0]!.errorMessage).toBe("Source and destination are the same");
  });

  it("skips operations that would overwrite", async () => {
    const src = await touch("a.mkv", "a");
    const dest = await touch("b.mkv", "b");
    const ops = [op(src, dest)];
    await new FileRenamer().execute(ops);
    expect(ops[0]!.status).toBe("skipped");
    expect(ops[0]!.errorMessage).toBe("Would overwrite existing file");
    expect(await readFile(dest, "utf8")).toBe("b");
  });

  it("overwrites when enabled", async () => {
    const src = await touch("a.mkv", "a");
    const dest = await touch("b.mkv", "b");
    const ops = [op(src, dest)];
    await new FileRenamer({ overwrite: true }).execute(ops);
    expect(ops[0]!.status).toBe("completed");
    expect(await readFile(dest, "utf8")).toBe("a");
  });

  it("does not treat a case-only rename as an overwrite", async () => {
    const src = await touch("the matrix.mkv");
    const ops = [op(src, p("The Matrix.mkv"))];
    await new FileRenamer().execute(ops);
    expect(ops[0]!.status).toBe("completed");
    expect(await readdir(tmpdir)).toEqual(["The Matrix.mkv"]);
  });

  it("marks failures with the error message", async () => {
    const ops = [op(p("missing.mkv"), p("b.mkv"))];
    await new FileRenamer().execute(ops);
    expect(ops[0]!.status).toBe("failed");
    expect(ops[0]!.errorMessage).toBe(`Source file does not exist: ${p("missing.mkv")}`);
  });

  it("leaves non-pending operations alone", async () => {
    const src = await touch("a.mkv");
    const ops = [op(src, p("b.mkv"), { status: "skipped" })];
    await new FileRenamer().execute(ops);
    expect(ops[0]!.status).toBe("skipped");
    expect(existsSync(src)).toBe(true);
  });

  it("renames associated files", async () => {
    const src = await touch("movie.mkv");
    const sub = await touch("movie.en.srt");
    const nfo = await touch("movie.nfo");
    const ops = [
      op(src, p("Movie (2024).mkv"), {
        associatedFiles: [
          { source: sub, destination: p("Movie (2024).en.srt"), fileType: "subtitle" },
          { source: nfo, destination: p("Movie (2024).nfo"), fileType: "nfo" },
        ],
      }),
    ];
    await new FileRenamer().execute(ops);
    expect(ops[0]!.status).toBe("completed");
    expect((await readdir(tmpdir)).sort()).toEqual([
      "Movie (2024).en.srt",
      "Movie (2024).mkv",
      "Movie (2024).nfo",
    ]);
  });

  it("completes the main file and reports associated-file failures", async () => {
    const src = await touch("movie.mkv");
    const sub = await touch("movie.srt");
    const taken = await touch("taken.srt");
    const ops = [
      op(src, p("New.mkv"), {
        associatedFiles: [
          { source: sub, destination: taken, fileType: "subtitle" },
          { source: p("gone.nfo"), destination: p("New.nfo"), fileType: "nfo" },
        ],
      }),
    ];
    await new FileRenamer().execute(ops);
    expect(ops[0]!.status).toBe("completed");
    expect(ops[0]!.errorMessage).toBe(
      `Associated files: movie.srt: Destination already exists: ${taken}; ` +
        `gone.nfo: Source file does not exist: ${p("gone.nfo")}`,
    );
    expect(existsSync(p("New.mkv"))).toBe(true);
  });

  it("reports progress for every operation", async () => {
    const a = await touch("a.mkv");
    const b = await touch("b.mkv");
    const calls: [number, number, string][] = [];
    await new FileRenamer().execute(
      [op(a, p("A.mkv"), { status: "skipped" }), op(b, p("B2.mkv"))],
      (current, total, message) => calls.push([current, total, message]),
    );
    expect(calls).toEqual([
      [1, 2, "Renaming: a.mkv"],
      [2, 2, "Renaming: b.mkv"],
    ]);
  });

  it("marks operations completed without renaming in dry-run mode", async () => {
    const src = await touch("a.mkv");
    const ops = [op(src, p("b.mkv"))];
    await new FileRenamer({ dryRun: true }).execute(ops);
    expect(ops[0]!.status).toBe("completed");
    expect(existsSync(src)).toBe(true);
    expect(existsSync(p("b.mkv"))).toBe(false);
  });
});

describe("FileRenamer.undo", () => {
  it("reverses completed operations, associated files included", async () => {
    const a = await touch("a.mkv");
    const sub = await touch("a.srt");
    const b = await touch("b.mkv");
    const ops = [
      op(a, p("dir", "A.mkv"), {
        associatedFiles: [{ source: sub, destination: p("dir", "A.srt"), fileType: "subtitle" }],
      }),
      op(b, p("B.mkv")),
    ];
    const renamer = new FileRenamer();
    await renamer.execute(ops);
    expect(ops.map((o) => o.status)).toEqual(["completed", "completed"]);

    const calls: string[] = [];
    await renamer.undo(ops, (c, t, m) => calls.push(`${c}/${t} ${m}`));

    expect(ops.map((o) => o.status)).toEqual(["pending", "pending"]);
    expect(existsSync(a) && existsSync(sub) && existsSync(b)).toBe(true);
    expect(existsSync(p("dir", "A.mkv"))).toBe(false);
    // Reverse order.
    expect(calls).toEqual(["1/2 Undoing: B.mkv", "2/2 Undoing: A.mkv"]);
  });

  it("skips operations that are not completed", async () => {
    const a = await touch("a.mkv");
    const ops = [op(a, p("x.mkv"), { status: "failed" })];
    await new FileRenamer().undo(ops);
    expect(ops[0]!.status).toBe("failed");
    expect(ops[0]!.errorMessage).toBeUndefined();
  });

  it("records undo failures and keeps the completed status", async () => {
    const ops = [op(p("orig.mkv"), p("renamed.mkv"), { status: "completed" })];
    await new FileRenamer().undo(ops);
    expect(ops[0]!.status).toBe("completed");
    expect(ops[0]!.errorMessage).toBe(
      `Undo failed: Source file does not exist: ${p("renamed.mkv")}`,
    );
  });

  it("undoes a case-only rename", async () => {
    const src = await touch("the matrix.mkv");
    const ops = [op(src, p("The Matrix.mkv"))];
    const renamer = new FileRenamer();
    await renamer.execute(ops);
    await renamer.undo(ops);
    expect(ops[0]!.status).toBe("pending");
    expect(await readdir(tmpdir)).toEqual(["the matrix.mkv"]);
  });
});
