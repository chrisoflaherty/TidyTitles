# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TidyTitles is a cross-platform media file renaming application. It fetches metadata from TMDB (movies), TVDB (TV shows), and MusicBrainz (music) to rename files with consistent naming patterns.

It is a TypeScript npm-workspace monorepo with a shared core, a Node CLI (`tidytitles`), and an Electron desktop app.

The app was first written in Python and rewritten in TypeScript; the Python code was removed after 0.2.0-beta.7 (it is in the git history). Comments that say "as in the Python client" explain where a behavior or file format came from. Config, history, and cache files written by the Python app must keep loading.

## Development Commands (TypeScript)

Requires Node 22.12 or newer. Run from the repository root unless noted.

```bash
npm install                    # Install all workspaces

npm run build                  # Build core, then CLI, then desktop (order matters)
npm test                       # Unit tests in every workspace (vitest)
npm run typecheck              # tsc --noEmit in every workspace

# One workspace
npm test -w @tidytitles/core
npx vitest run tests/parser.test.ts        # Single file (run inside the workspace directory)
npx vitest run -t "test name"              # Single test by name

# CLI
npx tidytitles --help          # Needs `npm run build` first

# Desktop (run inside apps/desktop)
npm run dev                    # Electron with hot reload
npm run test:e2e               # Builds a test app and drives it with Playwright
npm run package                # Unpacked app in release/ (unsigned)
npm run dist                   # Installers: DMG (macOS), NSIS (Windows), AppImage (Linux)

# Parser parity against Python guessit (needs python3 with guessit; run inside packages/core)
npx tsx scripts/parser-parity.ts
npx tsx scripts/parser-parity.ts --corpus scripts/parser-corpus-release.txt   # edition, audio, and HDR names

# Lookup benchmark against simulated APIs (no network; run inside packages/core)
npx --no-install tsx scripts/bench-lookups.ts
```

`@tidytitles/core` is consumed from its built `dist/`, so rebuild core after changing it before running the CLI or desktop app.

## Architecture

### Data Flow
```
CLI / Electron main → RenameSession → RenameService → Parser → Providers (async) → TemplateEngine → FileRenamer
```

### Workspaces

