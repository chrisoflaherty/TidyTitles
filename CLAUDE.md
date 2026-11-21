# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TidyTitles is a cross-platform media file renaming application. It fetches metadata from TMDB (movies), TVDB (TV shows), and MusicBrainz (music) to rename files with consistent naming patterns.

The app has been rewritten from Python to TypeScript. Both versions live in this repository until the Python one is retired:

- **TypeScript (current work):** an npm-workspace monorepo with a shared core, a Node CLI (`tidytitles`), and an Electron desktop app.
- **Python (reference):** `src/file_renamer/`, `tests/`, `build.py`, `installer/`. It is the behavioral reference for the port. Do not change it; fix behavior in the TypeScript code.

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
- `template.ts` - Placeholder-based filename generation (`{title} ({year})`)
- `providers/` - `tmdb.ts`, `tvdb.ts`, `musicbrainz.ts` (fetch-based, implement the interfaces in `base.ts`), `cache.ts`. Identical requests in flight share one call; TMDB/TVDB retry a 429 a bounded number of times, MusicBrainz never retries
- `renamer.ts`, `associatedFiles.ts`, `conflictResolution.ts`, `coverArt.ts` - File operations
- `transfer.ts` - Move, copy, hard link (safe temp-then-link copy, cross-volume moves), file fingerprints, and undo of one file
- `output.ts` - Output folders per media kind, `OutputFolderError` checks before anything moves, `applyTransferChecks` (hard links across volumes)
- `config.ts` - `ConfigService`: zod-validated settings in TOML, plus rename history
- `renameService.ts` - Workflow orchestrator: parse, fetch, plan, execute, undo. Lookups run concurrently (`concurrency.ts`); questions to the selection callback and progress stay one at a time, in file order
- `session.ts` - Wiring shared by both front ends: providers from settings, `RenameSession`, history, undo
- `scan.ts` - Media file discovery

**`packages/cli` (`@tidytitles/cli`)**: commander-based CLI. `src/program.ts` builds the program with injectable dependencies; `src/commands/` holds `rename`, `preview`, `undo`, `config`. Builds two outputs: `dist/index.js` (npm bin) and `dist/tidytitles.mjs` (self-contained bundle shipped inside the desktop app).

**`apps/desktop` (`@tidytitles/desktop`)**: Electron app built with electron-vite.
- `src/main/` - `controller.ts` owns the session, planned operations, and cancellation (no Electron imports, unit-testable); `updater.ts` is the update state machine (no Electron imports; tested with a fake engine) and `updaterEngine.ts` wraps electron-updater; `preferences.ts` stores desktop-only settings (auto-update toggle) in `userData`; `taskFeedback.ts` decides the Dock/taskbar progress, the finish notification, and the attention request (no Electron imports); `openPaths.ts` parses and validates paths opened from the Dock, Finder, the command line, or a second instance; `app.ts` owns the window, menu, IPC, and security setup
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

- Stored in the same location and format as the Python app, so the two are interchangeable:
  - macOS: `~/Library/Application Support/file-renamer/`
  - Linux: `~/.config/file-renamer/` (or `$XDG_CONFIG_HOME/file-renamer/`)
  - Windows: `%LOCALAPPDATA%\file-renamer\file-renamer\`
- `config.toml` holds settings (snake_case keys on disk, camelCase in memory) and API keys (TMDB/TVDB required for movies/TV; MusicBrainz is free). `history.json` holds the last `[history] max_entries` renames for undo (default 200), each file with a fingerprint.
- Environment overrides use the `FILE_RENAMER_` prefix with `__` as the nested delimiter; a value in `config.toml` wins over the environment.

## Output Folders, Transfer Modes, and Undo

- `[output]` has a folder per kind (`movie`, `tv`, `music`; empty renames in place) and `transfer_mode` (`move`, `copy`, `hardlink`). `RenameSession` resolves folders per file by the matched kind; `outputDir` (CLI `--output`) overrides all three and is created when missing; configured folders never are. Folders are checked at `plan` and again at `execute`, so a missing or unwritable one throws `OutputFolderError` (typed `reason`) before any file moves.
- Copies are written to a hidden `.…tidytitles-tmp` name and hard-linked into place (no clobber); cross-volume moves use the same copy. A hard link across volumes or on a volume without links is skipped with `skipReason` `cross_device_link` / `link_unsupported`, never copied.
- `FileRenamer.execute` records `transfer: { mode, fingerprint }` on each operation and associated file; history stores `transfer` (copies and links only) and `fingerprint` (dev, ino, size, mtime_ns). Undo moves a file back only if dev+ino match, deletes a copy only if unchanged and the original exists, a link only if the original is still the same inode; otherwise the file is `kept` with a typed `UndoKeptReason`. `undoHistoryEntry` undoes any entry; legacy entries without fingerprints skip files a later entry touched.

## Template Placeholders

Movie: `{title}`, `{year}`, `{quality}`
TV: `{title}`, `{season2}`, `{episode2}`, `{episode_title}`
Music: `{artist}`, `{album}`, `{track2}`, `{disc2}`, `{title}`, `{year}`

Formatters: `{field|lower}`, `{field|upper}`, `{field|title}`, `{field|pad:3}`

## Opening Files and Notifications (desktop)

- Paths from macOS `open-file` (Dock drops, Finder's Open With), the command line (Windows/Linux, files dropped on the shortcut or exe), and a second instance go through `openPaths.ts` (switches ignored, only existing absolute paths kept), wait in an `OpenedPathsQueue`, and are taken by the renderer with `takeOpenedPaths(canDrop())`: the same rules and code path as a drop. Refused with a message while a task runs or a dialog is open; they only wait while other items are being added.
- On macOS the single-instance lock is requested at `ready`, so a second instance (`open -n`) can pass its `open-file` paths in `additionalData`.
- Document types are declared in `mac.extendInfo` (never `fileAssociations`: the NSIS installer would make every listed extension default to TidyTitles). Folders are rank `Alternate`; video and audio files rank `None`, because Launch Services makes an `Alternate` app the default for a type nobody else claims (`.mkv` on a stock Mac). `tests/main/documentTypes.test.ts` keeps the extensions equal to core's.
- Icon progress follows `AppState.busy` (fetching, renaming, undoing), so it clears however a task ends. Notifications only when the window is not focused. Windows sets the AppUserModelID to the app id.

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

## Python Reference App

```bash
pip install -e ".[dev,gui]"    # Install
pytest                         # Tests
python build.py --installer    # PyInstaller build
```

Layout: `core/` (parser, templates, models, renamer), `providers/` (async httpx clients), `services/` (rename and config services), `cli/main.py` (Click), `gui/app.py` (PySide6).
