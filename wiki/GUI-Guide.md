# GUI Guide

File Renamer includes a graphical user interface for users who prefer visual file management.

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
│  File Renamer                                               │
├─────────────────────────────────────────────────────────────┤
│  [/path/to/folder                          ] [Browse...]    │
├─────────────────────────────────────────────────────────────┤
│  Type: [Auto-detect ▼]              [Fetch Metadata]        │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┬─────────────────────┬────────┐         │
│  │ Original        │ New Name            │ Status │         │
│  ├─────────────────┼─────────────────────┼────────┤         │
│  │ Movie.2024.mkv  │ Movie (2024).mkv    │ Ready  │         │
│  │ Show.S01E01.mkv │ Show - S01E01.mkv   │ Ready  │         │
│  └─────────────────┴─────────────────────┴────────┘         │
├─────────────────────────────────────────────────────────────┤
│  Ready                                    [Rename Files]    │
└─────────────────────────────────────────────────────────────┘
```

## Step-by-Step Usage

### 1. Select Files

**Option A: Browse**
- Click the "Browse..." button
- Navigate to your media folder
- Click "Open" or "Select"

**Option B: Drag and Drop**
- Drag a folder from Finder/Explorer
- Drop it onto the application window

### 2. Choose Media Type

Use the dropdown to select:
- **Auto-detect** - Let File Renamer determine if files are movies or TV shows
- **Movies** - Force all files to be treated as movies
- **TV Shows** - Force all files to be treated as TV episodes

### 3. Fetch Metadata

Click **"Fetch Metadata"** to:
- Connect to TMDB/TVDB
- Look up each file
- Populate the preview table with new names

A progress dialog will show the status.

### 4. Review Changes

The preview table shows:
- **Original** - Current filename
- **New Name** - Proposed new filename
- **Status** - Ready, Completed, Failed, or Skipped

Review the proposed names before proceeding.

### 5. Rename Files

Click **"Rename Files"** to apply the changes.

A confirmation dialog will appear. Click "Yes" to proceed.

## Configuration

API keys must be configured via the CLI before using the GUI:

```bash
file-renamer config set-key tmdb YOUR_KEY
```

The GUI will prompt you if no API keys are configured.

## Tips

### Handling Mismatches

If a file is matched incorrectly:
1. Note the original filename
2. Cancel the rename
3. Manually rename the file to include the correct title/year
4. Re-run the fetch

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
`.mkv`, `.mp4`, `.avi`, `.mov`, `.m4v`
