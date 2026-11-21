# CLI Reference

Complete reference for the `tidytitles` command. To install it, see [The command-line tool](Installation.md#the-command-line-tool). Everything here also applies to `file-renamer`, the CLI's second name; help text and hints then show `file-renamer` instead of `tidytitles`.

- [Synopsis and global options](#synopsis-and-global-options)
- [rename](#rename)
- [preview](#preview)
- [undo](#undo)
- [watch](#watch)
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
| `-o, --output <dir>` | Output directory for renamed files (overrides the `[output]` folders) |
| `--transfer <mode>` | How files get their new names: `move`, `copy`, or `hardlink` (default: `[output] transfer_mode`, normally `move`) |
| `-n, --dry-run` | Preview changes without renaming |
| `-y, --yes` | Skip confirmation prompt |
| `-a, --auto-select` | Automatically select first match when multiple results found |
| `-p, --provider <provider>` | Metadata provider: `auto`, `tmdb`, `tvdb`, or `musicbrainz` (default: `auto`) |
| `-c, --cover-art` | Download cover art (posters/album covers) after renaming |
| `--order <order>` | Episode order: `aired`, `dvd`, or `absolute` (default: `tv.episode_order` in config.toml) |
| `--language <code>` | Metadata language, such as `en-US`, `de-DE`, `pt-BR`, or `ja` (default: `metadata.language`) |
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

It then asks `Select match (1-3) or skip:` with a list of the matches, for example `1. The Matrix (1999)`, followed by `Search with different words...` (see [Searching with different words](#searching-with-different-words)) and `Skip this file`. Move with the arrow keys and press Enter. For music the second column shows the artist and album instead of the year.

- You are asked each question once per run. When later files produce the same list of matches (every episode of one show, or two copies of a movie), your answer, or your skip, is applied to them too. For music, once you pick a track, other files in the same folder take the match on the same album without asking.
- `--auto-select` takes the first result without asking.
- When standard input is not a terminal, nothing is asked: files with several results are skipped and reported ("*N* file(s) had several matches and were skipped because stdin is not a terminal. Use --auto-select to take the first match."), unless `--auto-select` is given.

### Skip reasons in the preview

| Shown as | Meaning |
|----------|---------|
| `(skipped: no match)` | Nothing found, the selection was skipped, or the provider does not cover this type. |
| `(skipped: lookup failed: ...)` | The service returned an error or could not be reached. Reported on stderr as "Metadata lookup failed for *N* file(s): ...". |
| `(skipped: template error: ...)` | The template could not be rendered. |
| `(skipped: duplicate destination)` | An earlier file in the batch gets the same new name. |
| `(skipped: can't hard link to another volume)` | `--transfer hardlink`, but the new name would be on another drive. The file is not copied instead. |

After renaming, more outcomes are counted as skipped (in hard-link mode, also a drive without hard links, `the volume doesn't support hard links`): the file already had its new name, or the new name was taken (`conflict_resolution = "skip"`, or the existing file is part of the same batch). See [Conflict resolution](Configuration.md#conflict-resolution).

If no file can be renamed, the CLI prints `No matches found.` and stops.

### `--order` and `--language`

`--order` says how the season and episode numbers in the file names count, and how the new names count: `aired` (broadcast order), `dvd`, or `absolute` (one running number, for anime). TVDB has all three; TMDB has DVD order only for shows with a DVD episode group, and says so before the lookups start:

```
TMDB has DVD order only for shows with a DVD episode group; files of other shows are left unmatched.
```

Files of a show without one fail with lookup error kind `order_unavailable`. Files without a season (`[Group] Show - 123`) are always read as absolute numbers, and files named by date (`Show.2024.03.15`) are found by their air date.

`--language` gets titles in that language when the service has a translation, otherwise in English, then in the original language. It accepts `de`, `de-DE`, or `de_de`; anything that is not a language code is a usage error (exit 2). See [Configuration](Configuration.md#tv-and-metadata) for both settings.

```bash
# Anime numbered 1 to 1100, named in absolute order with Japanese titles
tidytitles rename ~/Anime/One\ Piece -t tv --order absolute --language ja-JP --dry-run

# A show whose files follow the DVD order
tidytitles rename ~/TV/Firefly -t tv -p tvdb --order dvd
```

### `--output`

`--output <dir>` puts renamed files in `<dir>` instead of next to the originals, whatever their type. Folders in the template are created under it. Associated files go next to their main file's new location. The folder is created if it does not exist.

Without `--output`, files go to the `[output]` folders in `config.toml` (one each for movies, TV, and music; empty means next to the original). The preview names them first:

```
Output folder: /Volumes/Media/Movies
Transfer: copy (the originals stay where they are)
```

A configured `[output]` folder is never created: if it is missing (for example, the drive is not connected), a file instead of a folder, or not writable, `rename` exits 1 with a message such as `Error: The movie output folder doesn't exist (is the drive connected?): /Volumes/Media/Movies`, before anything is renamed. See [Output folders and transfer modes](Configuration.md#output-folders-and-transfer-modes).

```bash
tidytitles rename ~/Downloads --type movie --output /Volumes/Media/Movies
```

### `--transfer`

`--transfer copy` makes renamed copies and leaves the originals; `--transfer hardlink` adds the new name as a hard link (same drive only; files whose destination is on another drive are skipped, never copied). Associated files use the same mode. `undo` deletes the copies or links, only if they are unchanged, and never touches the originals.

```bash
tidytitles rename ~/Downloads -t movie -o /Volumes/Media/Movies --transfer copy
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
      "correction": null,
      "associatedFiles": []
    }
  ],
  "summary": { "total": 1, "completed": 1, "failed": 0, "skipped": 0, "pending": 0, "associatedFiles": 0, "totalFiles": 1 },
  "skippedSelections": [],
  "coverArt": [],
  "historySaved": 1,
  "transfer": "move",
  "outputFolders": false
}
```

| Field | Meaning |
|-------|---------|
| `confirmed` | `true` or `false` for the answer to "Proceed with rename?", `true` with `--yes`, `null` when nothing was asked (dry run, nothing to rename). |
| `operations[].status` | `pending` (dry run, or not confirmed), `completed`, `failed`, or `skipped`. |
| `operations[].skipReason` | `no_match`, `lookup_failed`, `unknown_metadata`, `template_error`, `duplicate_destination`, `same_path` (already named), `would_overwrite` (name taken), `cross_device_link` (hard link to another drive), `link_unsupported` (drive without hard links), or `null`. |
| `operations[].lookupError` | `{ kind, name, message }` when the lookup failed; `kind` is `authentication` (bad key), `rate_limit`, `provider`, or `other`. |
| `operations[].mediaType` | `movie`, `tv_episode`, `music`, or `unknown`, as parsed from the name. |
| `operations[].match` | The metadata used (`kind` is `movie`, `episode`, or `track`), with `verificationStatus`: `auto_matched`, `manual_selection`, `verified`, `unverified`, or `from_provider`. See [Review the new names](GUI-Guide.md#4-review-the-new-names). |
| `operations[].correction` | `"chosen"` when you picked the match with [Search with different words](#searching-with-different-words), otherwise `null`. |
| `skippedSelections` | Files skipped because they had several matches and stdin was not a terminal. |
| `coverArt` | Paths of cover art saved or already present. |
| `historySaved` | Number of renames recorded for `undo`. |
| `transfer` | `move`, `copy`, or `hardlink`. |
| `outputFolders` | Whether any output folder (`--output` or `[output]`) was in effect. |

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

Undo the last rename operation (or an older one), using the saved history.

```
tidytitles undo [options]
```

| Option | Description |
|--------|-------------|
| `-y, --yes` | Skip confirmation prompt |
| `-l, --list` | List the rename history (most recent first) instead of undoing |
| `-e, --entry <number>` | Undo this entry of `--list` instead of the most recent (1 is the most recent) |
| `--json` | Print the result as JSON: `{ command, historyFound, timestamp, confirmed, items: [{ source, destination, status, errors, kept }], undone, missing, kept, failed }`; with `--list`: `{ command, history: [{ entry, timestamp, operations, files, transfer, samples }] }` |
| `-h, --help` | Show this message and exit |

```
$ tidytitles undo
Last rename: Nov 14, 2026, 9:24 AM
Found 1 file(s) to undo:
  01 - Hells Bells.mp3 → AC-DC - Back in Black - 01 - Hells Bells.mp3

Proceed with undo? [y/N]: y

Undone: 1
```

- It reverts the most recent entry in the history, whether the CLI, the desktop app, or the Python app made it. Associated files are moved back too. The history keeps the last 200 renames (`[history] max_entries`), so you can run `undo` repeatedly to go further back, or pick one with `--entry`.
- Copies and hard links are undone by deleting them, only if they are unchanged since the rename; the originals are never touched.
- Each file ends up **undone**, **not found** (nothing at the renamed path any more; counted as `Not found`), **left in place** (it is not the file the rename produced: replaced or changed since, a copy whose original is gone, or, in entries from older versions without fingerprints, a file a later rename touched; printed as `Left in place: name (reason)`), or **failed** (for example, its original name is now taken; undo never overwrites).
- When everything worked, the entry is removed from the history. When some files failed, the entry keeps only those files, so you can fix the cause and run `undo` again. When nothing could be moved at all, the entry is left as it was.
- If another rename is recorded between the listing and your answer, undo stops without moving anything and asks you to review and try again.

`--list` shows the history with en-US dates:

```
$ tidytitles undo --list
Rename History
┌───┬────────────────────────┬───────┬────────┬───────────────────────────────────┐
│ # │ Renamed                │ Files │ How    │ First file                        │
├───┼────────────────────────┼───────┼────────┼───────────────────────────────────┤
│ 1 │ Nov 21, 2026, 9:15 AM  │ 1     │ Copied │ B (2002).mkv                      │
│ 2 │ Nov 7, 2026, 7:00 PM   │ 3     │ Moved  │ A (2001).mkv and 1 more           │
└───┴────────────────────────┴───────┴────────┴───────────────────────────────────┘

Undo one with 'tidytitles undo --entry <#>'.
```

`--entry 2` then undoes the November 7 rename and leaves the later one alone. A file that a later rename moved away is reported as not found; one that was replaced since is left in place. A number beyond the history is a usage error (exit 2).
- Folders created by the rename are not removed.
- With no history it prints `No rename history found.` and exits 0. Answering no prints `Aborted.` and exits 0.
- Exits 1 when any file could not be moved back.

---

## watch

```
tidytitles watch [OPTIONS] [FOLDERS...]
```

Watches folders for new media files and looks each one up once it has finished arriving. It runs in the foreground, logs one line for everything it notices and does, and **never asks anything**. Stop it with Ctrl+C. Without FOLDERS it watches the `[watch] folders` from `config.toml`.

| Option | Description |
|--------|-------------|
| `-t, --type TYPE` | `movie`, `tv`, `music`, or `auto` (default) |
| `-r, --recursive` / `--no-recursive` | Include subfolders, or not (default: `[watch] recursive`, normally on) |
| `--auto` | Automatic mode: rename files with exactly one match without asking |
| `--existing` | Also process the files already in the folders |
| `--settle SECONDS` | How long a file must stay unchanged first, 2 to 3600 (default: `[watch] settle_seconds`, normally 10) |
| `-o, --output DIR` | Put renamed files here (overrides the `[output]` folders; created when missing) |
| `--transfer MODE` | `move`, `copy`, or `hardlink` (default: `[output] transfer_mode`) |
| `-p, --provider NAME` | As for `rename` |
| `--order ORDER`, `--language CODE` | As for `rename` |
| `--json` | One JSON object per line |

**Review mode** (without `--auto`) renames nothing, because nobody is there to confirm. Each file is reported as `Ready for review: Name.2010.mkv → Name (2010).mkv`, or `Needs review: Name.mkv (several matches found; choose one)` with the reason. Rename them afterward with `tidytitles rename <folder>`, which shows the preview and asks as usual. `[watch] mode` is not used by this command: it renames automatically only with `--auto`.

**Automatic mode** (`--auto`) renames a file only when its lookup found exactly one match, its new name is free (whatever `conflict_resolution` says), and it is still the file that finished arriving; everything else is reported as `Needs review` and left alone. The renames are saved to the history (undo with `tidytitles undo`). The exact rules, the list of temporary download names, and what happens to folders that go missing are in [Configuration → Watch folders](Configuration.md#watch-folders).

Files already in the folders when it starts are counted and left alone (`--existing` processes them). A lookup service that is down makes the files wait, starting with 30 seconds and up to 30 minutes between tries; the log says when they are tried next. Settings are read again for each batch, so an API key you fix meanwhile is used.

```
$ tidytitles watch ~/Downloads --auto
Automatic: files with exactly one match and a free new name are renamed; the rest are listed for review.
Press Ctrl+C to stop.
3:05:12 PM  Watching /Users/me/Downloads, 12 media file(s) already there left alone
3:07:40 PM  New file: Inception.2010.1080p.mkv (waiting until it stops changing)
3:07:40 PM  New file: The.Matrix.mkv (waiting until it stops changing)
3:07:52 PM  Looking up 2 file(s)...
3:07:52 PM  Needs review: The.Matrix.mkv (several matches found; choose one)
3:07:52 PM  Renamed: Inception.2010.1080p.mkv → Inception (2010).mkv
3:07:52 PM  Saved 1 rename(s) to the history (undo with 'tidytitles undo').
```

Log lines go to stdout; the opening notes and the summary after Ctrl+C go to stderr.

**JSON** (`--json`): one object per line, `{ "event": ..., "time": ISO 8601, ... }`. Events: `started` (`folders`: `[{ folder, status, existing, polling }]`), `arriving` (`path`), `temporary` (`path`, `finalName`), `ready` (`paths`), `looking_up` (`count`), `renamed` (`path`, `destination`, `associatedFiles`, `transfer`), `review` (`path`, `reason`, `destination` when there is a planned name, `message` for some reasons), `unchanged`, `retry` (`paths`, `retryAt` in epoch milliseconds, `message`, `kind`), `changed`, `gone`, `unreadable`, `folder_missing`, `folder_restored` (`existing`), `folder_error` (`code`, `message`), `polling`, `history_saved` (`operations`), `cover_art` (`files`), `stopped`, and last `summary` (`renamed`, `review`, `unchanged`, `retrying`). `reason` is one of `review_mode`, `several_matches`, `no_match`, `lookup_failed`, `unverified`, `conflict`, `template_error`, `transfer_unavailable`, `rename_failed`, `not_renamable`.

Exit codes: 0 when stopped with Ctrl+C (a rename in progress finishes and its history is saved first; a second Ctrl+C does not cut that short); 1 for a missing API key or an unreadable `config.toml`; 2 for a folder that does not exist or no folder at all.

## config

Manage configuration settings. All `config` commands work on `config.toml` in the config directory (see [`--config-dir`](#--config-dir)). For settings these commands do not cover (conflict handling, associated files, cover art, the TVDB PIN), edit `config.toml`; see [Configuration](Configuration.md).

| Command | Description |
|---------|-------------|
| `config show [--json]` | Show current configuration (API keys are shown only as configured / not set). |
| `config set-key <provider> <key>` | Set an API key for a provider (`tmdb` or `tvdb`). |
| `config set-template <type> <template>` | Set a naming template (`movie`, `tv`, or `music`). |
| `config presets [--json]` | List the naming presets and which one is in effect. |
| `config preset <name>` | Set all three templates from a preset: `default`, `plex`, `jellyfin`, or `kodi`. |
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
  Preset: TidyTitles

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

Output:
  Movies: next to the original
  TV:     next to the original
  Music:  next to the original
  Transfer: move

History:
  Entries kept: 200
```

`Preset` names the [naming preset](Templates.md#naming-presets) whose three templates equal yours, or `Custom` (in JSON, `templatePreset` is the preset id or `null`). The values shown are the effective ones: defaults, then `FILE_RENAMER_*` environment variables, then `config.toml` on top. `--json` prints every setting, including cover art and providers:

```json
{
  "configFile": "/Users/me/Library/Application Support/file-renamer/config.toml",
  "cacheDir": "/Users/me/Library/Caches/file-renamer",
  "templates": { "movie": "{title} ({year})", "tv": "{title} - S{season2}E{episode2} - {episode_title}", "music": "{artist}/{album} ({year})/{track2} - {title}" },
  "templatePreset": "default",
  "apiKeys": { "tmdb": "configured", "tvdb": "not set" },
  "associatedFiles": { "enabled": true, "subtitles": true, "nfo": true, "images": true },
  "coverArt": { "enabled": false, "filename": "poster.jpg", "musicFilename": "cover.jpg", "overwrite": false, "size": "w500" },
  "behavior": { "dryRun": false, "overwrite": false, "previewBeforeRename": true, "conflictResolution": "skip" },
  "providers": { "movie": "tmdb", "tv": "tvdb", "music": "musicbrainz" },
  "output": { "movie": "", "tv": "", "music": "", "transferMode": "move" },
  "history": { "maxEntries": 200 }
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

### config presets

Lists the [naming presets](Templates.md#naming-presets) with their templates and marks the one in effect:

```
$ tidytitles config presets
Naming presets

default  TidyTitles (in effect)
  TidyTitles' own default: no movie or TV folders, music by artist and album.
  Movie: {title} ({year})
  TV:    {title} - S{season2}E{episode2} - {episode_title}
  Music: {artist}/{album} ({year})/{track2} - {title}

plex  Plex
  ...

In effect: TidyTitles
Apply one with: tidytitles config preset <name>
```

`--json` prints `{ "current": "default", "presets": [{ "id", "name", "description", "templates", "sources" }, ...] }`; `current` is `null` when the templates match no preset.

### config preset

Sets the movie, TV, and music templates from a preset. Nothing else is stored: the preset is only a quick way to fill in the templates, and you can change any of them afterward with `set-template` (`config show` then reports `Preset: Custom`).

```
$ tidytitles config preset plex
Applied the Plex preset.
  Movie: {title} ({year})< {tmdb-{tmdb_id}}>< {edition-{edition}}>/{title} ({year})< {edition-{edition}}>
  TV:    {title} ({year})< {tvdb-{tvdb_id}}>< {tmdb-{tmdb_id}}>/Season {season2}/{title} ({year}) - s{season2}e{episode2}< - {episode_title}>
  Music: {album_artist}/{album}/{disc_multi}{track2} - {title}
```

The name is case-insensitive. An unknown name prints the available presets and exits 1 without changing anything.

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

In detail, `rename` exits 1 when a required API key is missing, `config.toml` cannot be read, any file's lookup failed, or any rename failed; files that were skipped for other reasons (no match, name taken) do not cause a non-zero exit. It also exits 1 when the confirmation reads end of input from a non-terminal stdin (`Aborted!`). Answering no to the confirmation exits 0. `undo` exits 1 when any file could not be moved back. `config set-template` exits 1 for an invalid template, and `config preset` for an unknown preset.

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
| Several matches for a file | Pick from a list, search with different words, or skip | File skipped and reported, unless `--auto-select` |
| No match for a file | Offered a search with different words (after the lookup) | Nothing asked; the file is skipped |
| `Proceed with rename?` / `Proceed with undo?` | Yes/no prompt (default no) | Reads one line from stdin: `y`/`yes` or `n`/`no`, blank means no. End of input aborts with exit 1. |
| `Config file exists. Overwrite?` | Yes/no prompt (default no) | Same as above |

So `echo y | tidytitles rename ~/Downloads` works, but `--yes` is clearer in scripts.

### Searching with different words

On a terminal, without `--auto-select`, the match prompt has a **Search with different words...** choice. It asks for new words, one field at a time, each prefilled with what TidyTitles searched for (press Enter to keep it):

- movies: `Movie title:`, `Year (optional):`
- TV: `Show title:`, `Year (optional):`, `Season:`, `Episode:` (correct the numbers here if the file name had them wrong)
- music: `Track title:`, `Artist (optional):`, `Album (optional):`

The results are listed with **Search again with different words...**, **Search as a TV episode...** (or **as a movie...**, for video files), and **Skip this file**. A result you pick is used for the file and marked `manual_selection`. When it is a TV show and other files in the batch have the same show title in their names, you are asked `Use <show> for the N other file(s) named "<title>" too?` (default yes); each file then gets its own season and episode, and files whose episode the show does not have keep their match.

After the lookup, each file with no match is offered the same search: **Search with different words...**, **Skip this file**, or **Skip all files without a match**. Files you skipped in the match prompt are not asked again.

The preview shown afterward includes these changes. Nothing is asked when stdin is not a terminal or with `--auto-select`.

## Ctrl+C

- **While scanning, looking up, or at a prompt:** the first Ctrl+C cancels cleanly; the CLI prints `Canceled.` and exits 130. Nothing has been renamed at that point. A second Ctrl+C exits at once.
- **While renaming:** renaming is never cut short, so no file is left half-done and the history needed for `undo` is always written. After a Ctrl+C the CLI finishes renaming, saves the history, prints the results, skips cover art, and exits 130. A second Ctrl+C prints `Still renaming. Stopping once the history for undo is saved.` and does not exit early.
