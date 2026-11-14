import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BB_FILE, MATRIX_FILE, createSandbox, runIn, touch, type Sandbox } from "./helpers";

let sb: Sandbox;

beforeEach(async () => {
  sb = await createSandbox();
});

afterEach(async () => {
  await sb.cleanup();
});

describe("preview", () => {
  it("shows parsed information for video files", async () => {
    await touch(sb.media, MATRIX_FILE);
    await touch(sb.media, BB_FILE);
    await touch(sb.media, "notes.txt");
    const r = await runIn(["preview", sb.media]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Parsed File Information");
    const rows = r.stdout.split("\n");
    const matrix = rows.find((l) => l.includes(MATRIX_FILE))!;
    expect(matrix).toMatch(/│ movie\s+│ The Matrix\s+│ 1999 │ -\s+│ -\s+│/);
    const bb = rows.find((l) => l.includes(BB_FILE))!;
    expect(bb).toMatch(/│ tv_episode │ Breaking Bad\s+│ -\s+│ 1\s+│ 1\s+│/);
    expect(r.stdout).not.toContain("notes.txt");
  });

  it("needs no config or API keys", async () => {
    await touch(sb.media, MATRIX_FILE);
    const r = await runIn(["preview", sb.media, "--config-dir", path.join(sb.root, "never-created")]);
    expect(r.code).toBe(0);
  });

  it("says so when there are no video files", async () => {
    const r = await runIn(["preview", sb.media]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No video files found.");
  });

  it("--recursive / -r scans subdirectories", async () => {
    await touch(sb.media, path.join("deep", MATRIX_FILE));
    expect((await runIn(["preview", sb.media])).stdout).toContain("No video files found.");
    expect((await runIn(["preview", sb.media, "-r"])).stdout).toContain(MATRIX_FILE);
    expect((await runIn(["preview", sb.media, "--recursive"])).stdout).toContain(MATRIX_FILE);
  });

  it("fails with a usage error when PATH does not exist", async () => {
    const r = await runIn(["preview", path.join(sb.root, "missing")]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("does not exist");
  });

  it("--json prints the parsed fields", async () => {
    const file = await touch(sb.media, BB_FILE);
    const r = await runIn(["preview", sb.media, "--json"]);
    expect(JSON.parse(r.stdout)).toEqual({
      command: "preview",
      path: sb.media,
      files: [
        {
          path: file,
          filename: BB_FILE,
          mediaType: "tv_episode",
          title: "Breaking Bad",
          year: null,
          season: 1,
          episode: 1,
        },
      ],
    });
  });
});
