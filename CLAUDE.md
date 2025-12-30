# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TidyTitles (file-renamer) is a cross-platform media file renaming application. It fetches metadata from TMDB (movies), TVDB (TV shows), and MusicBrainz (music) to rename files with consistent naming patterns. Provides both CLI (`file-renamer`) and GUI (`file-renamer-gui`) interfaces.

## Development Commands

```bash
# Install for development
pip install -e ".[dev,gui]"    # Full development with GUI
pip install -e ".[dev]"        # CLI only development

# Run tests
pytest                         # All tests
pytest tests/test_parser.py    # Single test file
pytest -k "test_name"          # Single test by name
pytest --cov=src/file_renamer  # With coverage

# Lint and type check
ruff check src/
mypy src/

# Build executable
pip install -e ".[build,gui]"
python build.py                # Executable only
python build.py --installer    # With platform installer
python build.py --clean        # Clean previous artifacts first
```

## Architecture

### Data Flow
```
CLI/GUI → RenameService → Parser → Providers (async) → TemplateEngine → FileRenamer
```

### Key Layers

**Core (`src/file_renamer/core/`)**: Business logic
- `parser.py` - GuessIt-based filename parsing with regex fallback
- `music_parser.py` - Mutagen-based tag reading with filename fallback
- `template.py` - Placeholder-based filename generation (`{title} ({year})`)
- `models.py` - Dataclasses: `Movie`, `Episode`, `Track`, `RenameOperation`, etc.
- `renamer.py` - Low-level file operations
- `associated_files.py` - Subtitle/NFO/image handling
- `conflict_resolution.py` - Auto-versioning for duplicates

**Providers (`src/file_renamer/providers/`)**: API clients implementing protocols
- `base.py` - Protocol definitions: `MovieProvider`, `TVProvider`, `MusicProvider`
- `tmdb.py`, `tvdb.py`, `musicbrainz.py` - Provider implementations
- All provider methods are async (httpx-based)

**Services (`src/file_renamer/services/`)**: Orchestration
- `rename_service.py` - Main workflow orchestrator
- `config_service.py` - Pydantic-based configuration (TOML storage)

**Interfaces**:
- `cli/main.py` - Click-based CLI commands
- `gui/app.py` - PySide6 Qt application (1200+ lines)

### Provider Pattern

Providers implement protocols from `providers/base.py`. The `RenameService` accepts any implementation, enabling testing with mocks (respx for HTTP) and potential future providers.

### Async Pattern

All provider API calls are async. CLI/GUI must manage event loops appropriately. Use `async with` for proper context management with httpx clients.

## Testing

- Uses pytest with `asyncio_mode = "auto"` (no explicit async markers needed)
- HTTP mocking with respx
- Fixtures in `tests/conftest.py` provide sample Movie/Episode/Track objects

## Configuration

- Stored in user config directory (platformdirs): `~/.config/file-renamer/` (macOS/Linux) or `%APPDATA%\file-renamer\` (Windows)
- Pydantic models validate all settings
- API keys stored in config file (TMDB/TVDB required for movies/TV; MusicBrainz is free)

## Template Placeholders

Movie: `{title}`, `{year}`, `{quality}`
TV: `{title}`, `{season2}`, `{episode2}`, `{episode_title}`
Music: `{artist}`, `{album}`, `{track2}`, `{disc2}`, `{title}`, `{year}`

Formatters: `{field|lower}`, `{field|upper}`, `{field|title}`, `{field|pad:3}`

## Build System

- PyInstaller configuration in `file-renamer.spec`
- `build.py` automates cross-platform builds
- Installer support: NSIS (Windows), DMG (macOS), AppImage (Linux)
- Hidden imports for guessit/babelfish data files already configured
