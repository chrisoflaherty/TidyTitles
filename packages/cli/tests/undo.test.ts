import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConfigService } from "@tidytitles/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakePrompter, createSandbox, runIn, strip, touch, type Sandbox } from "./helpers";

let sb: Sandbox;

beforeEach(async () => {
  sb = await createSandbox();
});

afterEach(async () => {
  await sb.cleanup();
});

/** Simulate a past rename: files are at their new names and history records them. */
async function seedHistory(timestamp = "2026-11-07T19:00:00.123000") {
  const a = { source: path.join(sb.media, "a.old.mkv"), destination: path.join(sb.media, "A (2001).mkv") };
  const b = { source: path.join(sb.media, "b.old.mkv"), destination: path.join(sb.media, "B (2002).mkv") };
  const sub = {
    source: path.join(sb.media, "a.old.en.srt"),
    destination: path.join(sb.media, "A (2001).en.srt"),
  };
  await touch(sb.media, "A (2001).mkv");
  await touch(sb.media, "A (2001).en.srt");
  await touch(sb.media, "B (2002).mkv");
  const config = new ConfigService({ configDir: sb.configDir, cacheDir: path.join(sb.configDir, "cache"), env: {} });
  await config.saveHistory([
    { ...a, associatedFiles: [sub] },
    { ...b, associatedFiles: [] },
  ]);
  // Fix the timestamp so the output is predictable.
  const file = path.join(sb.configDir, "history.json");
  const raw = JSON.parse(await readFile(file, "utf8")) as Array<{ timestamp: string }>;
  raw[0]!.timestamp = timestamp;
  await writeFile(file, JSON.stringify(raw, null, 2));
  return { a, b, sub, file };
}

function undo(args: string[] = [], options: Parameters<typeof runIn>[1] = {}) {
  return runIn(["undo", ...args, "--config-dir", sb.configDir], options);
}

