import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigService,
  createDefaultSettings,
  parseSettings,
  pythonIsoTimestamp,
  resolveCacheDir,
  resolveConfigDir,
  settingsToToml,
  toHistoryOperation,
  type HistoryOperation,
} from "../src/config";
import { ConfigError } from "../src/errors";
import { createParsedInfo, createRenameOperation } from "../src/models";

let tmpdir: string;
let configDir: string;
let cacheDir: string;

beforeEach(async () => {
  tmpdir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-config-"));
  configDir = path.join(tmpdir, "config");
  cacheDir = path.join(tmpdir, "cache");
});

afterEach(async () => {
  await rm(tmpdir, { recursive: true, force: true });
});

/** A service isolated from the real config directory and the real environment. */
function service(env: Record<string, string> = {}): ConfigService {
  return new ConfigService({ configDir, cacheDir, env });
}

async function writeConfig(text: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "config.toml"), text);
}

/** Exactly what the Python `_to_toml` writes for default settings. */
const PYTHON_DEFAULT_TOML = `# File Renamer Configuration

[templates]
movie = "{title} ({year})"
tv = "{title} - S{season2}E{episode2} - {episode_title}"
music = "{artist}/{album} ({year})/{track2} - {title}"

[api]
tmdb_api_key = ""
tvdb_api_key = ""
tvdb_pin = ""

[associated_files]
enabled = true
subtitles = true
nfo = true
images = true

[cover_art]
enabled = false
filename = "poster.jpg"
music_filename = "cover.jpg"
overwrite = false
size = "w500"

[behavior]
dry_run = false
overwrite = false
preview_before_rename = true
conflict_resolution = "skip"

[providers]
movie = "tmdb"
tv = "tvdb"
music = "musicbrainz"
`;

/** Sections the Python app does not have (it ignores them). */
const TIDYTITLES_SECTIONS_TOML = `
[output]
movie = ""
tv = ""
music = ""
transfer_mode = "move"

[history]
max_entries = 200

[tv]
episode_order = "aired"

[metadata]
language = "en-US"

[write_metadata]
music_tags = false
nfo = false

[watch]
enabled = false
folders = []
recursive = true
mode = "review"
settle_seconds = 10
`;

describe("directory resolution", () => {
  it("matches platformdirs on macOS", () => {
    const ctx = { platform: "darwin" as const, env: {}, homedir: "/Users/test" };
    expect(resolveConfigDir(ctx)).toBe("/Users/test/Library/Application Support/file-renamer");
    expect(resolveCacheDir(ctx)).toBe("/Users/test/Library/Caches/file-renamer");
  });

  it("ignores XDG variables on macOS", () => {
    const ctx = {
      platform: "darwin" as const,
      env: { XDG_CONFIG_HOME: "/x" },
      homedir: "/Users/test",
    };
    expect(resolveConfigDir(ctx)).toBe("/Users/test/Library/Application Support/file-renamer");
  });

  it("matches platformdirs on Linux", () => {
    const ctx = { platform: "linux" as const, env: {}, homedir: "/home/test" };
    expect(resolveConfigDir(ctx)).toBe("/home/test/.config/file-renamer");
    expect(resolveCacheDir(ctx)).toBe("/home/test/.cache/file-renamer");
  });

  it("honors XDG variables on Linux, ignoring blank ones", () => {
    expect(
      resolveConfigDir({
        platform: "linux",
        env: { XDG_CONFIG_HOME: "/xdg/config", XDG_CACHE_HOME: "/xdg/cache" },
        homedir: "/home/test",
      }),
    ).toBe("/xdg/config/file-renamer");
    expect(
      resolveCacheDir({
        platform: "freebsd",
        env: { XDG_CACHE_HOME: "/xdg/cache" },
        homedir: "/home/test",
      }),
    ).toBe("/xdg/cache/file-renamer");
    expect(
      resolveConfigDir({ platform: "linux", env: { XDG_CONFIG_HOME: "  " }, homedir: "/h" }),
    ).toBe("/h/.config/file-renamer");
  });

  it("matches platformdirs on Windows (local AppData, app name twice)", () => {
    const ctx = {
      platform: "win32" as const,
      env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local", APPDATA: "C:\\Roaming" },
      homedir: "C:\\Users\\test",
    };
    expect(resolveConfigDir(ctx)).toBe(
      "C:\\Users\\test\\AppData\\Local\\file-renamer\\file-renamer",
    );
    expect(resolveCacheDir(ctx)).toBe(
      "C:\\Users\\test\\AppData\\Local\\file-renamer\\file-renamer\\Cache",
    );
  });

  it("falls back to the home directory on Windows without LOCALAPPDATA", () => {
    expect(
      resolveConfigDir({ platform: "win32", env: {}, homedir: "C:\\Users\\test" }),
    ).toBe("C:\\Users\\test\\AppData\\Local\\file-renamer\\file-renamer");
  });

  it("uses an injected config dir or config path", () => {
    const s = service();
    expect(s.configDir).toBe(configDir);
    expect(s.configFile).toBe(path.join(configDir, "config.toml"));
    expect(s.historyFile).toBe(path.join(configDir, "history.json"));
    expect(s.cacheDir).toBe(cacheDir);

    const custom = path.join(tmpdir, "elsewhere", "custom.toml");
    const s2 = new ConfigService({ configPath: custom, cacheDir, env: {} });
    expect(s2.configFile).toBe(custom);
    expect(s2.configDir).toBe(path.dirname(custom));
  });
});

