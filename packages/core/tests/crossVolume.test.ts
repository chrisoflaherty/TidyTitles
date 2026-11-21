/**
 * Moves, copies, and hard links across volumes, and failures halfway
 * through a copy. CI machines have one volume, so the filesystem calls are
 * wrapped: a test can make `rename` or `link` fail with EXDEV (what the OS
 * reports across volumes), or make a copy fail after writing part of the
 * file. A second block uses two real volumes when the machine has them.
 */

import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A simulated failure of the next matching call (`only`: just for that path). */
type Fault = { op: "rename" | "link" | "copyFile" | "unlink"; code: string; partial?: boolean; only?: string };
const faults: { current: Fault[] } = { current: [] };

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const take = (op: string, p?: string) => {
    const i = faults.current.findIndex((f) => f.op === op && (f.only === undefined || f.only === p));
    if (i < 0) return undefined;
    return faults.current.splice(i, 1)[0];
  };
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      const f = take("rename");
      if (f) throw errno(f.code);
      return actual.rename(from, to);
    },
    link: async (from: string, to: string) => {
      const f = take("link");
      if (f) throw errno(f.code);
      return actual.link(from, to);
    },
    copyFile: async (from: string, to: string, mode?: number) => {
      const f = take("copyFile");
      if (f) {
        // Write part of the file first, as a full disk would.
        if (f.partial) await actual.writeFile(to, "PART");
        throw errno(f.code);
      }
      return actual.copyFile(from, to, mode);
    },
    unlink: async (p: string) => {
      const f = take("unlink", p);
      if (f) throw errno(f.code);
      return actual.unlink(p);
    },
  };
});

const { ConfigService, createDefaultSettings } = await import("../src/config");
const { FileRenamer } = await import("../src/renamer");
const { createRenameOperation } = await import("../src/models");
const { createSession, undoLastRename } = await import("../src/session");
const { FakeMovieProvider, FakeMusicParser, matrix, touch } = await import("./fakes");

let dir: string;
let media: string;

beforeEach(async () => {
  faults.current = [];
  dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-xvol-"));
  media = path.join(dir, "media");
  await mkdir(media);
});

afterEach(async () => {
  faults.current = [];
  await rm(dir, { recursive: true, force: true });
});

function op(source: string, destination: string) {
  return createRenameOperation({
    source,
    destination,
    mediaFile: { path: source, parsedInfo: { title: "x", mediaType: "movie", rawFilename: path.basename(source) } },
  });
}

const names = async (d: string) => (await readdir(d)).sort();

describe("move across volumes (EXDEV)", () => {
  it("copies, keeps the modification time, then deletes the original", async () => {
    const src = await touch(media, "a.mkv", "DATA");
    const mtime = statSync(src).mtimeMs;
    faults.current = [{ op: "rename", code: "EXDEV" }];
    const ops = [op(src, path.join(dir, "out", "b.mkv"))];
    await new FileRenamer().execute(ops);
    expect(ops[0]!.status).toBe("completed");
    expect(await readFile(path.join(dir, "out", "b.mkv"), "utf8")).toBe("DATA");
    expect(Math.abs(statSync(path.join(dir, "out", "b.mkv")).mtimeMs - mtime)).toBeLessThan(2_000);
    expect(await names(media)).toEqual([]);
    expect(await names(path.join(dir, "out"))).toEqual(["b.mkv"]);
  });

  it("leaves no partial file under the final name when the copy fails halfway", async () => {
    const src = await touch(media, "a.mkv", "DATA");
    faults.current = [
      { op: "rename", code: "EXDEV" },
      { op: "copyFile", code: "ENOSPC", partial: true },
    ];
    const ops = [op(src, path.join(dir, "out", "b.mkv"))];
    await new FileRenamer().execute(ops);
    expect(ops[0]!.status).toBe("failed");
    expect(await readFile(src, "utf8")).toBe("DATA");
    expect(await names(path.join(dir, "out"))).toEqual([]);
  });

  it("does not leave the file in two places when the original cannot be deleted", async () => {
    const src = await touch(media, "a.mkv", "DATA");
    faults.current = [
      { op: "rename", code: "EXDEV" },
      { op: "unlink", code: "EACCES", only: src },
    ];
    const ops = [op(src, path.join(dir, "out", "b.mkv"))];
    await new FileRenamer().execute(ops);
    expect(ops[0]!.status).toBe("failed");
    expect(await readFile(src, "utf8")).toBe("DATA");
    expect(await names(path.join(dir, "out"))).toEqual([]);
  });

  it("never replaces a file that appeared at the destination after the up-front check", async () => {
    const src = await touch(media, "a.mkv", "DATA");
    const dest = await touch(media, "b.mkv", "OTHER");
    // Called directly, past FileRenamer's existence check: the final step itself refuses.
    const { moveAcrossVolumes } = await import("../src/transfer");
    await expect(moveAcrossVolumes(src, dest, false)).rejects.toThrow(/already exists/);
    expect(await readFile(dest, "utf8")).toBe("OTHER");
    expect(await readFile(src, "utf8")).toBe("DATA");
    expect(await names(media)).toEqual(["a.mkv", "b.mkv"]);
  });
});

