import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { formatCount, formatHistoryTimestamp, parseHistoryTimestamp } from "../src/format";
import { colorEnabled } from "../src/ui";
import {
  FakeMovieProvider,
  FakeTVProvider,
  MATRIX_FILE,
  createSandbox,
  matrix,
  runIn,
  strip,
  touch,
  writeKeys,
} from "./helpers";

describe("global options", () => {
  it("--version prints the version", async () => {
    const r = await runIn(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  it("--help / -h lists the commands and exits 0", async () => {
    for (const flag of ["--help", "-h"]) {
      const r = await runIn([flag]);
      expect(r.code).toBe(0);
      for (const cmd of ["rename", "preview", "undo", "config"]) expect(r.stdout).toContain(cmd);
      expect(r.stdout).toContain("--config-dir");
      expect(r.stdout).toContain("--no-color");
      expect(r.stdout).toContain("TIDYTITLES_CONFIG_DIR");
    }
  });

  it("rename --help documents every flag and the non-TTY behavior", async () => {
    const r = await runIn(["rename", "--help"]);
    expect(r.code).toBe(0);
    for (const flag of [
      "-t, --type",
      "-r, --recursive",
      "-o, --output",
      "-n, --dry-run",
      "-y, --yes",
      "-a, --auto-select",
      "-p, --provider",
      "-c, --cover-art",
      "--json",
    ]) {
      expect(r.stdout).toContain(flag);
    }
    expect(r.stdout).toContain('default: "auto"');
    expect(r.stdout).toContain("When stdin is not a terminal, nothing is asked");
  });

  it("help for config subcommands", async () => {
    const r = await runIn(["config", "--help"]);
    expect(r.code).toBe(0);
    for (const cmd of ["show", "set-key", "set-template", "init"]) expect(r.stdout).toContain(cmd);
    const t = await runIn(["config", "set-template", "--help"]);
    expect(t.stdout).toContain("{title} - S{season2}E{episode2} - {episode_title}");
  });

  it("exits 2 for an unknown command or option", async () => {
    expect((await runIn(["frobnicate"])).code).toBe(2);
    const r = await runIn(["rename", "--bogus", "."]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--bogus");
  });

  it("exits 2 when a required argument is missing", async () => {
    expect((await runIn(["rename"])).code).toBe(2);
  });
});

describe("colors and progress", () => {
  async function dryRun(options: Parameters<typeof runIn>[1]) {
    const sb = await createSandbox();
    try {
      await writeKeys(sb.configDir, { tmdb: "k" });
      await touch(sb.media, MATRIX_FILE);
      return await runIn(["rename", sb.media, "-n", "--config-dir", sb.configDir], {
        session: {
          providers: {
            movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }),
            tvProvider: new FakeTVProvider(),
          },
        },
        ...options,
      });
    } finally {
      await sb.cleanup();
    }
  }

  it("colors stdout only on a terminal", async () => {
    const plain = await dryRun({ stdoutIsTTY: false });
    expect(plain.stdout).not.toContain("\x1b[");
    const colored = await dryRun({ stdoutIsTTY: true });
    expect(colored.stdout).toContain("\x1b[");
    expect(strip(colored.stdout)).toBe(plain.stdout);
  });

  it("honors NO_COLOR", async () => {
    const r = await dryRun({ stdoutIsTTY: true, env: { NO_COLOR: "1" } });
    expect(r.stdout).not.toContain("\x1b[");
  });

  it("colorEnabled: --no-color, NO_COLOR, FORCE_COLOR, TTY", () => {
    expect(colorEnabled(true, true, {})).toBe(true);
    expect(colorEnabled(false, true, {})).toBe(false);
    expect(colorEnabled(true, false, {})).toBe(false);
    expect(colorEnabled(true, true, { NO_COLOR: "1" })).toBe(false);
    expect(colorEnabled(true, true, { NO_COLOR: "" })).toBe(true);
    expect(colorEnabled(false, true, { FORCE_COLOR: "1" })).toBe(true);
    expect(colorEnabled(false, true, { FORCE_COLOR: "0" })).toBe(false);
    expect(colorEnabled(false, false, { FORCE_COLOR: "1" })).toBe(false);
  });

  it("shows progress on stderr only when it is a terminal", async () => {
    const quiet = await dryRun({ stderrIsTTY: false });
    expect(quiet.stderr).toBe("");
    const tty = await dryRun({ stderrIsTTY: true });
    expect(tty.stderr).toContain("\r\x1b[2K");
    expect(tty.stderr).toContain("Fetching: The Matrix");
    // The progress line never reaches stdout.
    expect(tty.stdout).not.toContain("Fetching");
  });
});

describe("--no-color flag", () => {
  it("disables colors on a terminal", async () => {
    const sb = await createSandbox();
    try {
      const r = await runIn(["--no-color", "config", "show", "--config-dir", sb.configDir], { stdoutIsTTY: true });
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain("\x1b[");
      const colored = await runIn(["config", "show", "--config-dir", sb.configDir], { stdoutIsTTY: true });
      expect(colored.stdout).toContain("\x1b[");
    } finally {
      await sb.cleanup();
    }
  });
});

describe("formatting (en-US)", () => {
  it("formats history timestamps as month day, year, 12-hour time", () => {
    expect(formatHistoryTimestamp("2026-11-07T19:00:00")).toBe("Nov 7, 2026, 7:00 PM");
    expect(formatHistoryTimestamp("2026-11-07T07:05:42.123000")).toBe("Nov 7, 2026, 7:05 AM");
    expect(formatHistoryTimestamp("not a date")).toBe("not a date");
  });

  it("parses Python isoformat timestamps as local time", () => {
    const d = parseHistoryTimestamp("2026-11-14T19:05:42.123456")!;
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([
      2026, 10, 14, 19, 5, 42, 123,
    ]);
    expect(parseHistoryTimestamp("2026-11-14T19:05:42Z")!.toISOString()).toBe("2026-11-14T19:05:42.000Z");
  });

  it("formats counts with comma separators", () => {
    expect(formatCount(18450)).toBe("18,450");
  });
});
