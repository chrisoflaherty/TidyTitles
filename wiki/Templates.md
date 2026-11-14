# Templates

A template describes how a renamed file is named. TidyTitles has one template for movies, one for TV episodes, and one for music. Each is ordinary text with placeholders in curly braces that are filled in from the file's metadata:

```
{title} ({year})          →  The Matrix (1999).mkv
```

The file's extension is added automatically.

- [Default templates](#default-templates)
- [Setting a template](#setting-a-template)
- [Placeholders](#placeholders)
- [Formatters](#formatters)
- [Folders](#folders)
- [How names are cleaned](#how-names-are-cleaned)
- [Missing values](#missing-values)
- [Validation](#validation)
- [Examples](#examples)

## Default templates

| Type | Template | Example |
|------|----------|---------|
| Movies | `{title} ({year})` | `The Matrix (1999).mkv` |
| TV | `{title} - S{season2}E{episode2} - {episode_title}` | `Breaking Bad - S01E01 - Pilot.mkv` |
| Music | `{artist}/{album} ({year})/{track2} - {title}` | `Pink Floyd/The Wall (1979)/06 - Comfortably Numb.flac` |

## Setting a template

**Desktop app:** **Settings** → **Templates**. Each field shows a live preview with sample metadata, and errors appear as you type. Click **Save**.

**Command line:**

```bash
tidytitles config set-template movie "{title} ({year}) [{quality}]"
tidytitles config set-template tv "{title} S{season2}E{episode2}"
tidytitles config set-template music "{artist}/{album}/{track2} - {title}"
```

**By hand:** the `[templates]` section of `config.toml` (see [Configuration](Configuration.md#templates)).

All three write the same file, so a template set in one place is used everywhere.

## Placeholders

Any placeholder can be used in any template. One that has no value for the file renders as nothing (see [Missing values](#missing-values)).

### Movies and TV

| Placeholder | Movies | TV episodes | Example |
|-------------|--------|-------------|---------|
| `{title}` | Movie title | Show title | `The Matrix`, `Breaking Bad` |
| `{original_title}` | Original-language title | Show's original title | `The Matrix` |
| `{year}` | Release year | Year the show started | `1999`, `2008` |
| `{season}` | | Season number | `1` |
| `{season2}` | | Season number, at least 2 digits | `01` |
| `{episode}` | | Episode number | `1` |
| `{episode2}` | | Episode number, at least 2 digits | `01` |
| `{episode_title}` | | Episode title | `Pilot` |

### Release details from the original filename

These come from the original filename, not from TMDB or TVDB, so they are often empty.

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{quality}` | Resolution | `1080p`, `720p`, `2160p` |
| `{source}` | Source | `Blu-ray`, `Web`, `HDTV` |
| `{codec}` | Video codec | `H.264`, `H.265` |
| `{group}` | Release group | `KyoGo` |

For `The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv` these are `1080p`, `Blu-ray`, `H.264`, and `GROUP`. Note the normalized spellings.

### Music

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{title}` | Track title | `Comfortably Numb` |
| `{artist}` | Track artist | `Pink Floyd` |
| `{album}` | Album title | `The Wall` |
| `{album_artist}` | Album artist (useful for compilations); the track artist when unknown | `Pink Floyd` |
| `{year}` | Album year | `1979` |
| `{track}` | Track number | `6` |
| `{track2}` | Track number, at least 2 digits (`00` when unknown) | `06` |
| `{disc}` | Disc number | `2` |
| `{disc2}` | Disc number, at least 2 digits (`01` when unknown) | `02` |
| `{genre}` | First genre | `Progressive Rock` |

### Any type

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{ext}` | File extension, without the dot | `mkv` |

The extension is appended only when the name does not already end with it, so `{title}.{ext}` and `{title}` give the same result.

## Formatters

A formatter changes a value. Write it after the placeholder name with a pipe:

```
{title|upper}
{episode|pad:3}
```

| Formatter | Effect | Example (title "The Matrix") |
|-----------|--------|------------------------------|
| `lower` | Lowercase | `{title\|lower}` → `the matrix` |
| `upper` | Uppercase | `{title\|upper}` → `THE MATRIX` |
| `title` | Capitalize the first letter of each word, lowercase the rest | `{title\|title}` → `The Matrix` |
| `clean` | Remove characters that are invalid in filenames | `{title\|clean}` |
| `pad:N` | Zero-pad to at least N digits | `{episode\|pad:3}` → `001` |
| `replace:old:new` | Replace every `old` with `new` | `{title\|replace: :.}` → `The.Matrix` |

Notes:

- Only one formatter per placeholder. `{title|lower|upper}` is not recognized as a placeholder at all: it passes validation and ends up in the name as literal text (`{titlelowerupper}.mkv`, after the `|` characters are cleaned out).
- `title` follows Python's rules: any letter after a non-letter starts a new word, so `they're 1st` becomes `They'Re 1St`.
- `pad` needs a number. `{episode|pad:x}` passes validation but fails when the file is renamed; that file is skipped with a template error.
- `replace` splits its argument on `:`, so neither `old` nor `new` can contain a colon. An empty `new` deletes: `{title|replace: :}` → `TheMatrix`.
- `clean` is rarely needed, because the whole name is cleaned anyway (next sections).

## Folders

A `/` written in a template starts a new folder:

```
{title} ({year})/{title} ({year})   →  The Matrix (1999)/The Matrix (1999).mkv
```

Folders are created next to the original file (or under `--output` on the command line) when the file is renamed. Use `/` on every system, including Windows.

A `/` that comes from **metadata** does not create a folder. It is removed from the value before it is inserted, so only the slashes you write in the template create folders:

| Metadata | Template | Result |
|----------|----------|--------|
| artist `AC/DC` | `{artist}/{album} ({year})/{track2} - {title}` | `ACDC/Back in Black (1980)/01 - Hells Bells.flac` |
| title `Face/Off` | `{title} ({year})` | `FaceOff (1997).mkv` |

Associated files (subtitles and so on) move into the same folder as their video.

## How names are cleaned

After the placeholders are filled in, each part of the path (each piece between slashes) is cleaned:

- **Invalid characters are removed:** `<` `>` `:` `"` `\` `|` `?` `*` and control characters. For example `Mission: Impossible` becomes `Mission Impossible`. Backslashes are always removed, never treated as folder separators, so the result is the same on every system.
- **Empty parts are dropped**, so a leading, trailing, or doubled `/` does not create empty folder names.
- **`.` and `..` parts are dropped** (any part made only of dots and spaces), so neither a template nor a tag can point outside the folder: `../{artist}/./{title}` gives `ACDC/Hells Bells.mp3`.

Other characters, including spaces, accents, and non-Latin scripts, are kept as they are.

## Missing values

A placeholder without a value becomes empty text, and the surrounding text stays. Design templates with that in mind:

```
{title} ({year}) [{quality}]
  with quality:     Mission Impossible (1996) [1080p].mkv
  without quality:  Mission Impossible (1996) [].mkv
```

The same applies to music without a year in its tags: `{album} ({year})` becomes `Back in Black ()`.

## Validation

Templates are checked when you save them (in the app or with `config set-template`). These errors prevent saving:

| Error | Cause |
|-------|-------|
| `Unknown field: {foo}` | A placeholder name that is not in the lists above. Names are case-sensitive and use underscores: `{episode_title}`, not `{EpisodeTitle}`. |
| `Unknown formatter: bar` | A formatter that is not in the list above. |
| `Mismatched braces in template` | The number of `{` and `}` differs. |
| `The template is empty` | Desktop app only. |

## Examples

### Movies

```bash
# Default
"{title} ({year})"
# → The Matrix (1999).mkv

# With resolution
"{title} ({year}) [{quality}]"
# → The Matrix (1999) [1080p].mkv

# One folder per movie (Plex, Jellyfin, Kodi)
"{title} ({year})/{title} ({year})"
# → The Matrix (1999)/The Matrix (1999).mkv

# Dots instead of spaces
"{title|replace: :.}.{year}"
# → The.Matrix.1999.mkv
```

### TV

```bash
# Default
"{title} - S{season2}E{episode2} - {episode_title}"
# → Breaking Bad - S01E01 - Pilot.mkv

# Compact
"{title} S{season2}E{episode2}"
# → Breaking Bad S01E01.mkv

# Show and season folders (Plex style)
"{title}/Season {season2}/{title} - S{season2}E{episode2} - {episode_title}"
# → Breaking Bad/Season 01/Breaking Bad - S01E01 - Pilot.mkv

# Unpadded season folder
"{title}/Season {season}/{title} S{season2}E{episode2}"
# → Breaking Bad/Season 1/Breaking Bad S01E01.mkv

# 1x001 style
"{title} {season}x{episode|pad:3}"
# → Breaking Bad 1x001.mkv
```

### Music

```bash
# Default
"{artist}/{album} ({year})/{track2} - {title}"
# → Pink Floyd/The Wall (1979)/06 - Comfortably Numb.flac

# Disc folders
"{artist}/{album}/Disc {disc2}/{track2} - {title}"
# → Pink Floyd/The Wall/Disc 02/06 - Comfortably Numb.flac

# Compilations under the album artist
"{album_artist}/{album} ({year})/{track2} - {artist} - {title}"

# No folders
"{artist} - {album} - {track2} - {title}"
# → Pink Floyd - The Wall - 06 - Comfortably Numb.flac

# Artist folder only
"{artist}/{track2} - {title}"
# → Pink Floyd/06 - Comfortably Numb.flac
```

Template placeholders come from [the template engine](../packages/core/src/template.ts); the desktop app's **Settings** → **Templates** → **Placeholders and formatters** shows the same list.