**`packages/core` (`@tidytitles/core`)**: all business logic. Uses `node:fs`, so it runs in Node and in the Electron main process, never in the renderer.
- `models.ts` - Plain JSON-serializable models (`Movie`, `Episode`, `Track`, `RenameOperation`, ...) with factory and helper functions. Metadata objects carry a `kind` discriminant.
- `parser.ts` - Hand-written filename parser that reproduces guessit's output, plus a regex fallback
- `musicParser.ts` - Tag reading with `music-metadata`, with filename fallback
- `template.ts` - Placeholder-based filename generation (`{title} ({year})`); optional sections in `templateSections.ts`, the placeholder reference in `templateFields.ts`, naming presets (Plex, Jellyfin, Kodi) in `presets.ts`
- `templateEpisodes.ts` - Multi-episode rendering of `{episode}`/`{episode2}`/`{episode_title}`, plus `{absolute}` and `{air_date}`
- `episodeLookup.ts` - What a TV file names (season and episodes, an air date, or absolute numbers) and how it is looked up
- `episodeOrder.ts`, `languages.ts` - The `[tv] episode_order` and `[metadata] language` values, what each provider can deliver, TVDB language codes
- `providers/` - `tmdb.ts`, `tvdb.ts`, `musicbrainz.ts` (fetch-based, implement the interfaces in `base.ts`), `cache.ts`, `memo.ts` (season listings, episode groups, and translations once per client, that is per run). Identical requests in flight share one call; TMDB/TVDB retry a 429 a bounded number of times, MusicBrainz never retries
- `renamer.ts`, `associatedFiles.ts`, `conflictResolution.ts`, `coverArt.ts` - File operations
- `transfer.ts` - Move, copy, hard link (safe temp-then-link copy, cross-volume moves), file fingerprints, and undo of one file
- `output.ts` - Output folders per media kind, `OutputFolderError` checks before anything moves, `applyTransferChecks` (hard links across volumes)
- `config.ts` - `ConfigService`: zod-validated settings in TOML, plus rename history
- `renameService.ts` - Workflow orchestrator: parse, fetch, plan, execute, undo. Lookups run concurrently (`concurrency.ts`); questions to the selection callback and progress stay one at a time, in file order
- `session.ts` - Wiring shared by both front ends: providers from settings, `RenameSession`, history, undo
- `scan.ts` - Media file discovery
- `tags/` - Hand-written tag writers (no dependency): `id3.ts` (MP3), `flac.ts`, `mp4.ts` (M4A), `ogg.ts` (Vorbis, Opus), `vorbisComment.ts`; each parses only the tag region, replaces only the changed fields, and refuses layouts it does not handle (`TagLayoutError`). `rewrite.ts` writes a temporary clone, reads it back, and renames it over the original
- `musicTags.ts`, `nfo.ts`, `metadataWrite.ts` - `[write_metadata]`: tags from a MusicBrainz match into music files, NFO files for movies, episodes, and `tvshow.nfo`; run by `RenameSession.execute`, results on `RenameOperation.metadataWrites`, undo records on `metadataUndo` (history `tags`, `created_files`)
- `watcher.ts`, `watchNames.ts`, `watchBatch.ts`, `watchService.ts`, `watchConfig.ts`, `watchEvents.ts` - Watch folders: `FolderWatcher` (rescans are the truth, `fs.watch` only a hint; settle period, temporary names; injected `WatchFileSystem` and `WatchClock`), `processWatchBatch` (plan, then in automatic mode `execute` only unambiguous files), `WatchQueue` (batches, retry backoff), `WatchService` (the CLI's pipeline), the `[watch]` table
- `matchCorrection.ts` - `PlanCorrector` (from `RenameSession.corrector`): search with the user's words, choose or clear a match, apply a TV show to files with the same parsed title, set a typed name (`customName.ts` checks it). Every change re-plans the whole list with `generatePreview`; corrected files are planned after untouched ones

**`packages/cli` (`@tidytitles/cli`)**: commander-based CLI. `src/program.ts` builds the program with injectable dependencies; `src/commands/` holds `rename`, `preview`, `undo`, `config`, `watch`. Builds two outputs: `dist/index.js` (npm bin) and `dist/tidytitles.mjs` (self-contained bundle shipped inside the desktop app).

**`apps/desktop` (`@tidytitles/desktop`)**: Electron app built with electron-vite.
- `src/main/` - `controller.ts` owns the session, planned operations, and cancellation (no Electron imports, unit-testable); `updater.ts` is the update state machine (no Electron imports; tested with a fake engine) and `updaterEngine.ts` wraps electron-updater; `preferences.ts` stores desktop-only settings (auto-update toggle) in `userData`; `taskFeedback.ts` decides the Dock/taskbar progress, the finish notification, and the attention request (no Electron imports); `openPaths.ts` parses and validates paths opened from the Dock, Finder, the command line, or a second instance; `watchManager.ts` runs the watch folders while the app is open (no Electron imports); `app.ts` owns the window, menu, IPC, and security setup
- `src/preload/` - Typed API exposed as `window.tidytitles` through `contextBridge`
- `src/renderer/` - React 19 with a single reducer and plain CSS (`styles.css`)
- `src/shared/ipc.ts` - IPC channel names and payload types
- `src/e2e/` - Test-only main entry with fake providers, a scripted update engine (`TIDYTITLES_E2E_FAKE_UPDATES`), and recorders in place of notifications, Dock bounce, and focus (`globalThis.__tidytitlesE2eFeedback`); never part of the shipped build

### Conventions

- TypeScript strict, ESM, extensionless relative imports, `import type` for type-only imports.
- Models are plain objects: camelCase fields, paths as absolute strings, dates as ISO `YYYY-MM-DD` strings, absent values `undefined`.
- Providers take an injectable `fetch`; tests never touch the network.
- Front ends branch on typed fields (`skipReason`, `lookupError.kind`, `MissingApiKeyError.reason`), never on message strings.
- The renderer is sandboxed (`contextIsolation`, no `nodeIntegration`). Main holds the authoritative state and validates every IPC argument; the renderer refers to files by id.
- All user-visible formatting passes `"en-US"` explicitly.

## Testing

- vitest in every workspace; no explicit async setup needed.
- HTTP is mocked by injecting `fetch` (`packages/core/tests/providers/mock-fetch.ts`); fake providers live in `packages/core/tests/fakes.ts`.
- Filesystem tests use temp directories. Tests and manual runs must never use the real config directory: pass `--config-dir` to the CLI or set `TIDYTITLES_CONFIG_DIR` (both front ends honor it).

## Configuration

- Stored where the original Python app kept them (hence the `file-renamer` folder name), so existing installs carry over:
  - macOS: `~/Library/Application Support/file-renamer/`
  - Linux: `~/.config/file-renamer/` (or `$XDG_CONFIG_HOME/file-renamer/`)
  - Windows: `%LOCALAPPDATA%\file-renamer\file-renamer\`
- `config.toml` holds settings (snake_case keys on disk, camelCase in memory) and API keys (TMDB/TVDB required for movies/TV; MusicBrainz is free). `history.json` holds the last `[history] max_entries` renames for undo (default 200), each file with a fingerprint.
- `[tv] episode_order` (`aired`, `dvd`, `absolute`) and `[metadata] language` (TMDB code such as `en-US`) are tables written after the original layout; both have defaults. TMDB delivers DVD order only through a DVD episode group: a show without one fails with lookup error kind `order_unavailable` (`EpisodeOrderUnavailableError`).
- Environment overrides use the `FILE_RENAMER_` prefix with `__` as the nested delimiter; a value in `config.toml` wins over the environment.

## Output Folders, Transfer Modes, and Undo

- `[output]` has a folder per kind (`movie`, `tv`, `music`; empty renames in place) and `transfer_mode` (`move`, `copy`, `hardlink`). `RenameSession` resolves folders per file by the matched kind; `outputDir` (CLI `--output`) overrides all three and is created when missing; configured folders never are. Folders are checked at `plan` and again at `execute`, so a missing or unwritable one throws `OutputFolderError` (typed `reason`) before any file moves.
- Copies are written to a hidden `.…tidytitles-tmp` name and hard-linked into place (no clobber); cross-volume moves use the same copy. A hard link across volumes or on a volume without links is skipped with `skipReason` `cross_device_link` / `link_unsupported`, never copied.
- `FileRenamer.execute` records `transfer: { mode, fingerprint }` on each operation and associated file; history stores `transfer` (copies and links only) and `fingerprint` (dev, ino, size, mtime_ns). Undo moves a file back only if dev+ino match, deletes a copy only if unchanged and the original exists, a link only if the original is still the same inode; otherwise the file is `kept` with a typed `UndoKeptReason`. `undoHistoryEntry` undoes any entry; legacy entries without fingerprints skip files a later entry touched.

## Writing Tags and NFO Files

- `[write_metadata] music_tags` / `nfo`, both off by default (CLI `--write-tags`, `--write-nfo`; desktop Settings → Files). `RenameSession.execute` writes them after the rename (`writeMetadataFor`; with `preview: true` for the CLI's dry run).
- Tags: only provider matches (`Track.id !== "local"`), only fields that differ, never blanked. Never through a hard link (`hard_link`) or into a moved file with other links (`shared_data`); copies get them. After a write, the operation's transfer fingerprint is the rewritten file's. Undo restores the saved raw entries (byte-exact where the format allows) before moving the file back; a file changed since keeps its tags.
- NFO: never replaces an existing file unless the conflict strategy is overwrite, never an associated NFO, never `tvshow.nfo`. Undo removes unchanged created files; `tvshow.nfo` only when no video is left in its folder.
- Tests that prove the audio is untouched use the tiny fixtures in `packages/core/tests/fixtures/audio` (made with ffmpeg); ffmpeg-decoded comparisons run only where ffmpeg is installed.

## Template Placeholders

Movie: `{title}`, `{year}`, `{quality}`
TV: `{title}`, `{season2}`, `{episode2}`, `{episode_title}`, `{absolute}`, `{air_date}`. For a multi-episode file `{episode}`/`{episode2}` render every episode (`S{season2}E{episode2}` gives `S01E01-E02`) and `{episode_title}` joins titles with " & ", so the default template needs no change.
Music: `{artist}`, `{album}`, `{track2}`, `{disc2}`, `{title}`, `{year}`

Formatters: `{field|lower}`, `{field|upper}`, `{field|title}`, `{field|pad:3}`

Full list with examples: `templateFields.ts` (kept equal to `TemplateEngine.VALID_FIELDS` by a test) and `wiki/Templates.md`. Release details (`{edition}`, `{audio_codec}`, `{audio_channels}`, `{hdr}`) are named by `releaseDetails.ts` from the tokens `parser.ts` classifies as tags, with guessit's spellings.

- Optional sections `<...>` (`templateSections.ts`): dropped when none of their placeholders has a value; templates without a matched `<` `>` take the old code path and render byte-for-byte as before.
- Naming presets (`presets.ts`) only fill the three templates; nothing about a preset is stored. `matchPreset` finds the one in effect, otherwise "Custom".

## Opening Files and Notifications (desktop)

- Paths from macOS `open-file` (Dock drops, Finder's Open With), the command line (Windows/Linux, files dropped on the shortcut or exe), and a second instance go through `openPaths.ts` (switches ignored, only existing absolute paths kept), wait in an `OpenedPathsQueue`, and are taken by the renderer with `takeOpenedPaths(canDrop())`: the same rules and code path as a drop. Refused with a message while a task runs or a dialog is open; they only wait while other items are being added.
- On macOS the single-instance lock is requested at `ready`, so a second instance (`open -n`) can pass its `open-file` paths in `additionalData`.
- Document types are declared in `mac.extendInfo` (never `fileAssociations`: the NSIS installer would make every listed extension default to TidyTitles). Folders are rank `Alternate`; video and audio files rank `None`, because Launch Services makes an `Alternate` app the default for a type nobody else claims (`.mkv` on a stock Mac). `tests/main/documentTypes.test.ts` keeps the extensions equal to core's.
- Icon progress follows `AppState.busy` (fetching, renaming, undoing), so it clears however a task ends. Notifications only when the window is not focused. Windows sets the AppUserModelID to the app id.

## Correcting Matches and Names

- Only while the plan is "planned". Corrections live on `PlannedMediaFile.correction` and are never set by a lookup, so the next fetch drops them.
- Desktop: the renderer sends a file id and a query; main keeps the latest search and the renderer picks by search id and index (never sends metadata). Main is busy (`"correcting"`) while a change re-plans.
- CLI: "Search with different words..." in the selection callback (terminal only, not with `--auto-select`); a pick outside the original options and the no-match searches are applied after the lookup through `PlanCorrector`. The callback's third argument gives the file's path.
- A typed name that already exists on disk is refused whatever the conflict strategy.

## Watch Folders

- `[watch]` (`enabled`, `folders`, `recursive`, `mode` review/automatic, `settle_seconds`). The desktop app watches while it is open (no background service); `tidytitles watch` runs in the foreground, never prompts, renames only with `--auto`, ignores `enabled` and `mode`.
- A file is handed on once size and mtime are unchanged for the settle period, it has no temporary download name or companion (`watchNames.ts`), and Finder is not copying it. Files present at start (or when a missing folder returns) are "existing" and left alone unless `processExisting`.
- Automatic renames need exactly one candidate (`auto_matched`, `verified`, `from_provider`; the selection callback always skips), a pending plan, and no file at any new name; the session is planned with conflict strategy "skip" (`watchSessionSettings`). Everything goes through `RenameSession.plan`/`execute`/`saveHistory`.
- No loops: handled files are remembered by identity (`dev:ino:size:mtimeNs`, also from history fingerprints); output folders inside a watched folder are not scanned.
- Desktop: arrivals wait in `WatchQueue` until the renderer takes them with `takeWatchArrivals(canDrop())`. Review adds them to the list and fetches; automatic runs `AppController.runWatchBatch` (busy "watching") and adds the rest for review. Tests use `MemoryFs`/`FakeClock` (`packages/core/tests/watchFakes.ts`) or real files with a no-events file system; never real events.

## Automatic Updates (desktop)

- electron-updater with the GitHub provider, bundled into the main bundle (it is a devDependency; the package ships no `node_modules`).
- `electron-builder.yml` publishes with `channel: ${channel}`: a beta build writes `beta-mac.yml` / `beta.yml` / `beta-linux.yml`, a stable build `latest*.yml`. Beta apps are offered betas and stable releases; stable apps only stable. No downgrades.
- macOS needs the `zip` target (Squirrel.Mac installs from it). Only a Developer ID signed app installs updates itself; ad-hoc builds, non-AppImage Linux runs, and copies without `resources/app-update.yml` only check and offer the release page.
- Updates are off in development, in the e2e build, and with `TIDYTITLES_DISABLE_UPDATES=1`. Tests never contact the network.
- `--mode update-test` builds a local-feed test app (see BUILD.md "Testing updates locally"); `scripts/check-build.mjs` rejects such an `out/`. Run `npm run build` afterward.
- `scripts/check-update-feed.mjs --platform mac|win|linux` checks packaging output (the release workflow runs it and uploads exactly the files it lists).

## Build System

- `electron-builder` config in `apps/desktop/electron-builder.yml`; app icon sources in `apps/desktop/build/` (`npm run icons` regenerates them from `icon.svg`).
- The desktop package bundles the CLI at `Resources/cli/tidytitles.mjs`; the "Install Command Line Tool…" menu item writes a launcher for it.
- Electron is pinned to an exact version because electron-builder rejects a range.
- The release workflow creates a draft release, uploads each platform's checked feed, and publishes after all package and test jobs pass. macOS is signed and notarized when the `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` secrets exist, otherwise ad-hoc signed. Windows (NSIS, per-user by default) and Linux are unsigned.
