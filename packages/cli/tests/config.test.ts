import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakePrompter, createSandbox, runIn, writeKeys, type Sandbox } from "./helpers";

let sb: Sandbox;

beforeEach(async () => {
  sb = await createSandbox();
});

afterEach(async () => {
  await sb.cleanup();
});

const configFile = () => path.join(sb.configDir, "config.toml");

function config(args: string[], options: Parameters<typeof runIn>[1] = {}) {
  return runIn(["config", ...args, "--config-dir", sb.configDir], options);
}

describe("config show", () => {
  it("shows settings and only whether keys are set", async () => {
    await writeKeys(sb.configDir, { tmdb: "SUPERSECRET123" });
    const r = await config(["show"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Current Configuration");
    expect(r.stdout).toContain(`Config file: ${configFile()}`);
    expect(r.stdout).toContain(`Cache dir: ${path.join(sb.configDir, "cache")}`);
    expect(r.stdout).toContain("  Movie: {title} ({year})");
    expect(r.stdout).toContain("  TMDB: configured");
    expect(r.stdout).toContain("  TVDB: not set");
    expect(r.stdout).toContain("  Subtitles: ✓");
    expect(r.stdout).toContain("  Conflict resolution: skip");
    expect(r.stdout).toContain("  Preview before rename: True");
    expect(r.stdout + r.stderr).not.toContain("SUPERSECRET123");
  });

  it("hides the per-type lines when associated files are disabled", async () => {
    await mkdir(sb.configDir, { recursive: true });
    await writeFile(configFile(), "[associated_files]\nenabled = false\n");
    const r = await config(["show"]);
    expect(r.stdout).toContain("  Enabled:   disabled");
    expect(r.stdout).not.toContain("Subtitles:");
  });

  it("--json masks keys", async () => {
    await writeKeys(sb.configDir, { tmdb: "SUPERSECRET123", tvdb: "OTHERSECRET" });
    const r = await config(["show", "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({
      configFile: configFile(),
      cacheDir: path.join(sb.configDir, "cache"),
      templates: { movie: "{title} ({year})" },
      apiKeys: { tmdb: "configured", tvdb: "configured" },
      associatedFiles: { enabled: true, subtitles: true, nfo: true, images: true },
      coverArt: { enabled: false, filename: "poster.jpg", musicFilename: "cover.jpg", overwrite: false, size: "w500" },
      behavior: { conflictResolution: "skip", previewBeforeRename: true, dryRun: false, overwrite: false },
      providers: { movie: "tmdb", tv: "tvdb", music: "musicbrainz" },
    });
    expect(r.stdout).not.toContain("SECRET");
  });

  it("does not show keys from the environment either", async () => {
    const r = await config(["show", "--json"], { env: { FILE_RENAMER_API__TMDB_API_KEY: "ENVSECRET" } });
    expect(JSON.parse(r.stdout).apiKeys.tmdb).toBe("configured");
    expect(r.stdout).not.toContain("ENVSECRET");
  });

  it("reports a broken config file in one line and exits 1", async () => {
    await mkdir(sb.configDir, { recursive: true });
    await writeFile(configFile(), "[api\nbroken");
    const r = await config(["show"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^Error: Could not parse .*config\.toml/);
    expect(r.stderr).not.toContain("    at ");
  });

  it("prints a stack trace when DEBUG is set", async () => {
    await mkdir(sb.configDir, { recursive: true });
    await writeFile(configFile(), "[api\nbroken");
    const r = await config(["show"], { env: { DEBUG: "1" } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("    at ");
  });
});

describe("config set-key", () => {
  it("saves the key without printing it", async () => {
    const r = await config(["set-key", "tmdb", "MYKEY42"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("API key for TMDB saved.");
    expect(r.stdout + r.stderr).not.toContain("MYKEY42");
    expect(await readFile(configFile(), "utf8")).toContain('tmdb_api_key = "MYKEY42"');

    const tvdb = await config(["set-key", "tvdb", "TV1"]);
    expect(tvdb.stdout).toContain("API key for TVDB saved.");
    const toml = await readFile(configFile(), "utf8");
    expect(toml).toContain('tmdb_api_key = "MYKEY42"');
    expect(toml).toContain('tvdb_api_key = "TV1"');
  });

  it("rejects an unknown provider", async () => {
    const r = await config(["set-key", "imdb", "x"]);
    expect(r.code).toBe(2);
    expect(existsSync(configFile())).toBe(false);
  });

  it("requires a key", async () => {
    const r = await config(["set-key", "tmdb"]);
    expect(r.code).toBe(2);
  });
});

describe("config set-template", () => {
  it("saves a valid template", async () => {
    const r = await config(["set-template", "movie", "{title} ({year}) [{quality}]"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Template for movie saved.");
    expect(await readFile(configFile(), "utf8")).toContain('movie = "{title} ({year}) [{quality}]"');

    await config(["set-template", "music", "{artist}/{album}/{track2} - {title}"]);
    await config(["set-template", "tv", "{title} S{season2}E{episode2}"]);
    const toml = await readFile(configFile(), "utf8");
    expect(toml).toContain('music = "{artist}/{album}/{track2} - {title}"');
    expect(toml).toContain('tv = "{title} S{season2}E{episode2}"');
  });

  it("rejects an invalid template and lists the errors", async () => {
    const r = await config(["set-template", "movie", "{bogus} ({year|shout}) {title"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Invalid template:");
    expect(r.stderr).toContain("  - Unknown field: {bogus}");
    expect(r.stderr).toContain("  - Unknown formatter: shout");
    expect(r.stderr).toContain("  - Mismatched braces in template");
    expect(existsSync(configFile())).toBe(false);
  });

  it("rejects an unknown type", async () => {
    const r = await config(["set-template", "anime", "{title}"]);
    expect(r.code).toBe(2);
  });
});

describe("config init", () => {
  it("creates the config file", async () => {
    const prompter = new FakePrompter();
    const r = await config(["init"], { prompter });
    expect(r.code).toBe(0);
    expect(prompter.calls).toEqual([]);
    expect(r.stdout).toContain(`Config file created at: ${configFile()}`);
    expect(r.stdout).toContain("2. Run: tidytitles config set-key tmdb YOUR_API_KEY");
    expect(await readFile(configFile(), "utf8")).toContain("# File Renamer Configuration");
    expect(existsSync(path.join(sb.configDir, "cache"))).toBe(true);
  });

  it("asks before overwriting, and keeps the file when declined", async () => {
    await writeKeys(sb.configDir, { tmdb: "KEEP" });
    const prompter = new FakePrompter([false]);
    const r = await config(["init"], { prompter });
    expect(r.code).toBe(0);
    expect(prompter.calls).toEqual([{ kind: "confirm", message: "Config file exists. Overwrite?" }]);
    expect(r.stdout).toBe("");
    expect(await readFile(configFile(), "utf8")).toContain("KEEP");
  });

  it("overwrites with defaults when confirmed", async () => {
    await writeKeys(sb.configDir, { tmdb: "GONE" });
    const r = await config(["init"], { prompter: new FakePrompter([true]) });
    expect(r.code).toBe(0);
    expect(await readFile(configFile(), "utf8")).not.toContain("GONE");
  });
});

describe("config directory", () => {
  it("uses TIDYTITLES_CONFIG_DIR", async () => {
    const r = await runIn(["config", "show", "--json"], { env: { TIDYTITLES_CONFIG_DIR: sb.configDir } });
    expect(JSON.parse(r.stdout).configFile).toBe(configFile());
  });

  it("--config-dir wins over TIDYTITLES_CONFIG_DIR, before or after the command", async () => {
    const other = path.join(sb.root, "other");
    const env = { TIDYTITLES_CONFIG_DIR: other };
    const after = await runIn(["config", "show", "--json", "--config-dir", sb.configDir], { env });
    expect(JSON.parse(after.stdout).configFile).toBe(configFile());
    const before = await runIn(["--config-dir", sb.configDir, "config", "show", "--json"], { env });
    expect(JSON.parse(before.stdout).configFile).toBe(configFile());
  });

  it("resolves a relative directory", async () => {
    const rel = path.relative(process.cwd(), sb.configDir);
    const r = await runIn(["config", "show", "--json", "--config-dir", rel]);
    expect(JSON.parse(r.stdout).configFile).toBe(configFile());
  });
});
