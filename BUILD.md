# Building TidyTitles

This guide is for working on TidyTitles itself: the repository layout, building, running from source, testing, making installers, and publishing a release. To install a released version, see [Installation](wiki/Installation.md).

- [Requirements](#requirements)
- [Repository layout](#repository-layout)
- [Build](#build)
- [Run from source](#run-from-source)
- [Test](#test)
- [Package the desktop app](#package-the-desktop-app)
- [Release](#release)
- [Code signing](#code-signing)
- [Troubleshooting builds](#troubleshooting-builds)

## Requirements

- **Node.js 22.12 or newer** (the `engines` field in `package.json`). Check with `node --version`.
- **npm**, which comes with Node.js. The repository uses npm workspaces and a committed `package-lock.json`.
- **git**.
- To make installers: a computer running the target system. The release workflow builds each installer on its own system (macOS for the DMGs, Windows for the NSIS installer, Linux for the AppImage).
- Optional, for the parser parity check only: Python 3 with [guessit](https://pypi.org/project/guessit/) installed.

## Repository layout

```
TidyTitles/
├── package.json              npm workspaces root: build, test, typecheck scripts
├── packages/
│   ├── core/                 @tidytitles/core: all the logic
│   │   ├── src/
│   │   │   ├── parser.ts         filename parser (reproduces guessit)
│   │   │   ├── musicParser.ts    music tags (music-metadata) with filename fallback
│   │   │   ├── template.ts       templates and name cleaning
│   │   │   ├── providers/        TMDB, TVDB, MusicBrainz clients and the response cache
│   │   │   ├── renameService.ts  parse → fetch → plan → rename → undo
│   │   │   ├── session.ts        wiring shared by both front ends, history, undo
│   │   │   ├── renamer.ts, associatedFiles.ts, conflictResolution.ts, coverArt.ts, scan.ts
│   │   │   └── config.ts         config.toml and history.json
│   │   ├── tests/
│   │   └── scripts/parser-parity.ts
│   └── cli/                  @tidytitles/cli: the tidytitles command (commander)
│       ├── src/program.ts        the program, with injectable dependencies
│       ├── src/commands/         rename, preview, undo, config
│       └── tests/
├── apps/
│   └── desktop/              @tidytitles/desktop: the Electron app (electron-vite, React 19)
│       ├── src/main/             main process: controller.ts (state, workflow), app.ts (window, menu, IPC)
│       ├── src/preload/          the window.tidytitles API (contextBridge)
│       ├── src/renderer/         React UI, plain CSS
│       ├── src/shared/ipc.ts     IPC channel names and payload types
│       ├── src/e2e/              test-only main entry with fake providers (never shipped)
│       ├── tests/                unit tests (main in Node, renderer in jsdom)
│       ├── e2e/                  end-to-end tests (Playwright driving Electron)
│       ├── build/                app icons (icon.svg is the source)
│       └── electron-builder.yml  packaging configuration
├── .github/workflows/release.yml   builds installers for a version tag
└── src/file_renamer/, tests/, build.py, installer/, pyproject.toml
                              the legacy Python app (reference only)
```

How the parts fit together: the CLI and the Electron main process both call `@tidytitles/core`. Core uses `node:fs`, so it runs only in Node and the Electron main process, never in the renderer. The renderer is sandboxed and talks to the main process through the typed API in `src/preload`; the main process holds the state and validates every IPC argument.

## Build

```bash
npm install
npm run build
```

`npm run build` builds the workspaces **in order**: `packages/core`, then `packages/cli`, then `apps/desktop`. The order matters: the CLI and the desktop app use core from its built `packages/core/dist/`, not from its sources. **After changing anything in `packages/core`, rebuild core** (`npm run build -w @tidytitles/core`, or the full `npm run build`) before running or testing the CLI or the desktop app.

What each build produces:

| Workspace | Command | Output |
|-----------|---------|--------|
| core | `npm run build -w @tidytitles/core` | `packages/core/dist/` (ESM and type declarations) |
| cli | `npm run build -w @tidytitles/cli` | `packages/cli/dist/index.js` (the npm `bin`, for both `tidytitles` and `file-renamer`) and `packages/cli/dist/tidytitles.mjs` (one self-contained file with every dependency inlined; the desktop app ships it) |
| desktop | `npm run build -w @tidytitles/desktop` | `apps/desktop/out/` (main, preload, renderer). The build fails if test-only code reaches `out/` or the renderer's Content-Security-Policy is missing (`scripts/check-build.mjs`). |

Type-check everything:

```bash
npm run typecheck
```

## Run from source

### Command line

```bash
npx tidytitles --help
npx tidytitles --config-dir /tmp/tt-dev rename ~/Downloads --dry-run
```

`npx` runs the workspace's own copy; add `--no-install` to make sure it never downloads anything. `npx file-renamer` runs the same program under its old name.

### Desktop app

```bash
cd apps/desktop
npm run dev
```

This starts Electron with hot reload for the renderer. In development builds the **View** menu also has **Reload** (Cmd/Ctrl+Shift+R) and **Toggle Developer Tools**.

### Never use your real settings while developing

Tests and manual runs must not touch the real config folder (it holds your API keys and rename history). Point both front ends at a temporary folder:

```bash
export TIDYTITLES_CONFIG_DIR="$(mktemp -d)"
npx tidytitles config show          # shows the temporary config.toml path
(cd apps/desktop && npm run dev)    # the app uses it too
```

or pass `--config-dir <dir>` to the CLI. The automated tests already do this.

## Test

All tests use [vitest](https://vitest.dev/). They never touch the network (HTTP is mocked by injecting `fetch`; see `packages/core/tests/providers/mock-fetch.ts` and the fake providers in `packages/core/tests/fakes.ts`), and filesystem tests use temporary folders.

```bash
npm test                                   # unit tests in every workspace
npm test -w @tidytitles/core               # one workspace

# Inside a workspace folder:
cd packages/core
npx vitest run tests/parser.test.ts        # one file
npx vitest run -t "test name"              # tests matching a name
```

### Desktop end-to-end tests

```bash
cd apps/desktop
npm run test:e2e
```

This builds a test version of the app (`npm run build:e2e`, output in `out-e2e/`) whose main process uses fake metadata providers, then launches it with Playwright and drives the real window: security settings, adding a folder, fetching and choosing a match, canceling a fetch, renaming on disk, undo from history, editing a template in Settings, and restoring the window size. It uses a temporary config folder and media folder. `out-e2e/` is never packaged.

The same command also runs a smoke test of the **packaged** app (`e2e/packaged.e2e.test.ts`) if one exists: it starts the app, checks that its window loads and that core works inside the asar (TOML parsing, templates, reading MP3 tags). It looks for `release/mac-<arch>/TidyTitles.app` (made by `npm run package` on macOS), or the executable named in `TIDYTITLES_PACKAGED_APP`, and is skipped when there is none.

### Parser parity with Python guessit

The filename parser (`packages/core/src/parser.ts`) is a hand-written reproduction of [guessit](https://github.com/guessit-io/guessit), which the Python app used. The parity script runs both over a corpus of filenames and reports every disagreement:

```bash
cd packages/core
npx tsx scripts/parser-parity.ts
npx tsx scripts/parser-parity.ts --corpus my-names.txt --fields title,year
```

It needs `python3` with guessit installed, and the Python sources in `src/` (set `TIDYTITLES_PY_SRC` to use another location). The corpus is `scripts/parser-corpus.txt`.

## Package the desktop app

Packaging uses [electron-builder](https://www.electron.build/) with `apps/desktop/electron-builder.yml`. Run these in `apps/desktop`, after building the CLI (the package includes `packages/cli/dist/tidytitles.mjs`):

```bash
npm run package     # an unpacked app in release/, for trying out locally
npm run dist        # installers for the current system in release/
```

Both run the desktop build first. `npm run package` makes an unsigned app (for example `release/mac-arm64/TidyTitles.app` on an Apple silicon Mac) using the Electron already installed in `node_modules`. `npm run dist` makes the installer for the system you run it on:

| Target | Built on | File in `apps/desktop/release/` |
|--------|----------|----------------------------------|
| macOS DMG, Apple silicon | macOS | `TidyTitles-<version>-macos-arm64.dmg` |
| macOS DMG, Intel | macOS | `TidyTitles-<version>-macos-x64.dmg` |
| Windows NSIS installer, x64 | Windows | `TidyTitles-<version>-windows-setup.exe` |
| Linux AppImage, x64 | Linux | `TidyTitles-<version>-x86_64.AppImage` |

To build exactly what the release workflow builds, pass the same targets (and, on macOS, both architectures):

```bash
# in apps/desktop, after npm run build at the repository root
CSC_IDENTITY_AUTO_DISCOVERY=false npx --no-install electron-builder --mac dmg --arm64 --x64 --publish never
CSC_IDENTITY_AUTO_DISCOVERY=false npx --no-install electron-builder --win nsis --x64 --publish never
CSC_IDENTITY_AUTO_DISCOVERY=false npx --no-install electron-builder --linux AppImage --x64 --publish never
```

`CSC_IDENTITY_AUTO_DISCOVERY=false` stops electron-builder from signing with a certificate it finds on your machine, so local builds match the unsigned release builds.

What the configuration sets:

- App ID `com.filerenamer.tidytitles`, product name **TidyTitles**.
- Only `out/` and `package.json` go into the app (as an asar archive). The main process bundles core and its dependencies, so no `node_modules` are shipped. Source maps and `out-e2e/` are left out.
- The CLI bundle is copied to `Resources/cli/tidytitles.mjs` (`resources/cli/` on Windows and Linux). The **Install Command Line Tool…** menu item writes a launcher that runs it with the app's own executable (`ELECTRON_RUN_AS_NODE=1`).
- macOS: DMG, hardened runtime, dark mode support, icon `build/icon.icns`.
- Windows: an NSIS installer (not one-click) that installs for all users (`perMachine`), lets the user change the folder, creates desktop and Start menu shortcuts, and shows the license from `installer/windows/license.txt`.
- Linux: AppImage, executable `TidyTitles`, desktop entry in the Utility and AudioVideo categories.
- Electron is pinned to an exact version in `apps/desktop/package.json`, because electron-builder rejects a version range.

App icons live in `apps/desktop/build/`. To regenerate `icon.icns` and `icon.png` from `icon.svg`:

```bash
cd apps/desktop
npm run icons
```

## Release

Releases are built by GitHub Actions (`.github/workflows/release.yml`) when a version tag is pushed.

1. Set the new version in the `version` field of `apps/desktop/package.json`. Keep `package.json`, `packages/core/package.json`, and `packages/cli/package.json` at the same version: `tidytitles --version` reports the CLI's version, and the installer names use the desktop app's. Run `npm install` to update `package-lock.json`.
2. Commit, then tag the commit with `v` plus the version and push the tag:

   ```bash
   git tag v0.2.0-beta.1
   git push origin v0.2.0-beta.1
   ```

The workflow then:

1. **Checks** that the tag equals `v` + the version in `apps/desktop/package.json`, and fails otherwise.
2. **Creates a GitHub release** named "TidyTitles *version*" with generated release notes, unless it already exists. A tag containing a hyphen (`-beta.1`, `-rc.1`) becomes a **prerelease**.
3. **Tests** on macOS, Windows, and Linux: `npm ci`, `npm run build`, `npm run typecheck`, `npm test` (Node 22).
4. **Packages** on each system, unsigned, and uploads the results to the release (replacing files of the same name if the job is re-run):
   - macOS: `TidyTitles-<version>-macos-arm64.dmg` and `TidyTitles-<version>-macos-x64.dmg`
   - Windows: `TidyTitles-<version>-windows-setup.exe`
   - Linux: `TidyTitles-<version>-x86_64.AppImage`

The packaging jobs start once the release exists; they do not wait for the test jobs, so check that the tests passed before announcing a release.

The Windows and Linux installers have so far only been built by the workflow, not tried by hand.

## Code signing

The builds are **not code signed or notarized**, on any system. People installing them see a Gatekeeper warning on macOS and a SmartScreen warning on Windows the first time, and need the steps in [Installation](wiki/Installation.md) to open the app. Signing would need an Apple Developer ID certificate (plus notarization) and a Windows code signing certificate, configured in `electron-builder.yml` and the workflow; neither is set up.

## Troubleshooting builds

### `Cannot find module '@tidytitles/core'` or the CLI or app does not see a change in core

Core has not been built, or was built before your change. Run `npm run build` from the repository root (or `npm run build -w @tidytitles/core`).

### "Install Command Line Tool…" says the tool is not included

`packages/cli/dist/tidytitles.mjs` did not exist when the app was packaged. Build the CLI and package again.

### npm warns about an unsupported engine, or Node reports syntax or module errors

Check `node --version`; you need 22.12 or newer.

### The tag push did not produce installers

Check the workflow run on GitHub. The most common cause is a tag that does not match `apps/desktop/package.json` (for example `v0.2.0` when the file says `0.2.0-beta.1`).

### The legacy Python app

The Python implementation in `src/file_renamer/` is the behavioral reference for the port and will be removed later. Its PyInstaller build (`build.py`, `file-renamer.spec`, and the scripts in `installer/`) is no longer used for releases. Do not change it; fix behavior in the TypeScript code. Note that `installer/windows/license.txt` is still used by the Windows installer, and `scripts/parser-parity.ts` reads the Python sources.