describe("undo", () => {
  it("says so when there is no history", async () => {
    const r = await undo(["-y"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No rename history found.");
  });

  it("lists the files, asks, and moves them back", async () => {
    const { file } = await seedHistory();
    const prompter = new FakePrompter([true]);
    const r = await undo([], { prompter });

    expect(r.code).toBe(0);
    expect(prompter.calls).toEqual([{ kind: "confirm", message: "Proceed with undo?" }]);
    expect(r.stdout).toContain("Last rename: Nov 7, 2026, 7:00 PM");
    expect(r.stdout).toContain("Found 2 file(s) to undo:");
    expect(r.stdout).toContain("  A (2001).mkv → a.old.mkv");
    expect(r.stdout).toContain("Undone: 2");
    expect((await readdir(sb.media)).sort()).toEqual(["a.old.en.srt", "a.old.mkv", "b.old.mkv"]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([]);
  });

  it("undoes nothing when another rename is recorded while the prompt is open", async () => {
    const { a } = await seedHistory();
    const other = await touch(sb.media, "Other (2003).mkv");
    const config = new ConfigService({ configDir: sb.configDir, cacheDir: path.join(sb.configDir, "cache"), env: {} });
    const prompter = new FakePrompter([
      async () => {
        // The desktop app (or another terminal) renames a file meanwhile.
        await config.saveHistory([
          { source: path.join(sb.media, "other.old.mkv"), destination: other, associatedFiles: [] },
        ]);
        return true;
      },
    ]);
    const r = await undo([], { prompter });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("history changed");
    expect(existsSync(other)).toBe(true);
    expect(existsSync(a.destination)).toBe(true);
    expect(await config.loadHistory()).toHaveLength(2);
  });

  it("does nothing when the user declines", async () => {
    await seedHistory();
    const r = await undo([], { prompter: new FakePrompter([false]) });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Aborted.");
    expect(await readdir(sb.media)).toContain("A (2001).mkv");
  });

  it("--yes / -y skips the confirmation", async () => {
    await seedHistory();
    const prompter = new FakePrompter();
    const r = await undo(["-y"], { prompter });
    expect(r.code).toBe(0);
    expect(prompter.calls).toEqual([]);
  });

  it("exits 1 on partial failure and keeps what is still renamed in history", async () => {
    const { b, file } = await seedHistory();
    // Something new now occupies b's original name, so b cannot move back.
    await touch(sb.media, "b.old.mkv", "other");
    const r = await undo(["--yes"]);

    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Failed to undo B (2002).mkv: B (2002).mkv: Destination already exists");
    expect(r.stdout).toContain("Undone: 1");
    expect(r.stdout).toContain("Failed: 1");
    expect(existsSync(path.join(sb.media, "a.old.mkv"))).toBe(true);
    const h = JSON.parse(await readFile(file, "utf8")) as Array<{ operations: Array<{ source: string }> }>;
    expect(h).toHaveLength(1);
    expect(h[0]!.operations.map((o) => o.source)).toEqual([b.source]);
  });

  it("counts files that are already gone separately", async () => {
    await seedHistory();
    const { rm } = await import("node:fs/promises");
    await rm(path.join(sb.media, "B (2002).mkv"));
    const r = await undo(["-y"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Undone: 1");
    expect(r.stdout).toContain("Not found: 1");
  });

  describe("--json", () => {
    it("without history", async () => {
      const r = await undo(["--json"]);
      expect(JSON.parse(r.stdout)).toEqual({
        command: "undo",
        historyFound: false,
        timestamp: null,
        confirmed: null,
        items: [],
        undone: 0,
        missing: 0,
        kept: 0,
        failed: 0,
      });
    });

    it("with history", async () => {
      const { a, b } = await seedHistory();
      await touch(sb.media, "b.old.mkv", "other");
      const r = await undo(["-y", "--json"]);
      expect(r.code).toBe(1);
      const out = JSON.parse(r.stdout);
      expect(out).toMatchObject({
        command: "undo",
        historyFound: true,
        timestamp: "2026-11-07T19:00:00.123000",
        confirmed: true,
        undone: 1,
        missing: 0,
        failed: 1,
      });
      // Last renamed first.
      expect(out.items).toEqual([
        {
          source: b.source,
          destination: b.destination,
          status: "failed",
          errors: [expect.stringContaining("Destination already exists")],
          kept: [],
        },
        { source: a.source, destination: a.destination, status: "undone", errors: [], kept: [] },
      ]);
    });
  });

  describe("--list and --entry", () => {
    async function seedTwo() {
      const first = await seedHistory("2026-11-07T19:00:00.123000");
      const config = new ConfigService({ configDir: sb.configDir, cacheDir: path.join(sb.configDir, "cache"), env: {} });
      const c = await touch(sb.media, "C (2003).mkv");
      await config.saveHistory([{ source: path.join(sb.media, "c.old.mkv"), destination: c, associatedFiles: [] }]);
      const raw = JSON.parse(await readFile(first.file, "utf8")) as Array<{ timestamp: string }>;
      raw[0]!.timestamp = "2026-11-08T08:30:00";
      await writeFile(first.file, JSON.stringify(raw, null, 2));
      return first;
    }

    it("--list shows the history with en-US dates, most recent first", async () => {
      await seedTwo();
      const r = await undo(["--list"]);
      expect(r.code).toBe(0);
      const out = strip(r.stdout);
      expect(out).toContain("Rename History");
      expect(out).toMatch(/1 .*Nov 8, 2026, 8:30 AM.*1 .*Moved.*C \(2003\)\.mkv/);
      expect(out).toMatch(/2 .*Nov 7, 2026, 7:00 PM.*3 .*Moved.*A \(2001\)\.mkv and 1 more/);
      expect(out).toContain("undo --entry <#>");
    });

    it("--list --json", async () => {
      await seedTwo();
      const r = await undo(["--list", "--json"]);
      const out = JSON.parse(r.stdout);
      expect(out.history.map((e: { entry: number; files: number; transfer: string }) => [e.entry, e.files, e.transfer])).toEqual([
        [1, 1, "move"],
        [2, 3, "move"],
      ]);
    });

    it("--entry undoes an older rename and keeps the later one", async () => {
      await seedTwo();
      const r = await undo(["--entry", "2", "-y"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Rename #2: Nov 7, 2026, 7:00 PM");
      expect(r.stdout).toContain("Undone: 2");
      expect((await readdir(sb.media)).sort()).toEqual(["C (2003).mkv", "a.old.en.srt", "a.old.mkv", "b.old.mkv"]);
      const config = new ConfigService({ configDir: sb.configDir, cacheDir: path.join(sb.configDir, "cache"), env: {} });
      expect((await config.loadHistory()).map((e) => e.timestamp)).toEqual(["2026-11-08T08:30:00"]);
    });

    it("--entry beyond the history is a usage error", async () => {
      await seedTwo();
      const r = await undo(["--entry", "5", "-y"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("There is no entry 5 in the rename history (it has 2)");
    });

    it("--entry must be a positive number", async () => {
      const r = await undo(["--entry", "0"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Must be a positive whole number");
    });

    it("reports files left in place", async () => {
      const { a } = await seedHistory();
      // Record a fingerprint for A, then replace the file.
      const file = path.join(sb.configDir, "history.json");
      const raw = JSON.parse(await readFile(file, "utf8"));
      raw[0].operations[0].fingerprint = { dev: "1", ino: "2", size: "3", mtime_ns: "4" };
      await writeFile(file, JSON.stringify(raw));
      const r = await undo(["-y"]);
      expect(r.stdout).toContain("Left in place: A (2001).mkv (it was replaced or changed since the rename)");
      expect(r.stdout).toContain("Left in place: 1");
      expect(existsSync(a.destination)).toBe(true);
    });
  });
});
