# Configuration

File Renamer stores its configuration in a TOML file and supports environment variable overrides.

## Configuration File Location

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/file-renamer/config.toml` |
| Windows | `%LOCALAPPDATA%\file-renamer\config.toml` |
| Linux | `~/.config/file-renamer/config.toml` |

## Cache Location

API responses are cached to reduce API calls:

| Platform | Path |
|----------|------|
| macOS | `~/Library/Caches/file-renamer/` |
| Windows | `%LOCALAPPDATA%\file-renamer\cache\` |
| Linux | `~/.cache/file-renamer/` |

## Configuration File Format

```toml
# File Renamer Configuration

[templates]
movie = "{title} ({year})"
tv = "{title} - S{season2}E{episode2} - {episode_title}"

[api]
tmdb_api_key = "your_tmdb_key_here"
tvdb_api_key = "your_tvdb_key_here"
tvdb_pin = ""

[behavior]
dry_run = false
overwrite = false
preview_before_rename = true

[providers]
movie = "tmdb"
tv = "tvdb"
```

## Configuration Options

### Templates

| Key | Description | Default |
|-----|-------------|---------|
| `movie` | Template for movie filenames | `{title} ({year})` |
| `tv` | Template for TV episode filenames | `{title} - S{season2}E{episode2} - {episode_title}` |

See [Templates](Templates.md) for placeholder documentation.

### API Keys

| Key | Description |
|-----|-------------|
| `tmdb_api_key` | TMDB API key (v3 or Read Access Token) |
| `tvdb_api_key` | TVDB API key |
| `tvdb_pin` | TVDB subscriber PIN (optional) |

See [API Keys](API-Keys.md) for how to obtain these.

### Behavior

| Key | Description | Default |
|-----|-------------|---------|
| `dry_run` | If true, never actually rename files | `false` |
| `overwrite` | If true, overwrite existing files | `false` |
| `preview_before_rename` | Show preview before renaming | `true` |

### Providers

| Key | Description | Default |
|-----|-------------|---------|
| `movie` | Provider for movies | `tmdb` |
| `tv` | Provider for TV shows | `tvdb` |

## Managing Configuration

### View Current Configuration

```bash
file-renamer config show
```

### Initialize Configuration

Creates a config file with defaults:

```bash
file-renamer config init
```

### Set API Keys

```bash
file-renamer config set-key tmdb YOUR_KEY
file-renamer config set-key tvdb YOUR_KEY
```

### Set Templates

```bash
file-renamer config set-template movie "{title} ({year}) [{quality}]"
file-renamer config set-template tv "{title} S{season2}E{episode2}"
```

## Environment Variables

Environment variables override config file settings:

| Variable | Config Key |
|----------|------------|
| `FILE_RENAMER_API__TMDB_API_KEY` | `api.tmdb_api_key` |
| `FILE_RENAMER_API__TVDB_API_KEY` | `api.tvdb_api_key` |
| `FILE_RENAMER_API__TVDB_PIN` | `api.tvdb_pin` |

### Using Environment Variables

```bash
# Set for current session
export FILE_RENAMER_API__TMDB_API_KEY=your_key_here

# Or inline with command
FILE_RENAMER_API__TMDB_API_KEY=your_key file-renamer rename /path
```

### Priority Order

1. Environment variables (highest)
2. Config file
3. Default values (lowest)

## Clearing Cache

The cache stores API responses to speed up repeated operations. To clear it:

```bash
# macOS/Linux
rm -rf ~/Library/Caches/file-renamer/  # macOS
rm -rf ~/.cache/file-renamer/          # Linux

# Windows (PowerShell)
Remove-Item -Recurse $env:LOCALAPPDATA\file-renamer\cache
```

Cache entries expire automatically after 24 hours.

## Backup and Restore

### Backup

```bash
# macOS
cp ~/Library/Application\ Support/file-renamer/config.toml ~/config-backup.toml

# Linux
cp ~/.config/file-renamer/config.toml ~/config-backup.toml
```

### Restore

```bash
# macOS
cp ~/config-backup.toml ~/Library/Application\ Support/file-renamer/config.toml

# Linux
cp ~/config-backup.toml ~/.config/file-renamer/config.toml
```

## Resetting Configuration

To reset to defaults:

```bash
# Remove existing config
rm ~/Library/Application\ Support/file-renamer/config.toml  # macOS
rm ~/.config/file-renamer/config.toml                       # Linux

# Reinitialize
file-renamer config init
```