describe("settings", () => {
  it("has the Python defaults", () => {
    expect(createDefaultSettings()).toEqual({
      templates: {
        movie: "{title} ({year})",
        tv: "{title} - S{season2}E{episode2} - {episode_title}",
        music: "{artist}/{album} ({year})/{track2} - {title}",
      },
      api: { tmdbApiKey: "", tvdbApiKey: "", tvdbPin: "" },
      associatedFiles: { enabled: true, subtitles: true, nfo: true, images: true },
      coverArt: {
        enabled: false,
        filename: "poster.jpg",
        musicFilename: "cover.jpg",
        overwrite: false,
        size: "w500",
      },
      dryRun: false,
      overwrite: false,
      previewBeforeRename: true,
      conflictResolution: "skip",
      movieProvider: "tmdb",
      tvProvider: "tvdb",
      musicProvider: "musicbrainz",
      output: { movie: "", tv: "", music: "", transferMode: "move" },
      history: { maxEntries: 200 },
      tv: { episodeOrder: "aired" },
      metadata: { language: "en-US" },
      writeMetadata: { musicTags: false, nfo: false },
      watch: { enabled: false, folders: [], recursive: true, mode: "review", settleSeconds: 10 },
    });
  });

  it("serializes like the Python for default settings, plus the TidyTitles-only sections", () => {
    expect(settingsToToml(createDefaultSettings())).toBe(PYTHON_DEFAULT_TOML + TIDYTITLES_SECTIONS_TOML);
  });

  it("loads a file without [tv] or [metadata] with their defaults", () => {
    const settings = parseSettings(PYTHON_DEFAULT_TOML);
    expect(settings.tv).toEqual({ episodeOrder: "aired" });
    expect(settings.metadata).toEqual({ language: "en-US" });
  });

  it("reads [tv] episode_order and [metadata] language, and writes them back", () => {
    const text = `${PYTHON_DEFAULT_TOML}\n[tv]\nepisode_order = "dvd"\n\n[metadata]\nlanguage = "de-DE"\n`;
    const settings = parseSettings(text);
    expect(settings.tv.episodeOrder).toBe("dvd");
    expect(settings.metadata.language).toBe("de-DE");
    expect(parseSettings(settingsToToml(settings))).toEqual(settings);
  });

  it("rejects an unknown episode order or language code, naming the key", () => {
    expect(() => parseSettings('[tv]\nepisode_order = "production"\n')).toThrow(/tv\.episode_order/);
    expect(() => parseSettings('[metadata]\nlanguage = "German"\n')).toThrow(/metadata\.language/);
  });

  it("takes [tv] and [metadata] from the environment; the file wins", () => {
    const env = { FILE_RENAMER_TV__EPISODE_ORDER: "absolute", FILE_RENAMER_METADATA__LANGUAGE: "ja-JP" };
    expect(parseSettings(undefined, env).tv.episodeOrder).toBe("absolute");
    expect(parseSettings(undefined, env).metadata.language).toBe("ja-JP");
    expect(parseSettings('[metadata]\nlanguage = "fr-FR"\n', env).metadata.language).toBe("fr-FR");
  });

  it("escapes quotes and backslashes so the TOML stays valid", () => {
    const settings = createDefaultSettings();
    settings.templates.movie = 'C:\\Movies\\{title} "{year}"';
    const parsed = parseSettings(settingsToToml(settings));
    expect(parsed.templates.movie).toBe('C:\\Movies\\{title} "{year}"');
  });

  it("returns defaults when there is no config file", async () => {
    const s = service();
    expect(await s.load()).toEqual(createDefaultSettings());
    expect(s.settings).toEqual(createDefaultSettings());
  });

  it("loads a Python-written file, mapping sections to camelCase", async () => {
    await writeConfig(
      PYTHON_DEFAULT_TOML.replace('tmdb_api_key = ""', 'tmdb_api_key = "abc123"')
        .replace('music_filename = "cover.jpg"', 'music_filename = "folder.jpg"')
        .replace("dry_run = false", "dry_run = true")
        .replace('conflict_resolution = "skip"', 'conflict_resolution = "auto_version"')
        .replace('movie = "tmdb"', 'movie = "other"'),
    );
    const settings = await service().load();
    expect(settings.api.tmdbApiKey).toBe("abc123");
    expect(settings.coverArt.musicFilename).toBe("folder.jpg");
    expect(settings.dryRun).toBe(true);
    expect(settings.conflictResolution).toBe("auto_version");
    expect(settings.movieProvider).toBe("other");
  });

  it("fills in missing keys and ignores unknown ones", async () => {
    await writeConfig(`
[templates]
movie = "{title}"
extra = "ignored"

[mystery]
key = 1

[behavior]
overwrite = true
`);
    const settings = await service().load();
    expect(settings.templates.movie).toBe("{title}");
    expect(settings.templates.tv).toBe(createDefaultSettings().templates.tv);
    expect(settings.overwrite).toBe(true);
    expect(settings).not.toHaveProperty("mystery");
  });

  it("accepts pydantic-style lax booleans", async () => {
    await writeConfig(`[associated_files]\nenabled = 0\nnfo = "yes"\n[behavior]\ndry_run = "off"\n`);
    const settings = await service().load();
    expect(settings.associatedFiles.enabled).toBe(false);
    expect(settings.associatedFiles.nfo).toBe(true);
    expect(settings.dryRun).toBe(false);
  });

  it("raises ConfigError for invalid TOML", async () => {
    await writeConfig("[templates\nmovie = ");
    const err = await service()
      .load()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/Could not parse .*config\.toml/);
  });

  it("raises ConfigError naming the bad key", async () => {
    await writeConfig(`[templates]\nmovie = 5\n[behavior]\ndry_run = "maybe"\n`);
    const err = await service()
      .load()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain("templates.movie");
    expect((err as Error).message).toContain("behavior.dry_run");
  });

  it("raises ConfigError when a section is not a table", async () => {
    await writeConfig(`api = "nope"\n`);
    await expect(service().load()).rejects.toThrow(ConfigError);
  });

  it("throws from the settings getter before loading", () => {
    expect(() => service().settings).toThrow(ConfigError);
  });

  it("round-trips through save and load", async () => {
    const s = service();
    const settings = await s.getSettings();
    settings.templates.music = "{artist} - {title}";
    settings.coverArt.enabled = true;
    settings.previewBeforeRename = false;
    await s.save();

    expect(existsSync(cacheDir)).toBe(true);
    const onDisk = parseToml(await readFile(s.configFile, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(onDisk.templates!.music).toBe("{artist} - {title}");
    expect(onDisk.cover_art!.enabled).toBe(true);
    expect(onDisk.behavior!.preview_before_rename).toBe(false);

    expect(await service().load()).toEqual(settings);
  });

  it("saves defaults when nothing was loaded", async () => {
    const s = service();
    await s.save();
    expect(await readFile(s.configFile, "utf8")).toBe(PYTHON_DEFAULT_TOML + TIDYTITLES_SECTIONS_TOML);
  });

  it("does not preserve unknown keys on save (as in the Python)", async () => {
    await writeConfig(`[templates]\nmovie = "{title}"\n[mystery]\nkey = 1\n`);
    const s = service();
    await s.load();
    await s.save();
    const text = await readFile(s.configFile, "utf8");
    expect(text).not.toContain("mystery");
    expect(text).toContain('movie = "{title}"');
  });
});

describe("environment overrides", () => {
  it("reads prefixed and nested variables, case-insensitively", async () => {
    const settings = await service({
      FILE_RENAMER_DRY_RUN: "true",
      file_renamer_overwrite: "1",
      FILE_RENAMER_API__TMDB_API_KEY: "env-key",
      FILE_RENAMER_COVER_ART__MUSIC_FILENAME: "folder.png",
      FILE_RENAMER_MOVIE_PROVIDER: "envprov",
      UNRELATED: "x",
      FILE_RENAMER_NOT_A_FIELD: "x",
    }).load();
    expect(settings.dryRun).toBe(true);
    expect(settings.overwrite).toBe(true);
    expect(settings.api.tmdbApiKey).toBe("env-key");
    expect(settings.coverArt.musicFilename).toBe("folder.png");
    expect(settings.movieProvider).toBe("envprov");
  });

  it("accepts a JSON section, with nested variables winning", async () => {
    const settings = await service({
      FILE_RENAMER_TEMPLATES: '{"movie": "json-movie", "tv": "json-tv"}',
      FILE_RENAMER_TEMPLATES__TV: "nested-tv",
    }).load();
    expect(settings.templates.movie).toBe("json-movie");
    expect(settings.templates.tv).toBe("nested-tv");
  });

  it("lets config.toml values win over the environment, key by key", async () => {
    await writeConfig(`[api]\ntmdb_api_key = "file-key"\n`);
    const settings = await service({
      FILE_RENAMER_API__TMDB_API_KEY: "env-key",
      FILE_RENAMER_API__TVDB_PIN: "env-pin",
    }).load();
    expect(settings.api.tmdbApiKey).toBe("file-key");
    expect(settings.api.tvdbPin).toBe("env-pin");
  });

  it("raises ConfigError for invalid environment values", async () => {
    await expect(service({ FILE_RENAMER_DRY_RUN: "maybe" }).load()).rejects.toThrow(
      /behavior\.dry_run/,
    );
    await expect(service({ FILE_RENAMER_API: "not json" }).load()).rejects.toThrow(
      ConfigError,
    );
  });
});

describe("API keys", () => {
  it("gets and sets TMDB and TVDB keys, saving to disk", async () => {
    const s = service();
    expect(await s.getApiKey("tmdb")).toBe("");
    await s.setApiKey("tmdb", "tm");
    await s.setApiKey("tvdb", "tv");
    expect(await s.getApiKey("tmdb")).toBe("tm");
    expect(await s.getApiKey("tvdb")).toBe("tv");
    expect(await s.getApiKey("musicbrainz")).toBe("");

    const reloaded = service();
    expect(await reloaded.getApiKey("tmdb")).toBe("tm");
    expect(await reloaded.getApiKey("tvdb")).toBe("tv");
  });
});

describe("history", () => {
  const opA: HistoryOperation = {
    source: "/media/old/a.mkv",
    destination: "/media/New A (2024).mkv",
    associatedFiles: [
      { source: "/media/old/a.en.srt", destination: "/media/New A (2024).en.srt" },
    ],
  };

  it("is empty when there is no history file", async () => {
    const s = service();
    expect(await s.loadHistory()).toEqual([]);
    expect(await s.getLastOperations()).toEqual([]);
    await s.clearLastHistory();
    expect(existsSync(s.historyFile)).toBe(false);
  });

  it("writes the Python on-disk format", async () => {
    const s = service();
    await s.saveHistory([opA]);
    const text = await readFile(s.historyFile, "utf8");
    const raw = JSON.parse(text) as Array<Record<string, unknown>>;
    expect(raw).toHaveLength(1);
    expect(raw[0]!.timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{6})?$/);
    expect(raw[0]!.operations).toEqual([
      {
        source: opA.source,
        destination: opA.destination,
        associated_files: [
          { source: opA.associatedFiles[0]!.source, destination: opA.associatedFiles[0]!.destination },
        ],
      },
    ]);
    // json.dump(indent=2) layout.
    expect(text.startsWith('[\n  {\n    "timestamp": "')).toBe(true);
  });

  it("escapes non-ASCII characters like Python's json.dump", async () => {
    const s = service();
    await s.saveHistory([
      { source: "/m/Amélie 🎬.mkv", destination: "/m/Amélie (2001).mkv", associatedFiles: [] },
    ]);
    const text = await readFile(s.historyFile, "utf8");
    expect(text).toContain("Am\\u00e9lie \\ud83c\\udfac.mkv");
    expect(/^[\x00-\x7f]*$/.test(text)).toBe(true);
    expect((await s.getLastOperations())[0]!.source).toBe("/m/Amélie 🎬.mkv");
  });

  it("reads a history file written by Python, preserving unknown keys", async () => {
    const pythonHistory = `[
  {
    "timestamp": "2026-11-07T19:00:00.123456",
    "operations": [
      {
        "source": "/media/Breaking.Bad.S01E01.mkv",
        "destination": "/media/Breaking Bad - S01E01 - Pilot.mkv",
        "associated_files": [
          {
            "source": "/media/Breaking.Bad.S01E01.srt",
            "destination": "/media/Breaking Bad - S01E01 - Pilot.srt"
          }
        ]
      },
      {
        "source": "/media/Caf\\u00e9.mkv",
        "destination": "/media/Cafe.mkv",
        "note": "kept"
      }
    ]
  },
  {
    "timestamp": "2026-11-06T08:30:00",
    "operations": []
  }
]`;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(configDir, { recursive: true });
    const s = service();
    await writeFile(s.historyFile, pythonHistory);

    const history = await s.loadHistory();
    expect(history.map((h) => h.timestamp)).toEqual([
      "2026-11-07T19:00:00.123456",
      "2026-11-06T08:30:00",
    ]);
    expect(await s.getLastOperations()).toEqual([
      {
        source: "/media/Breaking.Bad.S01E01.mkv",
        destination: "/media/Breaking Bad - S01E01 - Pilot.mkv",
        associatedFiles: [
          {
            source: "/media/Breaking.Bad.S01E01.srt",
            destination: "/media/Breaking Bad - S01E01 - Pilot.srt",
          },
        ],
      },
      { source: "/media/Café.mkv", destination: "/media/Cafe.mkv", associatedFiles: [] },
    ]);

    await s.saveHistory([opA]);
    const raw = JSON.parse(await readFile(s.historyFile, "utf8")) as Array<{
      operations: Array<Record<string, unknown>>;
    }>;
    expect(raw).toHaveLength(3);
    expect(raw[1]!.operations[1]!.note).toBe("kept");
    expect(raw[1]!.operations[1]).not.toHaveProperty("associated_files");
  });

  it("keeps the [history] max_entries most recent entries, newest first", async () => {
    await writeConfig("[history]\nmax_entries = 10\n");
    const s = service();
    await s.load();
    for (let i = 0; i < 12; i++) {
      await s.saveHistory([{ source: `/s${i}`, destination: `/d${i}`, associatedFiles: [] }]);
    }
    const history = await s.loadHistory();
    expect(history).toHaveLength(10);
    expect(history[0]!.operations[0]!.source).toBe("/s11");
    expect(history[9]!.operations[0]!.source).toBe("/s2");
  });

  it("clears only the most recent entry", async () => {
    const s = service();
    await s.saveHistory([{ source: "/old", destination: "/x", associatedFiles: [] }]);
    await s.saveHistory([opA]);
    await s.clearLastHistory();
    expect((await s.getLastOperations())[0]!.source).toBe("/old");
    await s.clearLastHistory();
    expect(await s.loadHistory()).toEqual([]);
  });

  it("treats a corrupt history file as empty", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(configDir, { recursive: true });
    const s = service();
    await writeFile(s.historyFile, "{not json");
    expect(await s.loadHistory()).toEqual([]);
  });

  it("builds history records from rename operations", () => {
    const op = createRenameOperation({
      source: "/a.mkv",
      destination: "/b.mkv",
      mediaFile: { path: "/a.mkv", parsedInfo: createParsedInfo({ title: "a" }) },
      status: "completed",
      associatedFiles: [{ source: "/a.srt", destination: "/b.srt", fileType: "subtitle" }],
    });
    expect(toHistoryOperation(op)).toEqual({
      source: "/a.mkv",
      destination: "/b.mkv",
      associatedFiles: [{ source: "/a.srt", destination: "/b.srt" }],
    });
  });

  it("formats timestamps like datetime.isoformat()", () => {
    expect(pythonIsoTimestamp(new Date(2026, 10, 7, 19, 5, 9, 120))).toBe(
      "2026-11-07T19:05:09.120000",
    );
    expect(pythonIsoTimestamp(new Date(2026, 0, 2, 3, 4, 5, 0))).toBe("2026-01-02T03:04:05");
  });
});
