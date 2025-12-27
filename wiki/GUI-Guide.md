# GUI Guide

TidyTitles includes a graphical user interface for users who prefer visual file management.

## Launching the GUI

```bash
file-renamer-gui
```

If you get an error about PySide6, install it first:

```bash
pip install PySide6
```

## Interface Overview

```
┌─────────────────────────────────────────────────────────────┐
│  TidyTitles                                                 │
├─────────────────────────────────────────────────────────────┤
│  [/path/to/folder                          ] [Browse...]    │
├─────────────────────────────────────────────────────────────┤
│  Type: [Auto-detect ▼]  ☐ Recursive  ☐ Cover Art   [Fetch] │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┬─────────────────────┬────────┐         │
│  │ Original        │ New Name            │ Status │         │
│  ├─────────────────┼─────────────────────┼────────┤         │
│  │ Movie.2024.mkv  │ Movie (2024).mkv    │ Ready  │         │
│  │ Show.S01E01.mkv │ Show - S01E01.mkv   │ Ready  │         │
│  │ song.mp3        │ Artist/Album/01.mp3 │ Ready  │         │
│  └─────────────────┴─────────────────────┴────────┘         │
├─────────────────────────────────────────────────────────────┤
│  Ready                                    [Rename Files]    │
└─────────────────────────────────────────────────────────────┘
```

## Step-by-Step Usage

### 1. Select Files

**Option A: Browse**
- Click the "Browse..." button
- Select one or more video files
- Or select a folder to load all videos in it
- Selected files are added to the list

**Option B: Drag and Drop**
- Drag files or folders from Finder/Explorer
- Drop them onto the application window
- **Multiple files** - Drag and drop multiple files at once
- **Mix sources** - Add files from different locations
- **Accumulative** - Files are added to the existing list
- **Auto-filter** - Only supported media files are added (videos + audio)

**Option C: Clear**
- Click the "Clear" button to remove all files from the list
- Start fresh with a new selection

### 2. Choose Media Type

Use the dropdown to select:
- **Auto-detect** - Let TidyTitles determine if files are movies, TV shows, or music
- **Movies** - Force all files to be treated as movies
- **TV Shows** - Force all files to be treated as TV episodes
- **Music** - Force all files to be treated as music tracks

### 3. Configure Options

**Recursive Scanning:**
- Check **"Recursive"** to scan subdirectories when adding folders
- Useful for large media libraries with nested folder structures

**Cover Art Download:**
- Check **"Cover Art"** to download posters and album covers
- Movie/TV posters are saved as `poster.jpg`
- Album art is saved as `cover.jpg`

### 4. Fetch Metadata

Click **"Fetch Metadata"** to:
- Connect to TMDB (movies), TVDB (TV shows), or MusicBrainz (music)
- Look up each file
- Populate the preview table with new names

A progress dialog will show the status.

**Interactive Selection:**

When multiple matches are found for a file, a selection dialog appears:

```
┌─────────────────────────────────────────────────────────────┐
│  Multiple matches found for: Movie.2024.mkv                 │
├─────────────────────────────────────────────────────────────┤
│  ○ The Movie Title (2024) - Movie                          │
│  ○ Movie Title (Remake) (2024) - Movie                     │
│  ○ Different Movie (2024) - Movie                          │
├─────────────────────────────────────────────────────────────┤
│                                  [Skip]  [Select]           │
└─────────────────────────────────────────────────────────────┘
```

- Select the correct match and click **"Select"**
- Click **"Skip"** to leave the file unchanged

### 5. Review Changes

The preview table shows:
- **Original** - Current filename
- **New Name** - Proposed new filename
- **Status** - Ready, Completed, Failed, or Skipped

Review the proposed names before proceeding.

### 6. Rename Files

Click **"Rename Files"** to apply the changes.

A confirmation dialog will appear. Click "Yes" to proceed.

If cover art download is enabled, posters and album covers will be saved after renaming.

## Configuration

API keys must be configured via the CLI before using the GUI:

```bash
file-renamer config set-key tmdb YOUR_KEY
```

The GUI will prompt you if no API keys are configured.

## Tips

### Handling Mismatches

If a file is matched incorrectly:
1. Use the interactive selection dialog to pick the correct match
2. Or, cancel and manually rename the file to include the correct title/year
3. Re-run the fetch

### Large Collections

For very large collections (1000+ files):
- Process in batches
- The cache will speed up subsequent runs
- Consider using the CLI with `--recursive` for bulk operations

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + O` | Browse for folder |
| `Cmd/Ctrl + R` | Fetch metadata |
| `Cmd/Ctrl + Enter` | Rename files |
| `Cmd/Ctrl + Q` | Quit |

## Troubleshooting

### "PySide6 not installed"

```bash
pip install PySide6
```

### "No API keys configured"

Configure via CLI:
```bash
file-renamer config set-key tmdb YOUR_KEY
```

### GUI is unresponsive during fetch

This is normal for large collections. The progress dialog shows current status. Wait for it to complete or click "Cancel".

### Files not appearing

Check that your files have supported extensions:

**Video:** `.mkv`, `.mp4`, `.avi`, `.mov`, `.m4v`, `.webm`, `.flv`, `.mpg`, `.mpeg`, `.ts`, `.m2ts`

**Audio:** `.mp3`, `.flac`, `.m4a`, `.ogg`, `.opus`, `.wav`, `.aiff`, `.wma`

When dragging and dropping, only media files with these extensions will be added to the list.
