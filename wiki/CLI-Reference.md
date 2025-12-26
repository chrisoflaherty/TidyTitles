# CLI Reference

Complete documentation for the File Renamer command-line interface.

## Global Options

```bash
file-renamer [OPTIONS] COMMAND [ARGS]
```

| Option | Description |
|--------|-------------|
| `--version` | Show version and exit |
| `--help` | Show help message and exit |

---

## Commands

### `rename`

Rename media files using metadata from TMDB/TVDB.

```bash
file-renamer rename PATH [OPTIONS]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `PATH` | File or directory to process |

**Options:**

| Option | Short | Description |
|--------|-------|-------------|
| `--type` | `-t` | Media type: `movie`, `tv`, or `auto` (default: auto) |
| `--recursive` | `-r` | Scan subdirectories |
| `--output` | `-o` | Move renamed files to this directory |
| `--dry-run` | `-n` | Preview changes without renaming |
| `--yes` | `-y` | Skip confirmation prompt |
| `--auto-select` | `-a` | Automatically select first match when multiple results found |

**Examples:**

```bash
# Rename all media in a directory
file-renamer rename /path/to/media

# Rename only movies
file-renamer rename /path/to/movies --type movie

# Rename TV shows recursively
file-renamer rename /path/to/shows --type tv --recursive

# Preview without making changes
file-renamer rename /path/to/media --dry-run

# Rename and move to organized folder
file-renamer rename /downloads --output /media/movies --type movie

# Non-interactive (for scripts)
file-renamer rename /path/to/media --yes

# Auto-select first match when multiple results found
file-renamer rename /path/to/media --auto-select
```

**Interactive Selection:**

When TidyTitles finds multiple matches for a file, it will prompt you to choose the correct one:

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

Use `--auto-select` to automatically pick the first match without prompting.

---

### `preview`

Preview how files will be parsed without fetching metadata or renaming.

```bash
file-renamer preview PATH [OPTIONS]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `PATH` | File or directory to process |

**Options:**

| Option | Short | Description |
|--------|-------|-------------|
| `--recursive` | `-r` | Scan subdirectories |

**Examples:**

```bash
# Preview a single file
file-renamer preview /path/to/movie.mkv

# Preview a directory
file-renamer preview /path/to/media

# Preview recursively
file-renamer preview /path/to/media --recursive
```

**Output:**

```
                            Parsed File Information
┏━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━┳━━━━━━━━━━━━━━┳━━━━━━┳━━━━━━━━┳━━━━━━━━━┓
┃ Filename               ┃ Type  ┃ Title        ┃ Year ┃ Season ┃ Episode ┃
┡━━━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━╇━━━━━━━━━━━━━━╇━━━━━━╇━━━━━━━━╇━━━━━━━━━┩
│ The.Matrix.1999.mkv    │ movie │ The Matrix   │ 1999 │ -      │ -       │
└────────────────────────┴───────┴──────────────┴──────┴────────┴─────────┘
```

---

### `config`

Manage application configuration.

#### `config show`

Display current configuration.

```bash
file-renamer config show
```

**Output:**

```
Current Configuration

Config file: ~/Library/Application Support/file-renamer/config.toml
Cache dir: ~/Library/Caches/file-renamer

Templates:
  Movie: {title} ({year})
  TV:    {title} - S{season2}E{episode2} - {episode_title}

API Keys:
  TMDB: configured
  TVDB: not set
```

#### `config init`

Create configuration file with default settings.

```bash
file-renamer config init
```

#### `config set-key`

Set an API key for a provider.

```bash
file-renamer config set-key PROVIDER KEY
```

| Argument | Description |
|----------|-------------|
| `PROVIDER` | `tmdb` or `tvdb` |
| `KEY` | Your API key |

**Examples:**

```bash
file-renamer config set-key tmdb abc123def456
file-renamer config set-key tvdb xyz789
```

#### `config set-template`

Set a naming template.

```bash
file-renamer config set-template TYPE TEMPLATE
```

| Argument | Description |
|----------|-------------|
| `TYPE` | `movie` or `tv` |
| `TEMPLATE` | Template string with placeholders |

**Examples:**

```bash
# Movie with quality
file-renamer config set-template movie "{title} ({year}) [{quality}]"

# Simple TV format
file-renamer config set-template tv "{title} S{season2}E{episode2}"

# Plex-style folder structure
file-renamer config set-template tv "{title}/Season {season2}/{title} - S{season2}E{episode2}"
```

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (configuration, API, or rename failure) |

---

## Environment Variables

Configuration can also be set via environment variables:

| Variable | Description |
|----------|-------------|
| `FILE_RENAMER_API__TMDB_API_KEY` | TMDB API key |
| `FILE_RENAMER_API__TVDB_API_KEY` | TVDB API key |

Environment variables take precedence over the config file.
