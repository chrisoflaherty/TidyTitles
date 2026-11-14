# CLI Reference

Complete reference for the `tidytitles` command. To install it, see [The command-line tool](Installation.md#the-command-line-tool). Everything here also applies to `file-renamer`, the CLI's second name; help text and hints then show `file-renamer` instead of `tidytitles`.

- [Synopsis and global options](#synopsis-and-global-options)
- [rename](#rename)
- [preview](#preview)
- [undo](#undo)
- [config](#config)
- [Exit codes](#exit-codes)
- [Environment variables](#environment-variables)
- [Output, colors, and scripting](#output-colors-and-scripting)
- [Interactive prompts and non-interactive use](#interactive-prompts-and-non-interactive-use)
- [Ctrl+C](#ctrlc)

## Synopsis and global options

```
tidytitles [options] [command]
```

| Option | Description |
|--------|-------------|
| `--version` | Show the version and exit |
| `--config-dir <dir>` | Config directory (default: the user config directory; env `TIDYTITLES_CONFIG_DIR`) |
| `--no-color` | Disable colors |
| `-h, --help` | Show this message and exit |

Global options go before or after the command: `tidytitles --config-dir /tmp/tt config show` and `tidytitles config show --config-dir /tmp/tt` are the same.

| Command | Description |
|---------|-------------|
| `rename [options] <path>` | Rename media files in PATH (a file or directory). |
| `preview [options] <path>` | Preview how files in PATH parse, without looking up metadata or renaming. |
| `undo [options]` | Undo the last rename operation, using the saved history. |
| `config` | Manage configuration settings. |
| `help [command]` | Show help for a command |

`tidytitles help rename` and `tidytitles rename --help` print the same thing. Running `tidytitles` with no command prints the help and exits with status 1.

### `--config-dir`

By default the CLI uses the same settings folder as the desktop app (and the Python app); see [Configuration](Configuration.md#where-files-are-stored). `--config-dir <dir>` uses `<dir>/config.toml` and `<dir>/history.json` instead, with the cache in `<dir>/cache`. The folder is created when something is saved. The `TIDYTITLES_CONFIG_DIR` environment variable does the same; when both are given, `--config-dir` wins.

```bash
tidytitles --config-dir ~/tidytitles-test config init
```

---

## rename

Rename media files in PATH (a file or directory).

```
tidytitles rename [options] <path>
```

| Option | Description |
|--------|-------------|
| `-t, --type <type>` | Media type: `auto`, `movie`, `tv`, or `music` (default: `auto`) |
| `-r, --recursive` | Scan directories recursively |
| `-o, --output <dir>` | Output directory for renamed files |
| `-n, --dry-run` | Preview changes without renaming |
| `-y, --yes` | Skip confirmation prompt |
| `-a, --auto-select` | Automatically select first match when multiple results found |
| `-p, --provider <provider>` | Metadata provider: `auto`, `tmdb`, `tvdb`, or `musicbrainz` (default: `auto`) |
| `-c, --cover-art` | Download cover art (posters/album covers) after renaming |
| `--json` | Print the result as JSON |
| `-h, --help` | Show this message and exit |

### What it does

1. **Finds files.** A file named directly is always processed, whatever its extension. A directory is scanned for media files: video files for `--type movie` and `--type tv`, audio files for `--type music`, both for `auto`. Subdirectories are scanned only with `--recursive`. Hidden files and folders are skipped, and extensions match regardless of case. See [GUI Guide](GUI-Guide.md#1-add-files) for the extension list.
2. **Parses and looks up each file.** With `--type auto`, each video file is treated as a movie or a TV episode according to its name; `--type movie` and `--type tv` force one or the other. Audio files are always music. Progress is shown on a terminal.
3. **Shows a preview table** (`Rename Preview`) with each file's new name, associated files indented under it, and a reason for every file that will be skipped.
4. **Asks** `Proceed with rename?` unless `--yes` or `--dry-run` is given.
5. **Renames**, prints `Completed`, `Failed`, and `Skipped` counts with an error line per failed file, and saves the completed renames to the history for `undo`.
6. **Downloads cover art** if `--cover-art` is given or `[cover_art] enabled = true` in `config.toml`.

### Providers

`--provider` chooses which services are used:

| `--provider` | Movies | TV | Music | Keys required |
|--------------|--------|----|-------|---------------|
| `auto` | TMDB | TVDB or TMDB, see below | MusicBrainz | TMDB or TVDB, unless `--type music` |
| `tmdb` | TMDB | TMDB | not looked up | TMDB |
| `tvdb` | not looked up | TVDB | not looked up | TVDB |
| `musicbrainz` | not looked up | not looked up | MusicBrainz | none |

With `auto`, TV uses the service named in `[providers] tv` (`tvdb` by default) when its key is set, and otherwise whichever of TMDB and TVDB has a key. Movie and TV files that are not looked up are skipped as `no match`. Music files that are not looked up are still renamed from their own tags.

A missing key stops the command before anything is touched:

```
$ tidytitles rename ~/Downloads
Error: No API keys configured. Run 'tidytitles config set-key tmdb YOUR_API_KEY' (or 'tvdb') to configure, or use --type music.

$ tidytitles rename ~/Shows -p tvdb
Error: TVDB API key not configured. Run 'tidytitles config set-key tvdb YOUR_API_KEY' to set one.
```

### Choosing among several matches

When a search finds several results, the CLI shows them in a table:

```
Multiple matches found for: The.Matrix.1999.1080p.BluRay.x264.mkv

Select Match
┌───┬──────────────────────────┬─────────────┬───────┐
│ # │ Title                    │ Artist/Year │ Type  │
├───┼──────────────────────────┼─────────────┼───────┤
│ 1 │ The Matrix               │ 1999        │ Movie │
│ 2 │ The Matrix Revisited     │ 2001        │ Movie │
│ 3 │ The Matrix Resurrections │ 2021        │ Movie │
└───┴──────────────────────────┴─────────────┴───────┘
```

It then asks `Select match (1-3) or skip:` with a list of the matches, for example `1. The Matrix (1999)`, followed by `Skip this file`. Move with the arrow keys and press Enter. For music the second column shows the artist and album instead of the year.

- `--auto-select` takes the first result without asking.
- When standard input is not a terminal, nothing is asked: files with several results are skipped and reported ("*N* file(s) had several matches and were skipped because stdin is not a terminal. Use --auto-select to take the first match."), unless `--auto-select` is given.

### Skip reasons in the preview

| Shown as | Meaning |
|----------|---------|
| `(skipped: no match)` | Nothing found, the selection was skipped, or the provider does not cover this type. |
| `(skipped: lookup failed: ...)` | The service returned an error or could not be reached. Reported on stderr as "Metadata lookup failed for *N* file(s): ...". |
| `(skipped: template error: ...)` | The template could not be rendered. |
| `(skipped: duplicate destination)` | An earlier file in the batch gets the same new name. |

After renaming, two more outcomes are counted as skipped: the file already had its new name, or the new name was taken (`conflict_resolution = "skip"`, or the existing file is part of the same batch). See [Conflict resolution](Configuration.md#conflict-resolution).

If no file can be renamed, the CLI prints `No matches found.` and stops.

### `--output`

`--output <dir>` puts renamed files in `<dir>` instead of next to the originals. Folders in the template are created under it. Associated files go next to their main file's new location.

```bash
tidytitles rename ~/Downloads --type movie --output /Volumes/Media/Movies
```

### `--dry-run`

Looks everything up and shows the preview, then prints `Dry run - no files were renamed.` Nothing is renamed, no history is saved, and no cover art is downloaded. A dry run still needs API keys, and it still exits 1 if a lookup failed.

### Examples

```bash
# Preview movies in Downloads without renaming
tidytitles rename ~/Downloads --type movie --dry-run

# Rename a TV folder and its subfolders, no questions asked
tidytitles rename /media/shows -t tv -r -y --auto-select

# Music only, no API key needed, result as JSON
tidytitles rename /music -t music -p musicbrainz --json

# Rename and move into a library folder, then fetch posters
tidytitles rename ~/Downloads -t movie -o ~/Movies --cover-art

# A single file
tidytitles rename ~/Downloads/Inception.2010.720p.WEB-DL.mkv
```

### JSON output

With `--json`, the CLI prints one JSON object on stdout when it finishes (and no preview table):

```json
{
  "command": "rename",
  "path": "/Users/me/Music/Inbox",
  "dryRun": false,
  "files": 1,
  "confirmed": true,
  "operations": [
    {
      "source": "/Users/me/Music/Inbox/Band - Record - 01 - Song.mp3",
      "destination": "/Users/me/Music/Inbox/Band/Record/01 - Song.mp3",
      "status": "completed",
      "skipReason": null,
      "error": null,
      "lookupError": null,
      "mediaType": "music",
      "match": {
        "kind": "track",
        "id": "local",
        "title": "Song",
        "artist": "Band",
        "album": "Record",
        "year": null,
        "trackNumber": 1,
        "discNumber": null,
        "verificationStatus": "unverified"
      },
      "associatedFiles": []
    }
  ],
  "summary": { "total": 1, "completed": 1, "failed": 0, "skipped": 0, "pending": 0, "associatedFiles": 0, "totalFiles": 1 },
  "skippedSelections": [],
  "coverArt": [],
  "historySaved": 1
}
```

| Field | Meaning |
|-------|---------|
| `confirmed` | `true` or `false` for the answer to "Proceed with rename?", `true` with `--yes`, `null` when nothing was asked (dry run, nothing to rename). |
| `operations[].status` | `pending` (dry run, or not confirmed), `completed`, `failed`, or `skipped`. |
| `operations[].skipReason` | `no_match`, `lookup_failed`, `unknown_metadata`, `template_error`, `duplicate_destination`, `same_path` (already named), `would_overwrite` (name taken), or `null`. |
| `operations[].lookupError` | `{ kind, name, message }` when the lookup failed; `kind` is `authentication` (bad key), `rate_limit`, `provider`, or `other`. |
| `operations[].mediaType` | `movie`, `tv_episode`, `music`, or `unknown`, as parsed from the name. |
| `operations[].match` | The metadata used (`kind` is `movie`, `episode`, or `track`), with `verificationStatus`: `auto_matched`, `manual_selection`, `verified`, `unverified`, or `from_provider`. See [Review the new names](GUI-Guide.md#4-review-the-new-names). |
| `skippedSelections` | Files skipped because they had several matches and stdin was not a terminal. |
| `coverArt` | Paths of cover art saved or already present. |
| `historySaved` | Number of renames recorded for `undo`. |

API keys never appear in JSON output.

---

## preview

Preview how files in PATH parse, without looking up metadata or renaming. No API keys are needed and nothing is sent over the network.

```
tidytitles preview [options] <path>
```

| Option | Description |
|--------|-------------|
| `-r, --recursive` | Scan directories recursively |
| `--json` | Print the result as JSON: `{ command, path, files: [{ path, filename, mediaType, title, year, season, episode }] }` |
| `-h, --help` | Show this message and exit |

`preview` scans directories for **video files only** (a file named directly is always shown). Use it to check what the parser reads from your filenames before a rename.

```
$ tidytitles preview ~/Downloads
Parsed File Information
┌──────────────────────────────────────────┬────────────┬──────────────┬──────┬────────┬─────────┐
│ Filename                                 │ Type       │ Title        │ Year │ Season │ Episode │
├──────────────────────────────────────────┼────────────┼──────────────┼──────┼────────┼─────────┤
│ Breaking.Bad.S01E01.720p.BluRay.x264.mkv │ tv_episode │ Breaking Bad │ -    │ 1      │ 1       │
│ The.Matrix.1999.1080p.BluRay.x264.mkv    │ movie      │ The Matrix   │ 1999 │ -      │ -       │
└──────────────────────────────────────────┴────────────┴──────────────┴──────┴────────┴─────────┘
```

With no video files it prints `No video files found.`

---

## undo

Undo the last rename operation, using the saved history.

```
tidytitles undo [options]
```

| Option | Description |
|--------|-------------|
| `-y, --yes` | Skip confirmation prompt |
| `--json` | Print the result as JSON: `{ command, historyFound, timestamp, confirmed, items: [{ source, destination, status, errors }], undone, missing, failed }` |
| `-h, --help` | Show this message and exit |

```
$ tidytitles undo
Last rename: Nov 14, 2026, 9:24 AM
Found 1 file(s) to undo:
  01 - Hells Bells.mp3 → AC-DC - Back in Black - 01 - Hells Bells.mp3

Proceed with undo? [y/N]: y

Undone: 1
```

- It reverts the most recent entry in the history, whether the CLI, the desktop app, or the Python app made it. Associated files are moved back too. The history keeps the last 10 renames, so you can run `undo` repeatedly to go further back.
- Each file ends up **undone**, **not found** (nothing at the renamed path any more; counted as `Not found`), or **failed** (for example, its original name is now taken; undo never overwrites).
- When everything worked, the entry is removed from the history. When some files failed, the entry keeps only those files, so you can fix the cause and run `undo` again. When nothing could be moved at all, the entry is left as it was.
- If another rename is recorded between the listing and your answer, undo stops without moving anything and asks you to review and try again.
- Folders created by the rename are not removed.
- With no history it prints `No rename history found.` and exits 0. Answering no prints `Aborted.` and exits 0.
- Exits 1 when any file could not be moved back.

---

## config

Manage configuration settings. All `config` commands work on `config.toml` in the config directory (see [`--config-dir`](#--config-dir)). For settings these commands do not cover (conflict handling, associated files, cover art, the TVDB PIN), edit `config.toml`; see [Configuration](Configuration.md).

| Command | Description |
|---------|-------------|
| `config show [--json]` | Show current configuration (API keys are shown only as configured / not set). |
| `config set-key <provider> <key>` | Set an API key for a provider (`tmdb` or `tvdb`). |
| `config set-template <type> <template>` | Set a naming template (`movie`, `tv`, or `music`). |
| `config init` | Initialize configuration file with defaults (asks before overwriting). |

### config show

```
$ tidytitles config show
Current Configuration

Config file: /Users/me/Library/Application Support/file-renamer/config.toml
Cache dir: /Users/me/Library/Caches/file-renamer

Templates:
  Movie: {title} ({year})
  TV:    {title} - S{season2}E{episode2} - {episode_title}
  Music: {artist}/{album} ({year})/{track2} - {title}

API Keys:
  TMDB: configured
  TVDB: not set

Associated Files:
  Enabled:   enabled
  Subtitles: ✓
  NFO files: ✓
  Images:    ✓

Behavior:
  Conflict resolution: skip
  Preview before rename: True
```

The values shown are the effective ones: defaults, then `FILE_RENAMER_*` environment variables, then `config.toml` on top. `--json` prints every setting, including cover art and providers:

```json
{
  "configFile": "/Users/me/Library/Application Support/file-renamer/config.toml",
  "cacheDir": "/Users/me/Library/Caches/file-renamer",
  "templates": { "movie": "{title} ({year})", "tv": "{title} - S{season2}E{episode2} - {episode_title}", "music": "{artist}/{album} ({year})/{track2} - {title}" },
  "apiKeys": { "tmdb": "configured", "tvdb": "not set" },
  "associatedFiles": { "enabled": true, "subtitles": true, "nfo": true, "images": true },
  "coverArt": { "enabled": false, "filename": "poster.jpg", "musicFilename": "cover.jpg", "overwrite": false, "size": "w500" },
  "behavior": { "dryRun": false, "overwrite": false, "previewBeforeRename": true, "conflictResolution": "skip" },
  "providers": { "movie": "tmdb", "tv": "tvdb", "music": "musicbrainz" }
}
```

### config set-key

```bash
tidytitles config set-key tmdb YOUR_TMDB_API_KEY
tidytitles config set-key tvdb YOUR_TVDB_API_KEY
```

Prints `API key for TMDB saved.` The key is written to `config.toml` (creating it with defaults if needed). The TVDB subscriber PIN has no command; set it in the desktop app or in `config.toml`.

Note that the key appears in your shell history. To avoid that, use the desktop app's Settings window or edit `config.toml`.

### config set-template

```bash
tidytitles config set-template movie "{title} ({year}) [{quality}]"
tidytitles config set-template tv "{title}/Season {season2}/{title} - S{season2}E{episode2} - {episode_title}"
tidytitles config set-template music "{artist}/{album} ({year})/{track2} - {title}"
```

Quote the template so the shell passes it as one argument. The template is checked first; an invalid one is not saved and the command exits 1:

```
$ tidytitles config set-template music "{artst}/{title|foo}"
Invalid template:
  - Unknown field: {artst}
  - Unknown formatter: foo
```

See [Templates](Templates.md) for placeholders and formatters.

### config init

Writes `config.toml` with the default settings (plus any values from `FILE_RENAMER_*` environment variables) and prints the next steps. If the file exists, it asks `Config file exists. Overwrite?` first; overwriting replaces your API keys and templates with the defaults. You do not need to run `config init`: every command works without a config file, and `set-key` and `set-template` create it.

---

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error (configuration, metadata lookup, or rename failure) |
| `2` | Usage error (bad option or argument, PATH does not exist) |
| `130` | Canceled with Ctrl+C |

In detail, `rename` exits 1 when a required API key is missing, `config.toml` cannot be read, any file's lookup failed, or any rename failed; files that were skipped for other reasons (no match, name taken) do not cause a non-zero exit. It also exits 1 when the confirmation reads end of input from a non-terminal stdin (`Aborted!`). Answering no to the confirmation exits 0. `undo` exits 1 when any file could not be moved back. `config set-template` exits 1 for an invalid template.

## Environment variables

| Variable | Effect |
|----------|--------|
| `TIDYTITLES_CONFIG_DIR` | Config directory (same as `--config-dir`; the option wins) |
| `FILE_RENAMER_API__TMDB_API_KEY` | TMDB API key, used when `config.toml` has none |
| `FILE_RENAMER_API__TVDB_API_KEY` | TVDB API key, used when `config.toml` has none |
| `NO_COLOR` | Disable colors (same as `--no-color`), when set to any non-empty value |
| `FORCE_COLOR` | Use colors even when output is not a terminal (any value except empty or `0`); `--no-color` and `NO_COLOR` still win |
| `DEBUG` | Print stack traces for errors |

"Used when `config.toml` has none" means the key must be **absent** from the file, not just empty. `config init`, `config set-key`, `config set-template`, and saving in the desktop app all write a full file with `tmdb_api_key = ""`, and that empty value wins over the environment. Delete the `tmdb_api_key` (or `tvdb_api_key`) line from `config.toml` to use the variable. Every other setting can be given the same way; see [Environment variables](Configuration.md#environment-variables).

## Output, colors, and scripting

- **Results go to stdout**: preview tables, counts, `config show`, and JSON.
- **Progress, prompts, warnings, and errors go to stderr.** Progress is shown only when stderr is a terminal.
- **Colors** are used only on a terminal, and never with `--no-color` or `NO_COLOR`.
- **Errors** are printed as `Error: ...`. With `DEBUG` set, a stack trace follows.
- **Dates** are printed as month-first, 12-hour times, for example `Nov 14, 2026, 9:24 AM`.

A typical script:

```bash
#!/bin/sh
tidytitles rename /media/inbox --type movie --recursive --yes --auto-select --json > result.json
status=$?
if [ "$status" -ne 0 ]; then
  echo "Some files could not be renamed or looked up; see result.json" >&2
fi
```

## Interactive prompts and non-interactive use

| Situation | On a terminal | When stdin is not a terminal |
|-----------|---------------|------------------------------|
| Several matches for a file | Pick from a list or skip | File skipped and reported, unless `--auto-select` |
| `Proceed with rename?` / `Proceed with undo?` | Yes/no prompt (default no) | Reads one line from stdin: `y`/`yes` or `n`/`no`, blank means no. End of input aborts with exit 1. |
| `Config file exists. Overwrite?` | Yes/no prompt (default no) | Same as above |

So `echo y | tidytitles rename ~/Downloads` works, but `--yes` is clearer in scripts.

## Ctrl+C

- **While scanning, looking up, or at a prompt:** the first Ctrl+C cancels cleanly; the CLI prints `Canceled.` and exits 130. Nothing has been renamed at that point. A second Ctrl+C exits at once.
- **While renaming:** renaming is never cut short, so no file is left half-done and the history needed for `undo` is always written. After a Ctrl+C the CLI finishes renaming, saves the history, prints the results, skips cover art, and exits 130. A second Ctrl+C prints `Still renaming. Stopping once the history for undo is saved.` and does not exit early.
