# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TidyTitles is a cross-platform media file renaming application. It fetches metadata from TMDB (movies), TVDB (TV shows), and MusicBrainz (music) to rename files with consistent naming patterns.

The app is being rewritten from Python to TypeScript on the `electron-rewrite` branch. Both versions live in this repository until the Python one is retired:

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
- `providers/` - `tmdb.ts`, `tvdb.ts`, `musicbrainz.ts` (fetch-based, implement the interfaces in `base.ts`), `cache.ts`
- `renamer.ts`, `associatedFiles.ts`, `conflictResolution.ts`, `coverArt.ts` - File operations
- `config.ts` - `ConfigService`: zod-validated settings in TOML, plus rename history
- `renameService.ts` - Workflow orchestrator: parse, fetch, plan, execute, undo
- `session.ts` - Wiring shared by both front ends: providers from settings, `RenameSession`, history, undo
- `scan.ts` - Media file discovery

**`packages/cli` (`@tidytitles/cli`)**: commander-based CLI. `src/program.ts` builds the program with injectable dependencies; `src/commands/` holds `rename`, `preview`, `undo`, `config`. Builds two outputs: `dist/index.js` (npm bin) and `dist/tidytitles.mjs` (self-contained bundle shipped inside the desktop app).

**`apps/desktop` (`@tidytitles/desktop`)**: Electron app built with electron-vite.
- `src/main/` - `controller.ts` owns the session, planned operations, and cancellation (no Electron imports, unit-testable); `app.ts` owns the window, menu, IPC, and security setup
- `src/preload/` - Typed API exposed as `window.tidytitles` through `contextBridge`
- `src/renderer/` - React 19 with a single reducer and plain CSS (`styles.css`)
- `src/shared/ipc.ts` - IPC channel names and payload types
- `src/e2e/` - Test-only main entry with fake providers; never part of the shipped build

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
- `config.toml` holds settings (snake_case keys on disk, camelCase in memory) and API keys (TMDB/TVDB required for movies/TV; MusicBrainz is free). `history.json` holds the last 10 renames for undo.
- Environment overrides use the `FILE_RENAMER_` prefix with `__` as the nested delimiter; a value in `config.toml` wins over the environment.

## Template Placeholders

Movie: `{title}`, `{year}`, `{quality}`
TV: `{title}`, `{season2}`, `{episode2}`, `{episode_title}`
Music: `{artist}`, `{album}`, `{track2}`, `{disc2}`, `{title}`, `{year}`

Formatters: `{field|lower}`, `{field|upper}`, `{field|title}`, `{field|pad:3}`

## Build System

- `electron-builder` config in `apps/desktop/electron-builder.yml`; app icon sources in `apps/desktop/build/` (`npm run icons` regenerates them from `icon.svg`).
- The desktop package bundles the CLI at `Resources/cli/tidytitles.mjs`; the "Install Command Line Tool…" menu item writes a launcher for it.
- Electron is pinned to an exact version because electron-builder rejects a range.

## Python Reference App

```bash
pip install -e ".[dev,gui]"    # Install
pytest                         # Tests
python build.py --installer    # PyInstaller build
```

Layout: `core/` (parser, templates, models, renamer), `providers/` (async httpx clients), `services/` (rename and config services), `cli/main.py` (Click), `gui/app.py` (PySide6).
