# TidyTitles

A cross-platform media file renaming application inspired by FileBot. Automatically fetches metadata from TMDB, TVDB, and MusicBrainz to rename your movies, TV shows, and music files with clean, consistent naming.

## Features

- **Smart Detection** - Automatically identifies movies, TV episodes, and music from filenames
- **Metadata Lookup** - Fetches accurate titles from TMDB (movies), TVDB (TV), and MusicBrainz (music)
- **Music Support** - Reads ID3/Vorbis/FLAC tags with filename fallback, no API key required
- **Cover Art Download** - Automatically download movie posters and album covers
- **Interactive Selection** - Choose the correct match when multiple results are found (CLI + GUI)
- **Associated Files** - Automatically renames subtitles, NFO files, and images alongside videos
- **Smart Conflict Resolution** - Auto-versioning prevents accidental overwrites
- **Recursive Scanning** - Scan subdirectories for media files
- **Progress Indicators** - Real-time progress bars show scanning, fetching, and renaming status
- **Preview Mode** - See exactly what will be renamed before committing changes
- **Custom Templates** - Define your own naming patterns with powerful placeholders
- **Dual Interface** - Full CLI for automation + GUI for visual file management
- **Cross-Platform** - Works on macOS, Windows, and Linux
- **Caching** - API responses are cached to minimize requests and speed up bulk operations

## Installation

### For End Users (No Python Required)

Download the standalone executable for your platform:

- **Windows**: Download `TidyTitles.exe` - double-click to run
- **macOS**: Download `TidyTitles.app` - drag to Applications folder
- **Linux**: Download `TidyTitles` - make executable and run

No installation needed! Just download and run. The app includes everything it needs.

> **Building from source?** See [BUILD.md](BUILD.md) for instructions on creating your own executable.

### For Developers

```bash
# Clone the repository
git clone https://github.com/yourusername/file-renamer.git
cd file-renamer

# Install (CLI only)
pip install -e .

# Install with GUI support
pip install -e ".[gui]"
```

## Quick Start

### 1. Get API Keys

- **TMDB** (for movies): https://www.themoviedb.org/settings/api
- **TVDB** (for TV shows): https://thetvdb.com/api-information
- **MusicBrainz** (for music): No API key required!

### 2. Configure

```bash
file-renamer config init
file-renamer config set-key tmdb YOUR_TMDB_API_KEY
file-renamer config set-key tvdb YOUR_TVDB_API_KEY  # optional
```

### 3. Rename Files

```bash
# Preview what will happen
file-renamer rename /path/to/media --dry-run

# Rename movies
file-renamer rename /path/to/movies --type movie

# Rename TV shows
file-renamer rename /path/to/shows --type tv

# Rename music files
file-renamer rename /path/to/music --type music

# Auto-detect and rename
file-renamer rename /path/to/media

# Download cover art alongside renaming
file-renamer rename /path/to/media --cover-art

# Scan subdirectories
file-renamer rename /path/to/media --recursive
```

### 4. Or Use the GUI

```bash
file-renamer-gui
```

The GUI supports:
- **Drag and drop** - Drop multiple files or folders directly into the window
- **Multi-file selection** - Add files from different locations
- **Accumulative list** - Files are added to the existing list (use Clear to reset)
- **Media type selection** - Choose Auto-detect, Movies, TV Shows, or Music
- **Recursive scanning** - Check "Recursive" to scan subdirectories
- **Cover art download** - Check "Cover Art" to download posters/album covers
- **Interactive selection** - Pick the correct match when multiple results found

## Example

**Movies:**
```
Before: One.Battle.After.Another.2025.1080p.AMZN.WEB-DL.DDP5.1.H.264-KyoGo.mkv
After:  One Battle After Another (2025).mkv

Before: One.Battle.After.Another.2025.1080p.AMZN.WEB-DL.DDP5.1.H.264-KyoGo.srt
After:  One Battle After Another (2025).srt
```

**TV Shows:**
```
Before: Breaking.Bad.S01E01.720p.BluRay.x264.mkv
After:  Breaking Bad - S01E01 - Pilot.mkv

Before: Breaking.Bad.S01E01.en.srt
After:  Breaking Bad - S01E01 - Pilot.en.srt
```

**Music:**
```
Before: 06 - Comfortably Numb.flac
After:  Pink Floyd/The Wall (1979)/06 - Comfortably Numb.flac
```

