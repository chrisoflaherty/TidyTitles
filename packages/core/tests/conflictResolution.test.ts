import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findAvailablePath,
  parseConflictStrategy,
  previewConflicts,
  resolveConflict,
  type ConflictStrategy,
} from "../src/conflictResolution";
import { createParsedInfo, createRenameOperation } from "../src/models";

let tmpdir: string;

beforeEach(async () => {
  tmpdir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-conflict-"));
});

afterEach(async () => {
  await rm(tmpdir, { recursive: true, force: true });
});

async function touch(name: string): Promise<string> {
  const p = path.join(tmpdir, name);
  await writeFile(p, "");
  return p;
}

const nonexistent = path.join(path.sep, "nonexistent-tidytitles", "movie.mkv");

describe("findAvailablePath", () => {
  it("returns the original path when it does not exist", () => {
    expect(findAvailablePath(nonexistent)).toBe(nonexistent);
  });

  it("finds version (1) when the path exists", async () => {
    const existing = await touch("movie.mkv");
    expect(findAvailablePath(existing)).toBe(path.join(tmpdir, "movie (1).mkv"));
  });

  it("finds version (2) when (1) also exists", async () => {
    await touch("movie.mkv");
    await touch("movie (1).mkv");
    expect(findAvailablePath(path.join(tmpdir, "movie.mkv"))).toBe(
      path.join(tmpdir, "movie (2).mkv"),
    );
  });

  it("preserves the extension", async () => {
    const existing = await touch("movie.mp4");
    const result = findAvailablePath(existing);
    expect(result).toBe(path.join(tmpdir, "movie (1).mp4"));
    expect(path.extname(result)).toBe(".mp4");
  });

  it("works with parentheses already in the name", async () => {
    const existing = await touch("Movie (2024).mkv");
    expect(findAvailablePath(existing)).toBe(path.join(tmpdir, "Movie (2024) (1).mkv"));
  });

  it("throws when max attempts are exceeded", async () => {
    const existing = await touch("movie.mkv");
    expect(() => findAvailablePath(existing, 0)).toThrow(/Could not find available path/);
  });
});

describe("resolveConflict", () => {
  it("skip: no conflict", () => {
    expect(resolveConflict(nonexistent, "skip")).toEqual({
      path: nonexistent,
      wasModified: false,
    });
  });

  it("skip: with conflict", async () => {
    const existing = await touch("movie.mkv");
    expect(resolveConflict(existing, "skip")).toEqual({ path: existing, wasModified: false });
  });

  it("overwrite: no conflict", () => {
    expect(resolveConflict(nonexistent, "overwrite")).toEqual({
      path: nonexistent,
      wasModified: false,
    });
  });

  it("overwrite: with conflict", async () => {
    const existing = await touch("movie.mkv");
    expect(resolveConflict(existing, "overwrite")).toEqual({
      path: existing,
      wasModified: false,
    });
  });

  it("auto_version: no conflict", () => {
    expect(resolveConflict(nonexistent, "auto_version")).toEqual({
      path: nonexistent,
      wasModified: false,
    });
  });

  it("auto_version: with conflict", async () => {
    const existing = await touch("movie.mkv");
    expect(resolveConflict(existing, "auto_version")).toEqual({
      path: path.join(tmpdir, "movie (1).mkv"),
      wasModified: true,
    });
  });

  it("auto_version: finds the next available version", async () => {
    await touch("movie.mkv");
    await touch("movie (1).mkv");
    await touch("movie (2).mkv");
    expect(resolveConflict(path.join(tmpdir, "movie.mkv"), "auto_version")).toEqual({
      path: path.join(tmpdir, "movie (3).mkv"),
      wasModified: true,
    });
  });

  it("throws for an unknown strategy when there is a conflict", async () => {
    const existing = await touch("movie.mkv");
    expect(() => resolveConflict(existing, "bogus" as ConflictStrategy)).toThrow(
      /Unknown conflict strategy/,
    );
  });
});

describe("ConflictStrategy", () => {
  it("uses the expected string values", () => {
    const values: ConflictStrategy[] = ["skip", "overwrite", "auto_version"];
    expect(values).toEqual(["skip", "overwrite", "auto_version"]);
  });

  it("parses from a string", () => {
    expect(parseConflictStrategy("skip")).toBe("skip");
    expect(parseConflictStrategy("overwrite")).toBe("overwrite");
    expect(parseConflictStrategy("auto_version")).toBe("auto_version");
  });

  it("rejects an invalid string", () => {
    expect(() => parseConflictStrategy("invalid")).toThrow(RangeError);
  });
});

describe("previewConflicts", () => {
  it("splits operations by whether they would overwrite", async () => {
    const taken = await touch("Taken.mkv");
    const source = await touch("source.mkv");
    const mediaFile = { path: source, parsedInfo: createParsedInfo({ title: "x" }) };
    const conflicting = createRenameOperation({ source, destination: taken, mediaFile });
    const free = createRenameOperation({
      source,
      destination: path.join(tmpdir, "Free.mkv"),
      mediaFile,
    });

    const preview = previewConflicts([conflicting, free]);

    expect(preview.willOverwrite).toEqual([conflicting]);
    expect(preview.noConflict).toEqual([free]);
  });
});
