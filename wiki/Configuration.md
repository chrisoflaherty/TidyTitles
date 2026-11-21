# Configuration

TidyTitles keeps its settings in a TOML file, `config.toml`, and the record of recent renames in `history.json`. The desktop app and the command-line tool share both files. They are also the files the Python version of TidyTitles used, in the same place and format, so you can switch between the versions freely.

- [Where files are stored](#where-files-are-stored)
- [Changing settings](#changing-settings)
- [The config.toml file](#the-configtoml-file)
- [Settings reference](#settings-reference)
- [Conflict resolution](#conflict-resolution)
- [Associated files](#associated-files)
- [Cover art](#cover-art)
- [Writing tags into music files](#writing-tags-into-music-files)
- [NFO files](#nfo-files)
- [Watch folders](#watch-folders)
- [Environment variables](#environment-variables)
- [Using a different settings folder](#using-a-different-settings-folder)
- [Rename history](#rename-history)
- [Cache](#cache)
- [Backing up and resetting](#backing-up-and-resetting)

## Where files are stored

| System | Settings (`config.toml`) and history (`history.json`) |
|--------|-------------------------------------------------------|
| macOS | `~/Library/Application Support/file-renamer/` |
| Windows | `%LOCALAPPDATA%\file-renamer\file-renamer\` |
| Linux | `$XDG_CONFIG_HOME/file-renamer/`, or `~/.config/file-renamer/` when `XDG_CONFIG_HOME` is not set |

| System | Cache |
|--------|-------|
| macOS | `~/Library/Caches/file-renamer/` |
| Windows | `%LOCALAPPDATA%\file-renamer\file-renamer\Cache\` |
| Linux | `$XDG_CACHE_HOME/file-renamer/`, or `~/.cache/file-renamer/` |

The folder name is `file-renamer`, not `TidyTitles`, for compatibility with the Python version. `tidytitles config show` prints the exact paths on your system, and the desktop app's Settings window shows the config file path in its footer.

The desktop app also stores its window size and position in `window-state.json` in its own folder (`~/Library/Application Support/TidyTitles/` on macOS, `%APPDATA%\TidyTitles\` on Windows, `~/.config/TidyTitles/` on Linux). Nothing else is kept there.

## Changing settings

| Setting | Desktop app | Command line | `config.toml` |
|---------|-------------|--------------|---------------|
| Templates | Settings → Templates | `config set-template` | `[templates]` |
| Naming preset (fills all three templates) | Settings → Templates → Naming preset | `config preset` | `[templates]` |
| TMDB / TVDB API keys | Settings → API Keys | `config set-key` | `[api]` |
| TVDB subscriber PIN | Settings → API Keys | | `[api] tvdb_pin` |
| Associated files | Settings → Files | | `[associated_files]` |
| Conflict resolution | Settings → Files → When the new name is taken | | `[behavior] conflict_resolution` |
| Cover art | Settings → Cover Art | | `[cover_art]` |
| Preferred TV service | Settings → Providers | | `[providers] tv` |

To edit the file by hand, open it in any text editor. Changes are picked up the next time a command runs, or in the desktop app the next time you fetch metadata or open Settings.

## The config.toml file

This is the file as TidyTitles writes it, with every setting at its default:

```toml
# File Renamer Configuration

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
```

`[output]`, `[history]`, `[tv]`, `[metadata]`, `[write_metadata]`, and `[watch]` were added after the original layout; a file without them loads with the defaults.

Every key is optional; a missing key takes its default. Booleans also accept `1`/`0` and strings such as `"yes"`/`"no"`. Unknown sections and keys are ignored when reading.

Saving (from the desktop app, `config set-key`, `config set-template`, or `config init`) **rewrites the whole file** in exactly this layout. Comments you added and unknown keys are not kept.

If the file cannot be parsed or a value has the wrong type, the CLI stops with an error such as `Error: Could not parse .../config.toml: Invalid TOML document: ...` or `Error: Invalid configuration (...): behavior.dry_run: Invalid input: expected boolean, received string`, and the desktop app shows the error and uses the defaults until the file is fixed. This applies to every key, including the ones that have no effect. See [Troubleshooting](Troubleshooting.md#configuration).

## Settings reference

### Templates

| Key | Default | Description |
|-----|---------|-------------|
| `templates.movie` | `{title} ({year})` | Movie names |
| `templates.tv` | `{title} - S{season2}E{episode2} - {episode_title}` | TV episode names |
| `templates.music` | `{artist}/{album} ({year})/{track2} - {title}` | Music names (and folders) |

See [Templates](Templates.md). A [naming preset](Templates.md#naming-presets) only writes these three keys; no preset name is stored. The preset in effect is the one whose templates equal these, or "Custom".

### API keys

| Key | Default | Description |
|-----|---------|-------------|
| `api.tmdb_api_key` | `""` | TMDB API key (v3) or API Read Access Token |
| `api.tvdb_api_key` | `""` | TVDB API key |
| `api.tvdb_pin` | `""` | TVDB subscriber PIN, sent when logging in to TVDB (optional) |

Keys are stored as plain text. See [API Keys](API-Keys.md).

### Associated files

| Key | Default | Description |
|-----|---------|-------------|
| `associated_files.enabled` | `true` | Rename associated files with their media file |
| `associated_files.subtitles` | `true` | `.srt`, `.vtt`, `.ass`, `.ssa`, `.sub`, `.idx` |
| `associated_files.nfo` | `true` | `.nfo` |
| `associated_files.images` | `true` | `.jpg`, `.jpeg`, `.png`, `.tbn` |

See [Associated files](#associated-files) below.

### Cover art

| Key | Default | Description |
|-----|---------|-------------|
| `cover_art.enabled` | `false` | Download cover art after renaming. Desktop app: the default for the **Download cover art** checkbox. CLI: when `true`, every `rename` downloads cover art, as if `--cover-art` were given. |
| `cover_art.filename` | `poster.jpg` | File name for movie and TV posters |
| `cover_art.music_filename` | `cover.jpg` | File name for album covers |
| `cover_art.overwrite` | `false` | Replace a poster or cover that is already there |
| `cover_art.size` | `w500` | TMDB poster size: `w92`, `w154`, `w185`, `w342`, `w500`, `w780`, or `original` |

### Behavior

| Key | Default | Description |
|-----|---------|-------------|
| `behavior.conflict_resolution` | `skip` | `skip`, `overwrite`, or `auto_version`. See [Conflict resolution](#conflict-resolution). Any other value acts as `skip`. |
| `behavior.dry_run` | `false` | Stored for compatibility; has no effect. Use `--dry-run`. |
| `behavior.overwrite` | `false` | Stored for compatibility; has no effect. Use `conflict_resolution = "overwrite"`. |
| `behavior.preview_before_rename` | `true` | Stored for compatibility; has no effect. The CLI always shows the preview, and the app always shows the new names before renaming. |

### Providers

| Key | Default | Description |
|-----|---------|-------------|
| `providers.tv` | `tvdb` | `tvdb` or `tmdb`: which service TV episodes use when the provider is Auto and both keys are set. If the preferred service has no key, the other is used. |
| `providers.movie` | `tmdb` | Stored for compatibility; has no effect. Movies always use TMDB. |
| `providers.music` | `musicbrainz` | Stored for compatibility; has no effect. Music always uses MusicBrainz. |

### Output

| Key | Default | Description |
|-----|---------|-------------|
| `output.movie` | `""` | Folder that renamed movies go into. Empty: next to the original. Must be a full (absolute) path. |
| `output.tv` | `""` | Folder for renamed TV episodes. |
| `output.music` | `""` | Folder for renamed music. |
| `output.transfer_mode` | `move` | `move`, `copy`, or `hardlink`. See [Output folders and transfer modes](#output-folders-and-transfer-modes). Any other value is a configuration error. |

### History

| Key | Default | Description |
|-----|---------|-------------|
| `history.max_entries` | `200` | How many renames `history.json` keeps for undo, 1 to 10,000. |

### TV and metadata

| Key | Default | Description |
|-----|---------|-------------|
| `tv.episode_order` | `aired` | `aired`, `dvd`, or `absolute`: how the season and episode numbers in file names count, and how the new names count. See below. |
| `metadata.language` | `en-US` | Language for movie, show, and episode titles, as a language code: `en-US`, `de-DE`, `pt-BR`, `ja-JP`, or just `de`. A title with no translation falls back to English, then to the original title. MusicBrainz is not affected. |

Files without these tables (written by the Python app or an older TidyTitles) load with the defaults.

**Episode orders:**

- **Aired**: the broadcast order. Right for most shows.
- **DVD**: the order of the DVD release, for shows whose discs reorder episodes (Firefly, Futurama). TVDB has it for most shows; TMDB only for shows with a DVD episode group. A show without one is left unmatched with **Order not available**.
- **Absolute**: one running number for the whole show, as anime is often numbered. The episode number in the file is read as the absolute number, and new names put every episode in season 1 (`S01E1100`). Specials (season 0) keep their numbers. TMDB counts the show's aired episodes in order; specials do not count.

Whatever the order, a file with an episode number but no season (`[Group] Show - 123`) is read as an absolute number and named in the chosen order, and a file named by date (`Show.2024.03.15`) is found by its air date and named with its aired season and episode.

The CLI can override both for one run with `--order` and `--language`.

### Write metadata

| Key | Default | Description |
|-----|---------|-------------|
| `write_metadata.music_tags` | `false` | After renaming, write a MusicBrainz match's tags into the music file. See [Writing tags into music files](#writing-tags-into-music-files). |
| `write_metadata.nfo` | `false` | After renaming, write NFO files for Kodi, Jellyfin, and Emby. See [NFO files](#nfo-files). |

Both are off unless you turn them on: in the app, **Settings** → **Files** → **Write metadata**; in the CLI, `--write-tags` and `--write-nfo` (and `--no-write-tags`, `--no-write-nfo`) override them for one run.

### Watch

| Key | Default | Description |
|-----|---------|-------------|
| `watch.enabled` | `false` | The desktop app watches `folders` while it is open. The CLI's `watch` command ignores this key (running the command is the decision). |
| `watch.folders` | `[]` | Folders to watch, as absolute paths, for example `["/Users/me/Downloads"]` or `["C:\\Users\\Me\\Downloads"]`. At most 50. |
| `watch.recursive` | `true` | Files in subfolders count too. |
| `watch.mode` | `review` | `review` or `automatic`; see [Watch folders](#watch-folders). The CLI renames automatically only with `--auto`. |
| `watch.settle_seconds` | `10` | How long, 2 to 3,600 seconds, a new file's size and modification time must stay unchanged before it is touched. |

Files without the table load with these defaults.

## Output folders and transfer modes

In the desktop app these are **Settings** → **Output**, plus the **Transfer** menu and **Output** button in the main window. In the CLI, `--output` and `--transfer` override them for one run.

- **Output folders.** A matched file goes into the folder for its kind (movie, TV episode, or music); folders the template adds, such as `Artist/Album (1975)/`, are created inside it. Associated files (subtitles and so on) go with their media file. A file without a match stays where it is. A kind with no folder is renamed in place.
- **A missing or unusable folder stops the run before anything is renamed.** If a configured folder does not exist (for example, the drive or network share is not connected), is a file, or cannot be written to, the CLI exits with an error such as `The movie output folder doesn't exist (is the drive connected?): /Volumes/Media/Movies`, and the app shows it when you fetch metadata. TidyTitles never creates a configured output folder, so files are never written to an empty mount point by mistake. It checks again just before renaming. The CLI's `--output` folder *is* created when missing, as it always was.
- **move** (the default) renames the file. When the destination is on another drive, the file is copied (to a temporary name first, so a half-copied file never has the new name), and then the original is deleted.
- **copy** makes a renamed copy and leaves the original untouched. The copy keeps the original's modification time. If the copy fails partway (for example, the disk is full), the temporary file is removed and nothing has the new name.
- **hardlink** gives the same data a second name: no extra disk space, and the original name stays. A hard link only works within one drive. A file whose destination is on another drive is skipped and reported (**Can't link across drives** in the app, "can't hard link to another volume" in the CLI); it is never copied instead. On a drive that does not support hard links (for example, FAT or exFAT) the file is skipped with **Links not supported** ("the volume doesn't support hard links").
- Conflict resolution works the same in every mode. With **Replace the existing file** (overwrite), the existing file is replaced in one step, never deleted first.
- Cover art is saved next to the renamed files, so in an output folder.

## Conflict resolution

`conflict_resolution` decides what happens when a file's new name is already taken. In the desktop app this is **Settings** → **Files** → **When the new name is taken**.

A name is "taken" in two ways: a file with that name already exists on disk, or another file in the same batch would get the same new name.

**`skip`** (the default; "Skip the file" in the app)

The file keeps its old name and is reported as skipped. If two files in the batch would get the same name, the first one (in sorted order) gets it and the others are skipped as duplicates.

```
Existing:  The Matrix (1999).mkv
Renaming:  The.Matrix.1999.REMASTERED.mkv  →  skipped (destination exists)
```

**`auto_version`** ("Add a number")

The file gets the next free name with a number before the extension: ` (1)`, ` (2)`, and so on. This applies both to files already on disk and to files in the same batch. Associated files get their own numbers the same way.

```
Existing:  The Matrix (1999).mkv
Renaming:  The.Matrix.1999.REMASTERED.mkv  →  The Matrix (1999) (1).mkv

Existing:  The Matrix (1999).mkv, The Matrix (1999) (1).mkv
Renaming:  The.Matrix.1999.mkv              →  The Matrix (1999) (2).mkv
```

**`overwrite`** ("Replace the existing file")

The existing file at the new name is **replaced** and its contents are lost. Undo cannot bring it back. Two safeguards apply:

- Another file in the same batch is never overwritten, so swapping or chaining names within one batch cannot destroy a file. Such an operation is skipped ("Name taken" in the app). This covers every file in the batch, including one that is itself skipped (for example because it already has its target name).
- If two files in the batch would get the same new name, only the first gets it; the others are skipped as duplicates, exactly as with `skip`.

A file that already has its new name, exactly or differing only in letter case, is never treated as a conflict with itself. Case-only renames (`the matrix (1999).mkv` → `The Matrix (1999).mkv`) work with every setting, including on case-insensitive disks.

## Associated files

When `associated_files.enabled` is `true`, TidyTitles looks in the media file's folder for files that share its base name and have one of the enabled extensions, and gives them the matching new name. Anything between the base name and the extension (usually a language code) is kept.

```
Inception.2010.720p.WEB-DL.mkv     →  Inception (2010).mkv
Inception.2010.720p.WEB-DL.srt     →  Inception (2010).srt
Inception.2010.720p.WEB-DL.en.srt  →  Inception (2010).en.srt
Inception.2010.720p.WEB-DL.nfo     →  Inception (2010).nfo
Inception.2010.720p.WEB-DL.jpg     →  Inception (2010).jpg
```

- Associated files always go to the same folder as the media file's new name, including folders the template creates.
- They are renamed after their media file. If one fails, the media file still counts as renamed and the failure is reported.
- They are recorded in the history, so undo moves them back too.
- This applies to music files as well as video.
- Files such as `poster.jpg` or `cover.jpg` that do not share the base name are not associated files and are left alone.

## Cover art

When cover art is on (the **Download cover art** checkbox, `--cover-art`, or `cover_art.enabled = true` for the CLI), TidyTitles downloads art after renaming and saves it in the folder of each renamed file:

- **Movies:** the movie's poster from TMDB, as `cover_art.filename`.
- **TV episodes:** the show's poster, as `cover_art.filename`, when the show has one.
- **Music:** the album cover, from the album's cover URL or, for MusicBrainz releases, the [Cover Art Archive](https://coverartarchive.org/), as `cover_art.music_filename`.

If the file is already there and `cover_art.overwrite` is `false`, nothing is downloaded. Files in one folder therefore share one poster or cover. The extension is changed to match the image (`.jpg`, `.png`, or `.webp`). Failed downloads are skipped without an error. Cover art is not downloaded in a dry run.

## Writing tags into music files

With `write_metadata.music_tags` on, a renamed music file whose match came from MusicBrainz gets the match's **title, artist, album, album artist, track number, disc number, year, and genre** written into it, as far as the match has them.

- **Only what is better.** A field is written only when the match has a value and the file's value differs. Nothing is ever blanked: a field the match does not have keeps the file's value (a track number without a total keeps the file's total). Case counts for names ("queen" becomes "Queen"); a genre that differs only in case is left alone. A track total is written only for single-disc releases, because MusicBrainz counts the tracks of every disc together. A match built from the file's own tags (shown as **Verified** or **Unverified**) is not written: it holds nothing new.
- **Formats:** MP3 (ID3v2.3 and ID3v2.4; a file without a tag gets ID3v2.3), FLAC, M4A (MP4 audio), Ogg Vorbis, and Opus. Other music files (WAV, AIFF, WMA, AAC, APE) are renamed as usual and reported as **tags not written** (`unsupported_format`). A supported file laid out in a way TidyTitles does not write (for example ID3v2.2, an unsynchronised or extended ID3 header, a fragmented MP4, or an Ogg file with several streams) is renamed and reported with `unsupported_layout`.
- **Everything else stays.** Only the entries of those fields change. Embedded artwork, other tags (comments, lyrics, ReplayGain, sort names, MusicBrainz IDs), and the audio itself are copied byte for byte. Padding in the tag absorbs the change where it can, so the audio stays where it was.
- **Written safely.** The new file is written to a hidden temporary file next to the original, read back, and put in place in one step. If anything fails, or another program changes the file meanwhile, the original is untouched and the file is reported with a reason (`write_failed`, `changed_during_write`, `verify_failed`). The file keeps its permissions; its modification time becomes the time of the change, so media servers notice.
- **Transfer modes.** With **move**, tags go into the moved file. With **copy**, they go into the copy only; the original is never touched. With **hard link**, tags are **not** written (`hard_link`): both names share the same data, so the original would change too. A moved file that has other hard links (for example, one a download client is seeding) is also left alone (`shared_data`).
- **Undo** puts the old tags back exactly as they were (and the old modification time), then moves the file back. If the file was changed after the rename (for example, edited in a tag editor), undo moves it back without touching its tags. Undoing a copy deletes the copy.
- **Dry run** (`--dry-run`) reads the files and lists the tags that would change, without writing anything.

## NFO files

With `write_metadata.nfo` on, TidyTitles writes XML `.nfo` files from the metadata it found, after each successful rename. **Kodi, Jellyfin, and Emby read them; Plex does not** (not without a third-party agent).

- **Movie:** `<movie>` (title, original title, year, release date, plot, genres, TMDB ID as `<uniqueid>`) in `Movie Name (Year).nfo`, next to the video and named after it.
- **Episode:** `<episodedetails>` (title, show title, season, episode, air date, plot) next to the episode, named after it. A file that holds several episodes gets one `<episodedetails>` per episode, one after the other, the layout Kodi up to version 21 and Jellyfin read. Kodi 22 expects a separate NFO per episode for such files instead, and Emby reads only the first; those are not written.
- **Show:** `tvshow.nfo` (title, original title, year, genres, network as `<studio>`, status, TMDB or TVDB ID) in the show's folder. The show's folder is the episode's folder, or the one above it when that is a season folder (`Season 1`, `S01`, `Specials`), and only when its name contains the show's title, as with a template like `{title}/Season {season}/...`. Episodes in a shared folder (the default flat template) get no `tvshow.nfo` (reported as "no show folder"). It is created by the first episode of a rename that finds none, and never replaced.

Each file is UTF-8 with an XML declaration and a `<!-- Written by TidyTitles -->` comment. Text is escaped, and characters XML does not allow are dropped, so the file is valid whatever the titles contain.

- **Existing files are kept.** If a file of that name is already there, it is left alone and reported, unless conflict resolution is **Replace the existing file** (`overwrite`). An NFO that moved with the video as an associated file is never replaced, whatever the setting. NFO files go next to the renamed video, so into the output folder when there is one, in every transfer mode.
- **Undo** removes the NFO files the rename created, if they are unchanged since. A replaced file, or one you edited afterward, is left in place. `tvshow.nfo` is removed only when no video is left in the show's folder (or two folders below it) after the undo, because other episodes use it.
- **Dry run** lists the files that would be written.

## Watch folders

A watch folder is a folder, such as a downloads folder, where TidyTitles notices new media files and looks them up without your adding them. Watching is off until you turn it on: **Settings** → **Watch** in the desktop app, or the `tidytitles watch` command. The desktop app watches **only while it is open**; there is no background service and no login item, so quitting the app stops watching. For around-the-clock watching on a server, run `tidytitles watch` (for example under your system's service manager).

**When a file has finished arriving.** A file being copied or downloaded is never touched. A new file is handed on only when:

- its size and modification time have not changed for the settle period (`settle_seconds`, 10 seconds by default; use a longer one for slow network shares or copies that stall);
- its name is not a temporary download name: names ending in `.part`, `.partial`, `.crdownload` (Chrome, Edge), `.download` (Safari), `.opdownload` (Opera), `.!qB` (qBittorrent), `.!ut`, `.!bt`, `.bc!`, `.jc!`, `.dtapart`, `.aria2`, `.xltd`, `.td`, `.filepart` (WinSCP), `.!sync`, `.tmp`, `.temp`, `.crswap`, macOS "safe save" names (`.sb-…`), hidden names starting with `.` (rsync and Syncthing temporaries), `~$` lock files, and names ending in `~`. The finished file is picked up under its final name. Folders with such names (Safari's `Movie.mkv.download`), hidden folders, and system folders (`@eaDir`, `#recycle`, `$RECYCLE.BIN`, `System Volume Information`, `lost+found`) are not looked into;
- no companion that marks it as unfinished sits next to it: `Movie.mkv.part` (Firefox writes an empty `Movie.mkv` first), `Movie.mkv.aria2`, `.crdownload`, `.!qB`, `.!ut`, or `.filepart`;
- on macOS, Finder is not still copying it (Finder gives a file it is copying the creation date January 24, 1984).

**Review mode** (the default): new files are looked up and wait for you. In the desktop app they are added to the file list and fetched, exactly as if you had added them and clicked **Fetch Metadata**, including the question when a search finds several matches; you rename them as usual. The CLI reports them and renames nothing.

**Automatic mode**: a file is renamed without asking only when all of these hold; otherwise it waits for review and nothing about it changes on disk:

1. The lookup found **exactly one** candidate: a movie or show search with a single result (and, for TV, the episode was found), a music search with a single result, or music tags that MusicBrainz confirmed. A search with several results is never resolved by taking the first one. Music tags MusicBrainz could not confirm wait too.
2. The new name is free: nothing exists at the new name, or at the new name of any of its subtitles and other associated files, and no other new file wants the same name. This holds whatever **When a file already exists** (`conflict_resolution`) says: automatic renames never replace a file and never add a number; such files go to review, where your setting applies.
3. The naming template could be filled in, and a hard link (in hard-link mode) is possible.
4. It is still the file that finished arriving (same size, modification time, and identity), checked again right before renaming, and its associated files have not changed within the settle period.

Automatic renames use everything a normal rename uses: the output folders, the transfer mode (move, copy, hard link), associated files, and cover art. They are saved in the [rename history](#rename-history), one entry per batch, so they can be undone like any rename.

**Lookups that fail** because a service is down, rate-limits, or rejects the key are tried again later, not in a loop: after 30 seconds, then 1, 2, 4 minutes and so on, up to 30 minutes between tries. New files that arrive meanwhile wait for the same retry, so a service that is down is asked once per wait. A lookup that cannot succeed by retrying (no episodes in the chosen order) goes to review.

**Files already there.** Files that are in a folder when watching starts are left alone. So are the files found in a folder that went missing and came back (an unplugged drive or a disconnected share): TidyTitles cannot tell what arrived while it was away. To process them anyway, use **Process Existing Files** in the desktop app's Watch Activity, or `tidytitles watch --existing`.

**No loops.** A file TidyTitles renamed inside a watched folder is not picked up again, in either mode, and neither is a file moved back by undo: files are recognized by their identity (device, inode, size, and modification time), and the identities in the rename history count too, so a file renamed by the other front end is recognized as well. Output folders inside a watched folder are never watched.

**How changes are found.** Each watched folder is rescanned (its listing, not the files' contents) every 30 seconds, and the operating system's change notifications only make the next rescan happen sooner. Network shares (SMB, NFS) usually do not report changes made by other computers, so on them new files are found by the rescan, within about 30 seconds plus the settle period. A watched folder that disappears is checked again every 10 seconds and watched again when it comes back. Folders and files that cannot be read are reported and skipped; watching goes on.

## Environment variables

Every setting can also come from an environment variable named `FILE_RENAMER_` plus the setting's name, with `__` (two underscores) between a section and a key. Names are not case-sensitive.

| Variable | Setting |
|----------|---------|
| `FILE_RENAMER_API__TMDB_API_KEY` | `api.tmdb_api_key` |
| `FILE_RENAMER_API__TVDB_API_KEY` | `api.tvdb_api_key` |
| `FILE_RENAMER_API__TVDB_PIN` | `api.tvdb_pin` |
| `FILE_RENAMER_TEMPLATES__MOVIE` | `templates.movie` (also `__TV`, `__MUSIC`) |
| `FILE_RENAMER_ASSOCIATED_FILES__ENABLED` | `associated_files.enabled` (also `__SUBTITLES`, `__NFO`, `__IMAGES`) |
| `FILE_RENAMER_COVER_ART__ENABLED` | `cover_art.enabled` (also `__FILENAME`, `__MUSIC_FILENAME`, `__OVERWRITE`, `__SIZE`) |
| `FILE_RENAMER_CONFLICT_RESOLUTION` | `behavior.conflict_resolution` |
| `FILE_RENAMER_TV_PROVIDER` | `providers.tv` |
| `FILE_RENAMER_OUTPUT__MOVIE` | `output.movie` (also `__TV`, `__MUSIC`, `__TRANSFER_MODE`) |
| `FILE_RENAMER_HISTORY__MAX_ENTRIES` | `history.max_entries` |
| `FILE_RENAMER_TV__EPISODE_ORDER` | `tv.episode_order` |
| `FILE_RENAMER_METADATA__LANGUAGE` | `metadata.language` |
| `FILE_RENAMER_WRITE_METADATA__MUSIC_TAGS` | `write_metadata.music_tags` |
| `FILE_RENAMER_WRITE_METADATA__NFO` | `write_metadata.nfo` |
| `FILE_RENAMER_WATCH__ENABLED` | `watch.enabled` (also `__RECURSIVE`, `__MODE`, `__SETTLE_SECONDS`) |
| `FILE_RENAMER_WATCH__FOLDERS` | `watch.folders`: a JSON array such as `["/srv/in","/srv/more"]`, or a single folder |

The `[behavior]` and `[providers]` settings use flat names without a section: `FILE_RENAMER_CONFLICT_RESOLUTION`, `FILE_RENAMER_DRY_RUN`, `FILE_RENAMER_MOVIE_PROVIDER`, `FILE_RENAMER_TV_PROVIDER`, `FILE_RENAMER_MUSIC_PROVIDER`. A whole section can also be given as JSON, for example `FILE_RENAMER_API='{"tmdb_api_key": "..."}'`; the `__` variables win over the JSON.

### Precedence

From highest to lowest:

1. A value in `config.toml`
2. An environment variable
3. The default

So the environment only fills in what the file does not set. This is easy to trip over with API keys: as soon as TidyTitles has saved `config.toml` once, the file contains `tmdb_api_key = ""`, and that empty value beats `FILE_RENAMER_API__TMDB_API_KEY`. To use the environment variable, delete the `tmdb_api_key` line (or `tvdb_api_key`) from `config.toml`.

```bash
FILE_RENAMER_API__TMDB_API_KEY=your_key tidytitles rename ~/Downloads --dry-run
```

`config init` writes the defaults plus any `FILE_RENAMER_*` values into the new file.

## Using a different settings folder

For testing, or to keep separate setups, point TidyTitles at another folder. It then uses `config.toml` and `history.json` in that folder and keeps its cache in a `cache` subfolder.

- CLI: `--config-dir <dir>`, or the `TIDYTITLES_CONFIG_DIR` environment variable (the option wins).
- Desktop app: start its executable from a terminal with `TIDYTITLES_CONFIG_DIR` set, for example on macOS:

  ```bash
  TIDYTITLES_CONFIG_DIR=~/tidytitles-test /Applications/TidyTitles.app/Contents/MacOS/TidyTitles
  ```

  Only one copy of TidyTitles runs at a time, so quit the app first.

## Rename history

`history.json` records each batch of renames so it can be undone. The newest batch is first, and the last 200 batches are kept (`history.max_entries`; earlier versions kept 10). Only files that were actually renamed are recorded; a dry run records nothing.

200 is a balance between undo reach and size. Each renamed file takes about half a kilobyte, so 200 batches of 10 to 50 files is roughly 1 to 5 MB, which loads in a few milliseconds. If you rename thousands of files at a time, a lower limit keeps the file small; if you rename a few files at a time, raise it as high as 10,000.

```json
[
  {
    "timestamp": "2026-11-14T21:05:42.123000",
    "operations": [
      {
        "source": "/Users/me/Downloads/Inception.2010.720p.WEB-DL.mkv",
        "destination": "/Users/me/Downloads/Inception (2010).mkv",
        "associated_files": [
          {
            "source": "/Users/me/Downloads/Inception.2010.720p.WEB-DL.en.srt",
            "destination": "/Users/me/Downloads/Inception (2010).en.srt"
          }
        ]
      }
    ]
  }
]
```

- `timestamp` is local time without a time zone (here November 14, 2026, 9:05 PM).
- Paths are absolute.
- Entries written by this version also have a `fingerprint` on each file (`dev`, `ino`, `size`, `mtime_ns`: the file right after it was renamed), and `"transfer": "copy"` or `"hardlink"` for copies and links. Undo uses the fingerprint to tell its own files from other files put at the same path later. Older entries have no fingerprint and still load and undo.
- With [write metadata](#write-metadata) on, an operation can also have `tags` (the format, the size of the tag area, the original entries of each field that was rewritten in base64, the modification time before, and the `fingerprint` of the file after its tags were written) and `created_files` (the NFO files the rename created, each with `path`, `kind`, and `fingerprint`). Older versions ignore both and still undo the rename itself.
- Undo (`tidytitles undo`, or **Undo** in the app) reverts the first entry and removes it, or, if some files could not be moved back, keeps just those files in it. `tidytitles undo --entry N` and **History** in the app undo an older entry.
- Undo moves a file back only if it is still the same file (same drive and file ID). It deletes a copy or link only if the copy or link is unchanged and the original still exists, and it never touches the original. Anything else is left in place and reported as **Left in place**, with the reason.
- While the history is being written, a lock file (`history.json.lock`) keeps the CLI and the app from overwriting each other's entries. A lock older than 30 seconds is treated as left over from a crash.

Deleting `history.json` is safe; you just cannot undo earlier renames any more.

## Cache

Responses from TMDB, TVDB, and MusicBrainz are cached on disk for **24 hours**, one small JSON file per request, so looking up the same files again is fast and makes fewer requests. Expired entries are removed in the background, at most once a day. The cache format is shared with the Python version. Deleting the cache folder is always safe:

```bash
rm -rf ~/Library/Caches/file-renamer      # macOS
rm -rf ~/.cache/file-renamer              # Linux
```

```powershell
Remove-Item -Recurse "$env:LOCALAPPDATA\file-renamer\file-renamer\Cache"   # Windows
```

## Backing up and resetting

Back up by copying `config.toml` (it contains your API keys) and, if you like, `history.json`:

```bash
cp ~/Library/Application\ Support/file-renamer/config.toml ~/tidytitles-config-backup.toml   # macOS
cp ~/.config/file-renamer/config.toml ~/tidytitles-config-backup.toml                        # Linux
```

To reset everything to the defaults, run `tidytitles config init` and confirm the overwrite, or delete `config.toml`. Either way your API keys are removed too.
