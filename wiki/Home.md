# File Renamer Wiki

Welcome to the File Renamer documentation!

File Renamer is a cross-platform media file renaming application that automatically fetches metadata from TMDB and TVDB to rename your movie and TV show files with clean, consistent naming.

## Quick Navigation

### Getting Started
- [Installation](Installation.md) - How to install File Renamer
- [Getting Started](Getting-Started.md) - First steps and basic usage

### User Guides
- [CLI Reference](CLI-Reference.md) - Complete command-line documentation
- [GUI Guide](GUI-Guide.md) - Using the graphical interface
- [Templates](Templates.md) - Customizing file naming patterns
- [Configuration](Configuration.md) - Settings and options

### Help
- [Troubleshooting](Troubleshooting.md) - Common issues and solutions
- [API Keys](API-Keys.md) - How to obtain and configure API keys

## Features Overview

| Feature | Description |
|---------|-------------|
| Smart Detection | Automatically identifies movies vs TV episodes |
| TMDB Integration | Fetches movie metadata (titles, years, etc.) |
| TVDB Integration | Fetches TV show and episode metadata |
| Preview Mode | See changes before applying them |
| Custom Templates | Define your own naming patterns |
| CLI + GUI | Command-line and graphical interfaces |
| Cross-Platform | Works on macOS, Windows, and Linux |
| Caching | Reduces API calls for faster operation |

## Supported File Types

File Renamer supports common video formats:
- `.mkv` (Matroska)
- `.mp4` (MPEG-4)
- `.avi` (Audio Video Interleave)
- `.mov` (QuickTime)
- `.m4v` (iTunes Video)
- `.wmv` (Windows Media Video)
- `.flv` (Flash Video)
- `.webm` (WebM)

## Architecture

```
file-renamer/
├── src/file_renamer/
│   ├── core/           # Core logic (parsing, templates, renaming)
│   ├── providers/      # API clients (TMDB, TVDB)
│   ├── services/       # Business logic orchestration
│   ├── cli/            # Command-line interface
│   └── gui/            # Graphical interface (PySide6)
└── tests/              # Test suite
```

## Contributing

Contributions are welcome! Please see the development section in the main README for setup instructions.
