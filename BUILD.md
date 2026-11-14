# Building TidyTitles

This guide is for working on TidyTitles itself: the repository layout, building, running from source, testing, making installers, and publishing a release. To install a released version, see [Installation](wiki/Installation.md).

- [Requirements](#requirements)
- [Repository layout](#repository-layout)
- [Build](#build)
- [Run from source](#run-from-source)
- [Test](#test)
- [Package the desktop app](#package-the-desktop-app)
- [Release](#release)
- [Automatic updates](#automatic-updates)
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
│       ├── src/main/             main process: controller.ts (state, workflow), updater.ts (updates), app.ts (window, menu, IPC)
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

This builds a test version of the app (`npm run build:e2e`, output in `out-e2e/`) whose main process uses fake metadata providers, then launches it with Playwright and drives the real window: security settings, adding a folder, fetching and choosing a match, canceling a fetch, renaming on disk, undo from history, editing a template in Settings, and restoring the window size. `e2e/updates.e2e.test.ts` drives the update UI (Check for Updates…, download progress, Restart to Update, the Download fallback, up to date, a failed check) with a scripted update engine in place of electron-updater, and saves light and dark screenshots. It uses a temporary config folder and media folder. `out-e2e/` is never packaged.

The same command also runs a smoke test of the **packaged** app (`e2e/packaged.e2e.test.ts`) if one exists: it starts the app, checks that its window loads and that core works inside the asar (TOML parsing, templates, reading MP3 tags), and that the bundled updater is wired up (it runs with `TIDYTITLES_DISABLE_UPDATES=1`, so it never checks). It looks for `release/mac-<arch>/TidyTitles.app` (made by `npm run package` on macOS), or the executable named in `TIDYTITLES_PACKAGED_APP`, and is skipped when there is none.

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
| macOS DMG and update zip, Apple silicon | macOS | `TidyTitles-<version>-macos-arm64.dmg`, `TidyTitles-<version>-macos-arm64.zip` |
| macOS DMG and update zip, Intel | macOS | `TidyTitles-<version>-macos-x64.dmg`, `TidyTitles-<version>-macos-x64.zip` |
| Windows NSIS installer, x64 | Windows | `TidyTitles-<version>-windows-setup.exe` |
| Linux AppImage, x64 | Linux | `TidyTitles-<version>-x86_64.AppImage` |

Next to the installers, electron-builder writes the update feed: an update-info file (`beta-mac.yml`, `beta.yml`, `beta-linux.yml` for a beta version; `latest-mac.yml`, `latest.yml`, `latest-linux.yml` for a stable one) and `.blockmap` files for differential downloads. See [Automatic updates](#automatic-updates).

To build exactly what the release workflow builds, pass the same targets (and, on macOS, both architectures):

```bash
# in apps/desktop, after npm run build at the repository root
CSC_IDENTITY_AUTO_DISCOVERY=false npx --no-install electron-builder --mac dmg zip --arm64 --x64 --publish never
CSC_IDENTITY_AUTO_DISCOVERY=false npx --no-install electron-builder --win nsis --x64 --publish never
CSC_IDENTITY_AUTO_DISCOVERY=false npx --no-install electron-builder --linux AppImage --x64 --publish never
```

`CSC_IDENTITY_AUTO_DISCOVERY=false` stops electron-builder from signing with a certificate it finds on your machine, so local builds match the unsigned release builds.

To check a packaging output the way the release workflow does:

```bash
node scripts/check-update-feed.mjs --platform mac      # or win, linux; --arch arm64 for a one-architecture build
```

It fails unless the update-info file the updater asks for exists, is for this version, and lists files that are present with matching `sha512` and `size`, and unless the zips, DMGs, installers, and block maps are there. `--list` prints the files a release uploads.

What the configuration sets:

- App ID `com.filerenamer.tidytitles`, product name **TidyTitles**.
- Only `out/` and `package.json` go into the app (as an asar archive). The main process bundles core, electron-updater, and their dependencies, so no `node_modules` are shipped (electron-updater is a devDependency for that reason). Source maps and `out-e2e/` are left out.
- `publish` (GitHub, `chrisoflaherty/TidyTitles`, `channel: ${channel}`) decides which update-info file is written and goes into `resources/app-update.yml`. Releases are still uploaded by the workflow (`--publish never`).
- The CLI bundle is copied to `Resources/cli/tidytitles.mjs` (`resources/cli/` on Windows and Linux). The **Install Command Line Tool…** menu item writes a launcher that runs it with the app's own executable (`ELECTRON_RUN_AS_NODE=1`).
- macOS: DMG plus a zip (the updater installs from the zip), hardened runtime with electron-builder's default entitlements (`allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`), dark mode support, icon `build/icon.icns`. Without a signing identity, `scripts/after-pack.cjs` gives the app an ad-hoc signature (no hardened runtime).
- Windows: an NSIS installer (not one-click) that installs for the current user by default (`perMachine: false`, so installs and updates need no administrator prompt) and still offers "Anyone who uses this computer", lets the user change the folder, creates desktop and Start menu shortcuts, and shows the license from `installer/windows/license.txt`.
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
2. **Creates a draft GitHub release** named "TidyTitles *version*" with generated release notes, unless it already exists. A tag containing a hyphen becomes a **prerelease**. Use `-beta.N` (or `-alpha.N`) for prereleases: the updater does not offer other prerelease names (such as `-rc.1`) to beta testers, and `check-update-feed.mjs` rejects them.
3. **Tests** on macOS, Windows, and Linux: `npm ci`, `npm run build`, `npm run typecheck`, `npm test` (Node 22).
4. **Packages** on each system, checks the update feed with `scripts/check-update-feed.mjs` (the job fails on a missing or inconsistent file), and uploads the files it lists (replacing files of the same name if the job is re-run). For a beta version:
   - macOS: `TidyTitles-<version>-macos-arm64.dmg`, `…-macos-x64.dmg`, `…-macos-arm64.zip`, `…-macos-x64.zip`, a `.blockmap` for each of the four, and `beta-mac.yml`
   - Windows: `TidyTitles-<version>-windows-setup.exe`, `…-windows-setup.exe.blockmap`, and `beta.yml`
   - Linux: `TidyTitles-<version>-x86_64.AppImage` and `beta-linux.yml` (its block map is inside the AppImage)

   For a stable version the update-info files are `latest-mac.yml`, `latest.yml`, and `latest-linux.yml`. No two jobs write a file with the same name. `builder-debug.yml` is never uploaded.
5. **Publishes** the draft once every packaging job and every test job has passed. Until then the release is invisible to the app's updater, so it never sees a half-uploaded release. If a job fails, fix it and re-run the workflow; the draft stays a draft.

The macOS job signs and notarizes when the signing secrets are set (see [Code signing](#code-signing)) and otherwise builds with an ad-hoc signature, as before.

The Windows and Linux installers have so far only been built by the workflow, not tried by hand.

## Automatic updates

The desktop app updates itself with [electron-updater](https://www.electron.build/auto-update) from the GitHub releases of `chrisoflaherty/TidyTitles`. The code is in `apps/desktop/src/main/updater.ts` (state machine, no Electron imports) and `updaterEngine.ts` (electron-updater and the checks of what this copy can do).

**Which releases an app is offered.** From electron-updater 6's `GitHubProvider.getLatestVersion`:

- An app on a prerelease (for example `0.2.0-beta.3`) has `allowPrerelease` on. It reads the releases Atom feed and takes the newest published release that is stable or `alpha`/`beta` (never `alpha` when it is on `beta`). For a beta release it downloads `beta-mac.yml`, `beta.yml`, or `beta-linux.yml`; for a stable release `latest-mac.yml`, `latest.yml`, or `latest-linux.yml`.
- An app on a stable version asks GitHub for `/releases/latest`, which is never a prerelease, so it is offered only stable versions.
- A version that is not newer is ignored (`allowDowngrade` is off, and the app checks again itself).

`electron-builder.yml` publishes with `channel: ${channel}` (the prerelease name, or `latest`), so each build writes exactly the file the updater asks for in its release. Drafts are not in the Atom feed, which is why the workflow publishes only at the end.

**Who installs updates itself:**

| System | Installs updates itself when | Otherwise |
|--------|------------------------------|-----------|
| macOS | the app is signed with a Developer ID (`codesign` shows a TeamIdentifier) and the folder that contains it is writable and it is not translocated | it checks and offers **Download** (the release page) |
| Windows | it was installed by the NSIS installer (`resources/app-update.yml` exists) | it checks and offers **Download** |
| Linux | it runs from the AppImage (`APPIMAGE` is set) | it checks and offers **Download** |

An ad-hoc signed Mac app cannot update itself: Squirrel.Mac only installs an update whose signature satisfies the running app's designated requirement, which an ad-hoc signature never does. The app reads its own signature at startup (`codesign --display`) and, when it is ad-hoc, only checks, without downloading anything. A failed download or install also switches to the **Download** offer for the rest of the session; nothing retries in a loop.

Windows builds are unsigned, so electron-updater does not verify a signature on the downloaded installer (it does that only when `publisherName` is configured, which needs a certificate). The download is still checked against the `sha512` in `beta.yml`/`latest.yml`, fetched over HTTPS from GitHub; that protects against a damaged download, not against someone who can change the release itself.

**Turning updates off:** they are off in development (`npm run dev`), in the e2e test build, and when `TIDYTITLES_DISABLE_UPDATES=1` is set. Tests never contact the network: the e2e build uses a scripted engine (`src/e2e/fakeUpdates.ts`).

### Testing updates locally

Before the repository is public the real feed cannot be used, so test against a local server with two builds of different versions. `--mode update-test` builds the app with a local feed URL and a scratch folder for config and userData baked in (both are null in every other build; `scripts/check-build.mjs` fails a production build that contains them). Run in `apps/desktop`, after `npm run build` at the repository root:

```bash
SCRATCH=/tmp/tidytitles-update-test        # any empty folder
TIDYTITLES_UPDATE_TEST_DIR=$SCRATCH/appdata TIDYTITLES_UPDATE_TEST_FEED=http://127.0.0.1:8765/ \
  npx --no-install electron-vite build --mode update-test

# Two versions, signed with the same identity (the system updater requires it).
for v in 90 91; do
  CSC_NAME="Apple Development: Your Name (TEAMID)" npx --no-install electron-builder --mac zip --arm64 \
    --publish never -c.electronDist=../../node_modules/electron/dist \
    -c.extraMetadata.version=0.2.0-beta.$v -c.directories.output=$SCRATCH/v$v -c.mac.notarize=false
done

mkdir -p $SCRATCH/feed $SCRATCH/install
cp $SCRATCH/v91/*.zip $SCRATCH/v91/*.blockmap $SCRATCH/v91/beta-mac.yml $SCRATCH/feed/
ditto $SCRATCH/v90/mac-arm64/TidyTitles.app $SCRATCH/install/TidyTitles.app
(cd $SCRATCH/feed && python3 -m http.server 8765 --bind 127.0.0.1) &
$SCRATCH/install/TidyTitles.app/Contents/MacOS/TidyTitles    # then TidyTitles → Check for Updates…

npm run build    # afterward: put the production build back in out/
```

Use `CSC_IDENTITY_AUTO_DISCOVERY=false` instead of `CSC_NAME` for the first build to see the ad-hoc path (**Download** instead of a download). The test leaves `~/Library/Caches/@tidytitlesdesktop-updater`, `~/Library/Caches/com.filerenamer.tidytitles`, and `~/Library/Caches/com.filerenamer.tidytitles.ShipIt`; delete them afterward.

What was verified this way on an Apple silicon Mac (macOS 27), with both builds signed with an Apple Development identity and hardened runtime: the 0.2.0-beta.90 app found 0.2.0-beta.91, downloaded it with progress, showed **Restart to Update**, and **Restart to Update** installed 0.2.0-beta.91 and relaunched it. An ad-hoc signed 0.2.0-beta.90 found the update, did not download it, and offered **Download**.

### Testing updates against real releases

The released, notarized builds were also tested against the real GitHub feed on the same Mac (0.2.0-beta.5 updating to 0.2.0-beta.6): the app found the new release, downloaded it, and installed it both ways, on a normal quit and with **Restart to Update** (which reopened as 0.2.0-beta.6). Not verified: Intel Macs, Windows, and Linux.

To repeat that test without touching your installed copy, extract an older release zip into a scratch folder and start it **with `open`**, the way Finder does:

```bash
launchctl setenv TIDYTITLES_CONFIG_DIR /tmp/tt/cfg     # also applies to the relaunched app; unset afterward
open -n /tmp/tt/app/TidyTitles.app --args --user-data-dir=/tmp/tt/userdata
launchctl unsetenv TIDYTITLES_CONFIG_DIR
```

Do not start the app's binary directly from a terminal (`TidyTitles.app/Contents/MacOS/TidyTitles`) for this. macOS then attributes the process to the terminal, denies it write access to its own notarized bundle, and the system updater stalls without any error: the update downloads, **Restart to Update** appears, and nothing ever installs. The installer's log is `~/Library/Caches/com.filerenamer.tidytitles.ShipIt/ShipIt_stderr.log`. A test leaves a `com.filerenamer.tidytitles.ShipIt` launchd job pointing into the scratch folder; remove it with `launchctl remove com.filerenamer.tidytitles.ShipIt`, along with the caches listed above.

## Code signing

Windows and Linux builds are not signed. The macOS build is signed and notarized by the release workflow once the five secrets below exist; until then it gets an ad-hoc signature (`scripts/after-pack.cjs`), and people installing it see the Gatekeeper warning described in [Installation](wiki/Installation.md). A signed build is also what lets the Mac app install its own updates.

### Enable signing and notarization (macOS)

You need a paid Apple Developer Program membership (the Account Holder role, to create a Developer ID certificate).

1. **Create a Developer ID Application certificate.** On your Mac open **Keychain Access** → **Keychain Access** menu → **Certificate Assistant** → **Request a Certificate From a Certificate Authority…**. Enter your email and name, choose **Saved to disk**, and save the `.certSigningRequest`. At [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates/list) click **+**, choose **Developer ID Application** (G2 Sub-CA), upload the request, download the `.cer`, and double-click it to add it to your login keychain. (Xcode → Settings → Accounts → Manage Certificates → **+** → Developer ID Application does the same in one step.)
2. **Export it as a `.p12`.** In Keychain Access → **My Certificates**, expand "Developer ID Application: *Your Name* (*TEAMID*)" so the private key shows, select the certificate, then **File** → **Export Items…** → format **Personal Information Exchange (.p12)**. Choose a strong password; it becomes `CSC_KEY_PASSWORD`. Keep the file out of the repository and delete it once the secret is set.
3. **Create an app-specific password.** Sign in at [account.apple.com](https://account.apple.com) → **Sign-In and Security** → **App-Specific Passwords** → **+**, name it (for example "TidyTitles notarization"), and copy the password (`xxxx-xxxx-xxxx-xxxx`).
4. **Find your Team ID.** It is shown at [developer.apple.com/account](https://developer.apple.com/account) under **Membership details**, and in parentheses in the certificate's name.
5. **Add the five secrets** to the repository (run in the repository folder; each command asks for the value, or reads it from standard input):

   ```bash
   base64 -i DeveloperID.p12 | gh secret set CSC_LINK
   gh secret set CSC_KEY_PASSWORD             # the .p12 password
   gh secret set APPLE_ID                     # your Apple Account email
   gh secret set APPLE_APP_SPECIFIC_PASSWORD  # from step 3
   gh secret set APPLE_TEAM_ID                # from step 4
   ```

How the workflow uses them: the macOS packaging job maps them to its environment (only that job sees them; the Windows job must not, because electron-builder would try to sign the Windows installer with `CSC_LINK`). With `CSC_LINK` set, electron-builder imports the certificate into a temporary keychain and signs with the hardened runtime, and, because `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` are all set, notarizes with `notarytool` and staples the ticket (app-builder-lib `MacTargetHelper.notarizeIfProvided`, which runs whenever those variables are set and `mac.notarize` is not `false`). If `CSC_LINK` is set but one of the `APPLE_*` secrets is missing, the job fails rather than ship a signed but un-notarized app. Without `CSC_LINK` it builds the ad-hoc signed app, as before.

The command-line tool runs the app's own executable with `ELECTRON_RUN_AS_NODE=1`. That keeps working in a signed build: the `runAsNode` fuse is left on, and the default entitlements allow the JIT that Node mode needs. Verified with an Apple Development identity and the hardened runtime (`tidytitles --version` through the bundled CLI); not yet with a Developer ID certificate.

The first signed release cannot be installed as an update by people on an earlier, ad-hoc signed version (the signatures differ); their app offers **Download** for it, and updates install themselves from then on.

### Verify a signed build

On a Mac, with the release's DMG mounted or the app copied to Applications:

```bash
codesign -dv --verbose=4 /Applications/TidyTitles.app   # Authority=Developer ID Application: …, TeamIdentifier=…, flags=0x10000(runtime)
codesign --verify --deep --strict --verbose=2 /Applications/TidyTitles.app
spctl -a -vv /Applications/TidyTitles.app                # accepted, source=Notarized Developer ID
xcrun stapler validate /Applications/TidyTitles.app      # The validate action worked!
```

These commands are standard, but have not been run against a Developer ID build of TidyTitles yet: signing with the secrets and notarization are untested until the first signed release.

## Troubleshooting builds

### `Cannot find module '@tidytitles/core'` or the CLI or app does not see a change in core

Core has not been built, or was built before your change. Run `npm run build` from the repository root (or `npm run build -w @tidytitles/core`).

### "Install Command Line Tool…" says the tool is not included

`packages/cli/dist/tidytitles.mjs` did not exist when the app was packaged. Build the CLI and package again.

### npm warns about an unsupported engine, or Node reports syntax or module errors

Check `node --version`; you need 22.12 or newer.

### The release workflow fails at "Check the update feed"

The update-info file is missing, is for another version, or lists a file whose `sha512` or `size` differs. The error lists each problem. A prerelease name other than `beta` or `alpha` also fails here. Run `node scripts/check-update-feed.mjs --platform <mac|win|linux>` locally on the same output to reproduce.

### The tag push did not produce installers

Check the workflow run on GitHub. The most common cause is a tag that does not match `apps/desktop/package.json` (for example `v0.2.0` when the file says `0.2.0-beta.1`).

### The legacy Python app

The Python implementation in `src/file_renamer/` is the behavioral reference for the port and will be removed later. Its PyInstaller build (`build.py`, `file-renamer.spec`, and the scripts in `installer/`) is no longer used for releases. Do not change it; fix behavior in the TypeScript code. Note that `installer/windows/license.txt` is still used by the Windows installer, and `scripts/parser-parity.ts` reads the Python sources.
