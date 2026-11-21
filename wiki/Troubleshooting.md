# Troubleshooting

Common problems and how to solve them, grouped by where they show up.

- [Installing and opening the app](#installing-and-opening-the-app)
- [Updates](#updates)
- [The command-line tool](#the-command-line-tool)
- [Metadata lookups](#metadata-lookups)
- [Files and renaming](#files-and-renaming)
- [Parsing: wrong title, year, or type](#parsing-wrong-title-year-or-type)
- [Undo](#undo)
- [Configuration](#configuration)
- [Desktop app](#desktop-app)
- [Getting help](#getting-help)

## Installing and opening the app

The release builds are not code signed, so the first launch is blocked on macOS and Windows. This is expected. [Installation](Installation.md) has step-by-step instructions; the short versions are below.

### macOS: "TidyTitles" cannot be opened / Apple could not verify it / "is damaged"

Gatekeeper blocks apps that are not signed and notarized by a registered developer. Do one of these once:

- **System Settings** → **Privacy & Security** → scroll to **Security** → **Open Anyway** next to the TidyTitles message, then confirm.
- Or, in Terminal:

  ```bash
  xattr -dr com.apple.quarantine /Applications/TidyTitles.app
  ```

The "is damaged and can't be opened" message usually means the same thing (a downloaded, unsigned app), and the `xattr` command fixes it. Do not choose **Move to Trash**.

### macOS: the app does not start, or starts slowly, on an Intel Mac (or the reverse)

Check that you downloaded the right disk image: `macos-arm64` for Apple silicon, `macos-x64` for Intel. Apple menu → **About This Mac** shows **Chip** (Apple silicon) or **Processor** (Intel). An x64 build runs on Apple silicon through Rosetta, but more slowly.

### Windows: "Windows protected your PC"

Microsoft Defender SmartScreen warns about installers without a code signature. Click **More info**, then **Run anyway**.

### Windows: the installer asks for administrator permission

You chose **Anyone who uses this computer**, or an earlier version (0.2.0-beta.2 or before) is installed for all users, and the installer keeps that installation where it is. Installing for all users needs administrator rights, for every update too. To install without prompts, uninstall TidyTitles from **Settings** → **Apps**, then run the installer again and choose **Only for me**. Your settings and history are kept. See [Installation](Installation.md#windows).

### Windows: antivirus flags or removes the installer

Some antivirus programs are wary of new unsigned programs. If you downloaded the installer from this project's Releases page, you can allow it in your antivirus settings. Please also report it on the [issue tracker](https://github.com/chrisoflaherty/TidyTitles/issues).

### Linux: "Permission denied" when starting the AppImage

Make it executable first:

```bash
chmod +x TidyTitles-*-x86_64.AppImage
```

### Linux: the AppImage fails with a FUSE error

AppImages need FUSE 2. Install it with your package manager (Ubuntu 22.04 and later: `sudo apt install libfuse2`).

The Windows and Linux builds have not yet been tried by hand. If you hit a problem not listed here, please [report it](#getting-help).

## Updates

### macOS: the app says a new version is available but offers only "Download"

This copy is not signed with an Apple Developer ID, so macOS does not let it replace itself (the system updater checks the new version's signature against the running app's). Click **Download**, get the `.dmg` from the release page, and install it over the old copy (drag it into Applications and replace). The current release builds are all in this state until the project's macOS builds are signed.

The same happens when TidyTitles runs from the disk image or from a folder it cannot change: move it to **Applications** and start it from there.

### "The update couldn't be downloaded" or "couldn't be installed automatically"

The app downloaded or tried to install the update and something failed. It does not retry by itself during this session; click **Download** and install the new version by hand, or restart TidyTitles to let it try again later.

### "Couldn't check for updates"

- **Couldn't reach GitHub**: you are offline, or a firewall or proxy blocks `github.com`. Try again when you are online.
- **No update information was found**: a release is being published right now, or the releases page cannot be read. Try again later, or use **Open Releases Page**.

Automatic checks never show these messages; only **Check for Updates…** does.

### Linux: updates never install

They install only when TidyTitles runs from its AppImage file (the file is replaced by the new version, so it must be writable). Run the AppImage directly, not an extracted copy.

### Windows: every update asks for administrator permission

TidyTitles is installed for all users. See [the installer asks for administrator permission](#windows-the-installer-asks-for-administrator-permission).

### I don't want automatic updates

Turn off **Check for updates automatically** in **Settings** → **Updates**. You can still use **Check for Updates…**. Administrators and scripts can turn updates off completely by starting the app with the environment variable `TIDYTITLES_DISABLE_UPDATES=1`.

## The command-line tool

### `tidytitles: command not found`

- **Installed from the desktop app:** the launcher went into `/usr/local/bin` or `~/.local/bin`. The success dialog said which, and whether it is on your `PATH`. If it is not, add it to your shell profile (for example `~/.zshrc` or `~/.bashrc`) and open a new terminal:

  ```bash
  export PATH="$HOME/.local/bin:$PATH"
  ```

- **Windows:** the menu item does not install a file; it gives you a PowerShell function to add to your profile. Run `notepad $PROFILE`, paste it, and open a new PowerShell window. See [Installation](Installation.md#2-on-windows).
- **Source checkout:** run it as `npx tidytitles` from inside the repository, after `npm run build`. Elsewhere, use `node /path/to/TidyTitles/packages/cli/dist/index.js`.

### The launcher stopped working after moving or updating the app

The launcher records the app's location. On macOS, keep `TidyTitles.app` in Applications. On Linux, the launcher points at the AppImage file and a copy of the CLI in `~/.local/share/TidyTitles/cli/`. After moving, renaming, or replacing the app or AppImage, choose **Install Command Line Tool…** again.

### "Install Command Line Tool…" is grayed out ("Not included in this build")

The app was built without the bundled CLI, typically a development build. Build the CLI (`npm run build` from the repository root) and package the app again, or use `npx tidytitles` from the source checkout.

### `npx tidytitles` downloads something or says the command is not found

Run it from inside the TidyTitles repository after `npm install` and `npm run build`. To make sure `npx` never downloads a package from the internet, use `npx --no-install tidytitles`.

### `file-renamer` runs the old Python app

If the Python package is still installed, its `file-renamer` command may come first on your `PATH`. Use `tidytitles` instead, or remove the Python package with `pip uninstall file-renamer`.

### Something went wrong and the message is not enough

Set `DEBUG=1` to print a stack trace with the error:

```bash
DEBUG=1 tidytitles rename ~/Downloads --dry-run
```

## Metadata lookups

### "No API keys configured" or "TMDB API key not configured"

The CLI needs a TMDB or TVDB key for movies and TV:

```bash
tidytitles config set-key tmdb YOUR_TMDB_API_KEY
```

Or rename music only with `--type music` (no key needed). See [API Keys](API-Keys.md).

### I set `FILE_RENAMER_API__TMDB_API_KEY` but TidyTitles says no key is configured

A value in `config.toml` wins over the environment, even an empty `tmdb_api_key = ""`, which TidyTitles writes whenever it saves the file. Delete the `tmdb_api_key` line from `config.toml`. See [Precedence](Configuration.md#precedence).

### "API key rejected" (app) or "Invalid TMDB API key" / "Invalid TVDB API key" (CLI)

The service refused the key. Check it for missing or extra characters, try TMDB's other credential (API Key versus Read Access Token), and make sure your TVDB access is active. [API Keys](API-Keys.md#when-a-key-is-rejected) shows how to test a TMDB key with curl.

### "Rate limited" or "rate limit exceeded"

The service is limiting requests. Wait a minute and try again. Responses are cached for 24 hours, so files already looked up do not count again. MusicBrainz allows about one request per second, and TidyTitles waits between requests, so large music batches are slow but should not hit the limit.

### "Lookup failed"

The service could not be reached or returned an error (no internet connection, a firewall, or the service is down). Only the affected files are skipped. Check your connection and fetch again. In the CLI, the message appears as `Error: Metadata lookup failed for N file(s): ...` and the command exits 1.

### "Order not available" (app) or lookup error kind `order_unavailable` (CLI)

The TV service has no episodes in the chosen episode order for this show: TMDB has DVD order only for shows with a DVD episode group, and TVDB lists no DVD or absolute order for some shows. Choose **Aired** in **Settings** → **Providers** (`--order aired` in the CLI), or use TVDB, which has DVD and absolute orders for most shows.

### Titles are in English (or the original language) instead of the language I chose

The service has no translation for that title, so TidyTitles used the English title, then the original one. Translations are added by the services' users; check the show on TVDB or TMDB. The language is set in **Settings** → **Providers** → **Metadata language**, or with `--language` in the CLI.

### "No match"

Nothing was found for the parsed title, or you skipped the file when asked to choose. Also:

- Movies are only looked up when a TMDB key is set and the provider is **Auto** or **TMDB**.
- TV episodes need a season and episode number (`S01E01`, `1x01`, ...), an air date (`Show.2024.03.15`), or an episode number on its own (`[Group] Show - 123`, read as an absolute number); with none of these, no lookup is made.
- A file with several episodes (`S01E01E02`) is matched only when every one of them is found. Check the numbers in the filename.
- In **Absolute** order the episode number is read as the absolute number, so `S02E05` means episode 5 of the whole show. Use **Aired** order for files numbered by season.
- With the **MusicBrainz** provider, movies and TV are not looked up at all.

Check what TidyTitles read from the filename with `tidytitles preview <file>`, then see [Parsing](#parsing-wrong-title-year-or-type).

### Files with several matches were skipped (CLI)

When standard input is not a terminal (in a script, a cron job, or with input piped in), the CLI cannot ask you to choose, so files with several matches are skipped. Add `--auto-select` to take the first result, or run the command in a terminal.

### Music shows "Unverified"

The new name comes from the file's own tags (or, without tags, from its filename) and MusicBrainz could not confirm them, or was not asked (provider set to TMDB or TVDB). Check these names before renaming. Tags are confirmed when MusicBrainz has a recording with the same artist and title (ignoring case, punctuation, a leading "The", and "(feat. ...)"). Several files from one album are first checked against that album's track list on MusicBrainz; a file the list does not confirm is then searched on its own.

## Files and renaming

### Files are not picked up

- Only these extensions are scanned. Video: `.mkv`, `.mp4`, `.avi`, `.mov`, `.wmv`, `.flv`, `.webm`, `.m4v`, `.mpg`, `.mpeg`, `.ts`, `.m2ts`. Audio: `.mp3`, `.flac`, `.m4a`, `.ogg`, `.opus`, `.wav`, `.aiff`, `.wma`, `.aac`, `.ape`.
- The **Type** decides what a folder scan looks for: Movies and TV Shows find only video, Music only audio.
- Files in subfolders are found only with **Include subfolders** (app, checked before adding the folder) or `--recursive` (CLI).
- Hidden files and folders (starting with `.`) are always skipped.
- `tidytitles preview` lists only video files.

A file named directly on the command line, or chosen in **Add Files…**, is always processed.

### "destination exists" / "Name taken"

A file with the new name already exists, and the conflict setting is **Skip the file** (`conflict_resolution = "skip"`). Either move the existing file, or choose **Add a number** or **Replace the existing file** in **Settings** → **Files** (or set `conflict_resolution` in `config.toml`). See [Conflict resolution](Configuration.md#conflict-resolution).

With **Replace the existing file**, a file is still not overwritten if it is part of the same batch.

### "duplicate destination" / "Duplicate name"

Two files in the batch would get the same new name (for example two copies of the same movie). The first one gets the name and the others are skipped. Choose **Add a number** (`auto_version`) to number the extras, or remove the duplicates from the list.

### "Source file does not exist"

The file was moved, renamed, or deleted after it was added to the list (or after the CLI scanned it). Fetch or run the command again.

### "Permission denied" or "Failed to rename file"

You do not have permission to change the file or its folder, or the file is in use (on Windows, close any program playing it). Check the permissions on the folder. Running TidyTitles as an administrator or with `sudo` is not recommended; fix the folder's permissions instead.

### Renaming across disks is slow

When `--output` points to another disk, each file is copied and then the original is deleted, which takes as long as copying the file.

### Associated files were not renamed

They must be in the same folder and start with exactly the media file's base name: `Movie.2010.mkv` with `Movie.2010.srt` or `Movie.2010.en.srt`. Check that the type is enabled in **Settings** → **Files** (`[associated_files]` in `config.toml`). See [Associated files](Configuration.md#associated-files).

### A folder was created with an odd name, or a "/" disappeared

A `/` in the template creates folders, but a `/` inside a title or artist name is removed (`AC/DC` → `ACDC`), and characters like `:` and `?` are removed too. Empty placeholders leave empty brackets, such as `Album ()` when a track has no year. See [How names are cleaned](Templates.md#how-names-are-cleaned).

## Parsing: wrong title, year, or type

Check what TidyTitles reads from a name:

```bash
tidytitles preview "/path/to/The.Movie.2024.1080p.mkv"
```

### Wrong title

Release names with extra words (edition names, languages, site tags) can confuse the parser. Rename the file to something simpler, such as `Movie Title 2024.mkv` or `Movie Title (2024).mkv`, and try again. In the app, when several matches are found you can also pick the right one.

### A TV episode is treated as a movie (or the reverse)

Set the type explicitly: **Type** → **TV Shows** or **Movies** in the app, or `--type tv` / `--type movie` in the CLI.

### No year, or the wrong year

Make sure the release year is in the filename. Resolutions such as `2160p` are not years.

### Music files are named "01" or "Unknown"

Music is named from its tags first. Without tags, the filename is used, and patterns such as `Artist - Album - 01 - Title` or `01 - Artist - Title` are recognized. The filename fallback splits at the first `-`, so a hyphenated artist name like `AC-DC` in a filename is misread. Tag your files (with a tag editor) for reliable results.

## Undo

### "No rename history found" / "There is no rename to undo"

Nothing has been renamed since the history was last emptied, or `history.json` was deleted. Dry runs are not recorded.

### Undo says "Not found"

The file is no longer at its renamed location (it was moved or deleted after the rename), so there was nothing to move back.

### Undo failed for some files

Usually the original name is now taken by another file; undo never overwrites. Move that file out of the way and run undo again: files that failed stay in the history for another try.

### "The rename history changed since it was shown"

Another rename was recorded (or undone), for example by the CLI while the app was open, between showing you what would be undone and doing it. Nothing was moved. Look at what Undo now offers and try again.

### Empty folders are left after undo

Undo moves files back but does not delete the folders the rename created. Delete them by hand.

### I want to undo an older rename

The history keeps the last 10 renames. Undo always reverts the newest one left, so undo repeatedly to go back further.

## Configuration

### "Invalid configuration" or "Could not parse config.toml"

`config.toml` has a syntax error or a value of the wrong type. The message names the problem, for example `behavior.dry_run: Invalid input: expected boolean, received string`. Fix the file in a text editor, or reset it with `tidytitles config init` (this also removes your API keys). In the desktop app, the error is shown in the window and the defaults are used; saving Settings then replaces the file with the defaults plus whatever you entered.

### A setting has no effect

`behavior.dry_run`, `behavior.overwrite`, `behavior.preview_before_rename`, `providers.movie`, and `providers.music` are stored for compatibility with the Python app but are not used. Use `--dry-run` and `conflict_resolution` instead. See [Settings reference](Configuration.md#settings-reference).

### Comments I added to config.toml disappeared

Saving rewrites the whole file in a fixed layout, without comments or unknown keys.

### The rename history is in use by another TidyTitles process

The CLI and the app take turns writing `history.json`, using a lock file. If one process crashed while holding it, the lock is ignored after 30 seconds. If the message persists, make sure no other TidyTitles is running and delete `history.json.lock` from the settings folder.

## Desktop app

### "Couldn't Fetch Metadata"

Usually `config.toml` could not be loaded; the message says why. See [Configuration](#configuration).

### Only "MusicBrainz (music only)" is in the Provider menu

No TMDB or TVDB key is set. Add one in **Settings** → **API Keys**.

### Rename is grayed out

Fetch metadata first, and make sure at least one file is ready (not all skipped). Changing **Type**, **Provider**, the list, or the settings after fetching clears the new names; fetch again.

### The window will not close

It will not close while files are being renamed or restored. Wait for that to finish. Closing while fetching just stops the fetch.

### Dropped files were not added

A drop adds only files whose extension matches the selected **Type** (folders are scanned the same way). Nothing can be dropped while a task is running. The same goes for files dropped on the Dock icon or the Windows shortcut, opened with **Open With**, or named on the command line: while a task is running or a dialog is open, TidyTitles says "The item wasn’t added"; open them again when it is done.

### TidyTitles is not listed under "Open With" for a video or song

That is on purpose. macOS makes an app listed under **Open With** the default for any file type no other installed app opens (on a new Mac, `.mkv` files), so double-clicking such a movie would open TidyTitles instead of your player. TidyTitles is listed under **Open With** only for folders (Finder stays their default). To add files, drop them on TidyTitles in the Dock or on its icon in Applications. TidyTitles never makes itself the default app for any file type, on any system.

### No notification appears when a rename finishes

Notifications appear only when TidyTitles is not the active app. Otherwise the summary in the window says the same. If you switched away and still saw none, check that notifications are allowed for TidyTitles: macOS **System Settings** → **Notifications** → **TidyTitles**; Windows **Settings** → **System** → **Notifications**.

### The CLI renamed files but the app's Undo offers something else

The app reads the history when it starts and after each rename or undo it does. Restart the app, or just click **Undo**: if the history changed, it refuses and refreshes, and the next Undo offers the newest rename.

## Getting help

If you are still stuck, open an issue at https://github.com/chrisoflaherty/TidyTitles/issues (also **Help** → **Report an Issue** in the app). Please include:

- your operating system and version, and whether you use the app or the CLI,
- the TidyTitles version (`tidytitles --version`, or **About TidyTitles**),
- the exact error message, and for the CLI the output with `DEBUG=1`,
- an example filename and what you expected it to become.

Never include your API keys or your whole `config.toml`.