describe("copy failures", () => {
  it("leaves no partial file under the final name, and the original in place", async () => {
    const src = await touch(media, "a.mkv", "DATA");
    faults.current = [{ op: "copyFile", code: "ENOSPC", partial: true }];
    const ops = [op(src, path.join(media, "b.mkv"))];
    await new FileRenamer({ transferMode: "copy" }).execute(ops);
    expect(ops[0]).toMatchObject({ status: "failed" });
    expect(ops[0]!.errorMessage).toMatch(/ENOSPC/);
    expect(await names(media)).toEqual(["a.mkv"]);
    expect(await readFile(src, "utf8")).toBe("DATA");
  });

  it("falls back to a checked rename on filesystems without hard links", async () => {
    const src = await touch(media, "a.mkv", "DATA");
    faults.current = [{ op: "link", code: "EPERM" }];
    const ops = [op(src, path.join(media, "b.mkv"))];
    await new FileRenamer({ transferMode: "copy" }).execute(ops);
    expect(ops[0]!.status).toBe("completed");
    expect(await names(media)).toEqual(["a.mkv", "b.mkv"]);
  });
});

describe("hard links that cannot be made", () => {
  it("skips a link across volumes with a typed reason and creates nothing (no copy fallback)", async () => {
    const src = await touch(media, "a.mkv", "DATA");
    const srt = await touch(media, "a.en.srt", "SUBS");
    faults.current = [{ op: "link", code: "EXDEV" }];
    const o = op(src, path.join(media, "b.mkv"));
    o.associatedFiles = [{ source: srt, destination: path.join(media, "b.en.srt"), fileType: "subtitle" }];
    const ops = [o];
    const config = new ConfigService({ configDir: path.join(dir, "config"), cacheDir: path.join(dir, "cache"), env: {} });
    const settings = createDefaultSettings();
    settings.output.transferMode = "hardlink";
    await config.save(settings);
    const session = await createSession(config, { requireApiKeys: false, cache: false });
    await session.execute(ops);
    expect(ops[0]).toMatchObject({ status: "skipped", skipReason: "cross_device_link" });
    expect(await names(media)).toEqual(["a.en.srt", "a.mkv"]);
    expect(await session.saveHistory(ops)).toBe(0);
  });

  it("skips a volume without hard links with its own reason", async () => {
    const src = await touch(media, "a.mkv", "DATA");
    faults.current = [{ op: "link", code: "EPERM" }];
    const ops = [op(src, path.join(media, "b.mkv"))];
    const renamer = new FileRenamer({ transferMode: "hardlink" });
    await renamer.execute(ops);
    expect(ops[0]).toMatchObject({ status: "skipped" });
    const { RenameService } = await import("../src/renameService");
    const service = new RenameService({ fileRenamer: new FileRenamer({ transferMode: "hardlink" }) });
    faults.current = [{ op: "link", code: "EPERM" }];
    const again = [op(src, path.join(media, "c.mkv"))];
    await service.executeRename(again);
    expect(again[0]).toMatchObject({ status: "skipped", skipReason: "link_unsupported" });
    expect(await names(media)).toEqual(["a.mkv"]);
  });
});

// ---------------------------------------------------------------------------
// Two real volumes: the system temporary folder and this package's folder,
// when they are on different devices (an external drive, a separate /tmp).
// ---------------------------------------------------------------------------

const PACKAGE_DIR = path.resolve(import.meta.dirname, "..");
const twoVolumes = statSync(os.tmpdir()).dev !== statSync(PACKAGE_DIR).dev;

describe.skipIf(!twoVolumes)("two real volumes (skipped: the temporary folder and the package are on one volume)", () => {
  let other: string;
  beforeEach(async () => {
    other = await mkdtemp(path.join(PACKAGE_DIR, ".xvol-test-"));
  });
  afterEach(async () => {
    await rm(other, { recursive: true, force: true });
  });

  async function sessionFor(mode: "move" | "copy" | "hardlink", outputDir: string) {
    const config = new ConfigService({ configDir: path.join(dir, "config"), cacheDir: path.join(dir, "cache"), env: {} });
    const settings = createDefaultSettings();
    settings.api.tmdbApiKey = "key";
    settings.output.transferMode = mode;
    settings.output.movie = outputDir;
    await config.save(settings);
    return {
      config,
      session: await createSession(config, {
        cache: false,
        musicParser: new FakeMusicParser(),
        providers: { movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }) },
      }),
    };
  }

  it("moves to another volume and undoes it", async () => {
    const src = await touch(media, "The.Matrix.1999.mkv", "DATA");
    const { config, session } = await sessionFor("move", other);
    const ops = await session.plan([src]);
    await session.execute(ops);
    await session.saveHistory(ops);
    expect(ops[0]!.status).toBe("completed");
    expect(await names(other)).toEqual(["The Matrix (1999).mkv"]);
    expect(await names(media)).toEqual([]);
    expect(await undoLastRename(config)).toMatchObject({ undone: 1, kept: 0, failed: 0 });
    expect(await readFile(src, "utf8")).toBe("DATA");
    expect(await names(other)).toEqual([]);
  });

  it("copies to another volume and undoes it", async () => {
    const src = await touch(media, "The.Matrix.1999.mkv", "DATA");
    const { config, session } = await sessionFor("copy", other);
    const ops = await session.plan([src]);
    await session.execute(ops);
    await session.saveHistory(ops);
    expect(await names(other)).toEqual(["The Matrix (1999).mkv"]);
    expect(await undoLastRename(config)).toMatchObject({ undone: 1 });
    expect(await names(other)).toEqual([]);
    expect(await readFile(src, "utf8")).toBe("DATA");
  });

  it("marks hard links to another volume at planning time", async () => {
    const src = await touch(media, "The.Matrix.1999.mkv", "DATA");
    const { session } = await sessionFor("hardlink", other);
    const ops = await session.plan([src]);
    expect(ops[0]).toMatchObject({ status: "skipped", skipReason: "cross_device_link" });
    await session.execute(ops);
    expect(await names(other)).toEqual([]);
  });
});