**Associated Files:**
TidyTitles automatically renames associated files along with your videos:
- Subtitles (`.srt`, `.vtt`, `.ass`, `.ssa`, `.sub`, `.idx`)
- NFO metadata files (`.nfo`)
- Cover images (`.jpg`, `.png`, `.tbn`)

## CLI Reference

| Command | Description |
|---------|-------------|
| `file-renamer rename PATH` | Rename files in PATH |
| `file-renamer preview PATH` | Preview parsed file info |
| `file-renamer config show` | Show current configuration |
| `file-renamer config set-key PROVIDER KEY` | Set API key |
| `file-renamer config set-template TYPE TEMPLATE` | Set naming template |

### Rename Options

```
-t, --type [movie|tv|music|auto]  Force media type detection
-r, --recursive                   Scan subdirectories
-o, --output PATH                 Move renamed files to this directory
-n, --dry-run                     Preview only, don't rename
-y, --yes                         Skip confirmation prompt
-a, --auto-select                 Automatically select first match (no prompts)
-c, --cover-art                   Download movie posters and album covers
-p, --provider [tmdb|tvdb|musicbrainz|auto]  Metadata provider
```

**Interactive Selection:**

When TidyTitles finds multiple matches for a file, it prompts you to choose:

```
Multiple matches found for: Movie.2024.mkv

┏━━━┳━━━━━━━━━━━━━━━━━━━━━┳━━━━━━┳━━━━━━━┓
┃ # ┃ Title               ┃ Year ┃ Type  ┃
┡━━━╇━━━━━━━━━━━━━━━━━━━━━╇━━━━━━╇━━━━━━━┩
│ 1 │ The Movie Title     │ 2024 │ Movie │
│ 2 │ Movie Title (Remake)│ 2024 │ Movie │
│ 3 │ Different Movie     │ 2024 │ Movie │
└───┴─────────────────────┴──────┴───────┘

Select match (1-3) or 's' to skip:
```

Use `--auto-select` to always pick the first match without prompting.

**Progress Tracking:**

For large batch operations, TidyTitles shows real-time progress:

**CLI:**
```
⠋ Parsing: movie_name.mkv                    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 45/100 0:00:12
⠙ Fetching: The Movie Title                  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 23/100 0:01:05
⠹ Renaming: The Movie (2024).mkv             ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 67/100 0:00:03
```

**GUI:**
- Progress dialog with bar and percentage
- Shows current file being processed
- Displays time remaining estimate

## Templates

Customize how files are named using placeholders:

**Common:**
| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{title}` | Title | "The Matrix" |
| `{year}` | Year | "1999" |
| `{quality}` | Quality | "1080p" |

**TV Shows:**
| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{season2}` | Season (2-digit) | "01" |
| `{episode2}` | Episode (2-digit) | "05" |
| `{episode_title}` | Episode title | "Pilot" |

**Music:**
| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{artist}` | Artist name | "Pink Floyd" |
| `{album}` | Album title | "The Wall" |
| `{track2}` | Track number (2-digit) | "06" |
| `{disc2}` | Disc number (2-digit) | "01" |
| `{genre}` | Genre | "Rock" |

**Default templates:**
- Movies: `{title} ({year})`
- TV: `{title} - S{season2}E{episode2} - {episode_title}`
- Music: `{artist}/{album} ({year})/{track2} - {title}`

**Custom examples:**
```bash
# Movie with quality tag
file-renamer config set-template movie "{title} ({year}) [{quality}]"
# Result: The Matrix (1999) [1080p].mkv

# Music with disc number
file-renamer config set-template music "{artist}/{album}/Disc {disc2}/{track2} - {title}"
# Result: Pink Floyd/The Wall/Disc 02/06 - Comfortably Numb.flac
```

## Documentation

See the [Wiki](wiki/) for detailed documentation:

- [Installation Guide](wiki/Installation.md)
- [Getting Started](wiki/Getting-Started.md)
- [CLI Reference](wiki/CLI-Reference.md)
- [GUI Guide](wiki/GUI-Guide.md)
- [Template Syntax](wiki/Templates.md)
- [Configuration](wiki/Configuration.md)
- [Troubleshooting](wiki/Troubleshooting.md)

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Lint
ruff check src/

# Type check
mypy src/
```

### Building for Distribution

Create standalone executables to share with others:

```bash
# Install build dependencies
pip install -e ".[build,gui]"

# Build executable for your platform
python build.py

# Output will be in dist/
```

See [BUILD.md](BUILD.md) for detailed instructions on building and distributing TidyTitles.

## License

MIT License - see [LICENSE](LICENSE) for details.
