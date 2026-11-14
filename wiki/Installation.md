# Installation

This page covers installing the TidyTitles desktop app from a release, getting past the warnings that unsigned apps trigger, adding the `tidytitles` command to your terminal, and running TidyTitles from a source checkout.

- [Download a release](#download-a-release)
- [macOS](#macos)
- [Windows](#windows)
- [Linux](#linux)
- [The command-line tool](#the-command-line-tool)
- [From source](#from-source)
- [Upgrading](#upgrading)
- [Uninstalling](#uninstalling)

## Download a release

Installers are attached to each release on the [Releases page](https://github.com/chrisoflaherty/TidyTitles/releases). Versions with a hyphen, such as `0.2.0-beta.1`, are marked as prereleases.

| System | File | Notes |
|--------|------|-------|
| macOS on Apple silicon (M1, M2, M3, M4, ...) | `TidyTitles-<version>-macos-arm64.dmg` | |
| macOS on an Intel Mac | `TidyTitles-<version>-macos-x64.dmg` | |
| Windows, 64-bit | `TidyTitles-<version>-windows-setup.exe` | Installs for all users |
| Linux, 64-bit (x86-64) | `TidyTitles-<version>-x86_64.AppImage` | No installation; one file |

Not sure which Mac you have? Open the Apple menu → **About This Mac**. If it lists a **Chip** (for example "Apple M2"), take `arm64`. If it lists a **Processor** (for example "Intel Core i7"), take `x64`.

### About the warnings: the builds are not code signed

The release builds are **not code signed and not notarized**. Nothing is wrong with the files, but macOS and Windows cannot confirm who made them, so they warn you or refuse to open the app the first time. The sections below show what you will see and how to continue. You only need to do this once per installed version.

## macOS

1. Open the `.dmg` and drag **TidyTitles** into the **Applications** folder.
2. Eject the disk image.
3. Open TidyTitles from Applications.

The first time, macOS (Gatekeeper) refuses to open it. Depending on your macOS version the message says that Apple could not verify TidyTitles is free of malware, or that the app "is damaged and can't be opened". Click **Done** (or **Cancel**), not **Move to Trash**. Then use either of these:

**Option A: System Settings**

1. Open **System Settings** → **Privacy & Security**.
2. Scroll to the **Security** section. You will see a line saying TidyTitles was blocked.
3. Click **Open Anyway** and confirm with your password or Touch ID.
4. Open TidyTitles again and click **Open** in the dialog.

**Option B: Terminal**

Remove the quarantine flag that macOS added when you downloaded the file:

```bash
xattr -dr com.apple.quarantine /Applications/TidyTitles.app
```

Then open TidyTitles normally. Option B is the one to use if you see the "is damaged" message and there is no **Open Anyway** button.

Run TidyTitles from **Applications**, not from inside the disk image. The command-line tool launcher (below) records where the app is, so it must stay in place.

## Windows

1. Run `TidyTitles-<version>-windows-setup.exe`.
2. Microsoft Defender SmartScreen shows **"Windows protected your PC"**. Click **More info**, then **Run anyway**.
3. Windows asks for administrator permission (a User Account Control prompt). This is expected: the installer installs TidyTitles for all users of the computer, by default under Program Files. Click **Yes**.
4. Accept the MIT license, choose the installation folder if you want a different one, and click **Install**.

The installer creates a **TidyTitles** shortcut on the desktop and in the Start menu.

The Windows build is produced by the release workflow but has not yet been tried by hand. Please report problems on the [issue tracker](https://github.com/chrisoflaherty/TidyTitles/issues).

## Linux

The AppImage is a single file that runs without installing anything.

```bash
chmod +x TidyTitles-*-x86_64.AppImage
./TidyTitles-*-x86_64.AppImage
```

You can also make it executable in your file manager (Properties → Permissions → "Allow executing file as program") and double-click it.

AppImages need FUSE to run. If it fails with an error about FUSE or `libfuse.so.2`, install your distribution's FUSE 2 package (on Ubuntu 22.04 and later: `sudo apt install libfuse2`).

Like the Windows build, the Linux build is produced by the release workflow but has not yet been tried by hand.

## The command-line tool

The `tidytitles` command does everything the app does (and a few things more, such as `--output` and `--json`). There are three ways to get it.

### 1. From the desktop app (macOS and Linux)

The app carries its own copy of the command-line tool and the runtime to run it, so you do not need Node.js.

- macOS: **TidyTitles** menu → **Install Command Line Tool…**
- Linux: **File** menu → **Install Command Line Tool…**

It writes a small shell script named `tidytitles`:

- into `/usr/local/bin` if that folder exists and you can write to it,
- otherwise into `~/.local/bin` (created if needed).

The script runs the CLI bundled inside the app (`TidyTitles.app/Contents/Resources/cli/tidytitles.mjs` on macOS) with the app's own executable in Node mode. If a `tidytitles` file that TidyTitles did not write is already there, you are asked before it is replaced; one it wrote earlier is replaced without asking.

When it finishes, a dialog tells you where it put the command. If that folder is not on your `PATH` yet, the dialog shows the line to add to your shell profile, for example:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Open a new terminal window and check:

```bash
tidytitles --version
```

On Linux the AppImage is mounted at a different place every time it runs, so the launcher runs the AppImage file itself and uses a copy of the CLI saved to `~/.local/share/TidyTitles/cli/tidytitles.mjs` (or `$XDG_DATA_HOME/TidyTitles/cli/`). If you move or replace the AppImage, choose **Install Command Line Tool…** again. On macOS, do the same if you move `TidyTitles.app`.

### 2. On Windows

On Windows the menu item (**File** → **Install Command Line Tool…**) does not install a file. It shows a PowerShell function and a **Copy Command** button. The function looks like this (with the paths of your installation):

```powershell
function tidytitles { $env:ELECTRON_RUN_AS_NODE = '1'; & 'C:\Program Files\TidyTitles\TidyTitles.exe' 'C:\Program Files\TidyTitles\resources\cli\tidytitles.mjs' @args; Remove-Item Env:ELECTRON_RUN_AS_NODE }
```

Add it to your PowerShell profile:

1. In PowerShell, run `notepad $PROFILE` (create the file if Notepad asks).
2. Paste the copied line, save, and close Notepad.
3. Open a new PowerShell window and run `tidytitles --help`.

It works only in PowerShell, not in the classic Command Prompt.

### 3. From a source checkout

If you build TidyTitles from source (next section), run the CLI from the repository folder with `npx`:

```bash
npx tidytitles --help
npx file-renamer --help      # the same program, under its old name
```

`npx` uses the copy in the repository; it does not download anything. Outside the repository, run the built file with Node directly:

```bash
node /path/to/TidyTitles/packages/cli/dist/index.js --help
```

`packages/cli/dist/tidytitles.mjs` is a single self-contained file (it is the one the desktop app ships). You can copy it anywhere and run it with `node tidytitles.mjs`, as long as Node.js 22.12 or newer is installed.

## From source

Requirements:

- Node.js **22.12 or newer** (check with `node --version`)
- npm (comes with Node.js)
- git

```bash
git clone https://github.com/chrisoflaherty/TidyTitles.git
cd TidyTitles
npm install
npm run build
```

`npm run build` builds the three parts in order: `packages/core`, then `packages/cli`, then `apps/desktop`. Then:

```bash
# Command line
npx tidytitles --help

# Desktop app, with hot reload
cd apps/desktop
npm run dev
```

[BUILD.md](../BUILD.md) explains the repository layout, tests, and how to make installers.

## Upgrading

- **macOS:** download the new `.dmg` and drag TidyTitles into Applications again, replacing the old copy. Repeat the Gatekeeper step above for the new version.
- **Windows:** run the new installer. Repeat the SmartScreen step.
- **Linux:** download the new AppImage, make it executable, and delete the old one. Choose **Install Command Line Tool…** again if you use the command-line tool.
- **Source checkout:** `git pull`, `npm install`, `npm run build`.

Your settings and rename history are kept; they live outside the app (see [Configuration](Configuration.md#where-files-are-stored)).

## Uninstalling

- **macOS:** drag `TidyTitles.app` from Applications to the Trash. Remove the command-line launcher if you installed it: `rm /usr/local/bin/tidytitles` or `rm ~/.local/bin/tidytitles`.
- **Windows:** **Settings** → **Apps** → **Installed apps** → **TidyTitles** → **Uninstall**. Remove the `tidytitles` function from your PowerShell profile if you added it.
- **Linux:** delete the AppImage, `~/.local/bin/tidytitles` (or `/usr/local/bin/tidytitles`), and `~/.local/share/TidyTitles/`.

Uninstalling does not remove your settings, API keys, history, or cache. To remove them too, delete these folders (the Python version of the app used the same ones):

| System | Settings and history | Cache |
|--------|----------------------|-------|
| macOS | `~/Library/Application Support/file-renamer/` | `~/Library/Caches/file-renamer/` |
| Windows | `%LOCALAPPDATA%\file-renamer\file-renamer\` | `%LOCALAPPDATA%\file-renamer\file-renamer\Cache\` |
| Linux | `~/.config/file-renamer/` | `~/.cache/file-renamer/` |

The desktop app also keeps its window size and position in its own folder: `~/Library/Application Support/TidyTitles/` (macOS), `%APPDATA%\TidyTitles\` (Windows), or `~/.config/TidyTitles/` (Linux).
