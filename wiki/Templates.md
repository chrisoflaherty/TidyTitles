# Templates

Templates define how your files will be named after renaming. They use placeholders that get replaced with actual metadata.

## Basic Syntax

Templates use curly braces `{}` for placeholders:

```
{title} ({year})
```

This produces: `The Matrix (1999).mkv`

## Available Placeholders

### Movie Placeholders

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{title}` | Movie title | "The Matrix" |
| `{original_title}` | Original language title | "The Matrix" |
| `{year}` | Release year | "1999" |

### TV Show Placeholders

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{title}` | Show title | "Breaking Bad" |
| `{original_title}` | Original title | "Breaking Bad" |
| `{year}` | First air year | "2008" |
| `{season}` | Season number | "1" |
| `{season2}` | Season (2 digits) | "01" |
| `{episode}` | Episode number | "5" |
| `{episode2}` | Episode (2 digits) | "05" |
| `{episode_title}` | Episode title | "Pilot" |

### Music Placeholders

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{title}` | Track title | "Comfortably Numb" |
| `{artist}` | Artist name | "Pink Floyd" |
| `{album}` | Album title | "The Wall" |
| `{album_artist}` | Album artist | "Pink Floyd" |
| `{year}` | Release year | "1979" |
| `{track}` | Track number | "6" |
| `{track2}` | Track (2 digits) | "06" |
| `{disc}` | Disc number | "2" |
| `{disc2}` | Disc (2 digits) | "02" |
| `{genre}` | Genre | "Rock" |

### Quality Placeholders

These are extracted from the original filename:

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{quality}` | Video quality | "1080p", "720p", "4K" |
| `{source}` | Video source | "BluRay", "WEB-DL", "HDTV" |
| `{codec}` | Video codec | "x264", "x265", "HEVC" |
| `{group}` | Release group | "SPARKS", "YTS" |

### File Placeholders

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{ext}` | File extension | "mkv", "mp4" |

## Formatters

Apply transformations using the pipe `|` syntax:

```
{title|formatter}
{title|formatter:argument}
```

### Available Formatters

| Formatter | Description | Example |
|-----------|-------------|---------|
| `lower` | Lowercase | `{title\|lower}` → "the matrix" |
| `upper` | Uppercase | `{title\|upper}` → "THE MATRIX" |
| `title` | Title Case | `{title\|title}` → "The Matrix" |
| `clean` | Remove invalid chars | Removes `< > : " / \ \| ? *` |
| `pad:N` | Zero-pad to N digits | `{episode\|pad:3}` → "005" |
| `replace:a:b` | Replace a with b | `{title\|replace: :_}` → "The_Matrix" |

## Default Templates

### Movies

```
{title} ({year})
```

Example: `The Matrix (1999).mkv`

### TV Shows

```
{title} - S{season2}E{episode2} - {episode_title}
```

Example: `Breaking Bad - S01E01 - Pilot.mkv`

### Music

```
{artist}/{album} ({year})/{track2} - {title}
```

Example: `Pink Floyd/The Wall (1979)/06 - Comfortably Numb.flac`

## Common Template Examples

### Movies

```bash
# Standard (default)
"{title} ({year})"
# → The Matrix (1999).mkv

# With quality
"{title} ({year}) [{quality}]"
# → The Matrix (1999) [1080p].mkv

# With source and quality
"{title} ({year}) [{source}-{quality}]"
# → The Matrix (1999) [BluRay-1080p].mkv

# Folder structure (Plex-style)
"{title} ({year})/{title} ({year})"
# → The Matrix (1999)/The Matrix (1999).mkv
```

### TV Shows

```bash
# Standard (default)
"{title} - S{season2}E{episode2} - {episode_title}"
# → Breaking Bad - S01E01 - Pilot.mkv

# Compact
"{title} S{season2}E{episode2}"
# → Breaking Bad S01E01.mkv

# With show folder
"{title}/S{season2}E{episode2} - {episode_title}"
# → Breaking Bad/S01E01 - Pilot.mkv

# Plex-style folder structure
"{title}/Season {season2}/{title} - S{season2}E{episode2} - {episode_title}"
# → Breaking Bad/Season 01/Breaking Bad - S01E01 - Pilot.mkv

# Jellyfin-style
"{title}/Season {season}/{title} S{season2}E{episode2}"
# → Breaking Bad/Season 1/Breaking Bad S01E01.mkv
```

### Music

```bash
# Standard (default)
"{artist}/{album} ({year})/{track2} - {title}"
# → Pink Floyd/The Wall (1979)/06 - Comfortably Numb.flac

# With disc number
"{artist}/{album}/Disc {disc2}/{track2} - {title}"
# → Pink Floyd/The Wall/Disc 02/06 - Comfortably Numb.flac

# Flat structure (no folders)
"{artist} - {album} - {track2} - {title}"
# → Pink Floyd - The Wall - 06 - Comfortably Numb.flac

# Simple with year
"{track2} - {title} ({year})"
# → 06 - Comfortably Numb (1979).flac

# Artist folder only
"{artist}/{track2} - {title}"
# → Pink Floyd/06 - Comfortably Numb.flac
```

## Setting Templates

Use the CLI to set your preferred templates:

```bash
# Set movie template
file-renamer config set-template movie "{title} ({year}) [{quality}]"

# Set TV template
file-renamer config set-template tv "{title} S{season2}E{episode2}"

# Set music template
file-renamer config set-template music "{artist}/{album} ({year})/{track2} - {title}"
```

## Template Validation

Templates are validated before being saved. Common errors:

| Error | Cause |
|-------|-------|
| "Unknown field: {foo}" | Invalid placeholder name |
| "Unknown formatter: bar" | Invalid formatter name |
| "Mismatched braces" | Missing `{` or `}` |

## Tips

### Folder Structures

Include `/` in your template to create folder structures:

```
{title} ({year})/{title} ({year})
```

The parent directories will be created automatically.

### Handling Missing Data

If a placeholder has no value (e.g., `{quality}` when quality isn't in the filename), it will be replaced with an empty string. Design templates to handle this gracefully:

```bash
# This might produce "Movie (2024) [].mkv" if quality is missing
"{title} ({year}) [{quality}]"

# Consider using quality only when you know it's available
"{title} ({year})"
```

### Invalid Filename Characters

The `{title|clean}` formatter removes characters that are invalid in filenames. This is applied automatically to the final result, but you can use it explicitly:

```
{title|clean} ({year})
```
