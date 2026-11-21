# Templates

A template describes how a renamed file is named. TidyTitles has one template for movies, one for TV episodes, and one for music. Each is ordinary text with placeholders in curly braces that are filled in from the file's metadata:

```
{title} ({year})          →  The Matrix (1999).mkv
```

The file's extension is added automatically.

- [Default templates](#default-templates)
- [Naming presets](#naming-presets)
- [Setting a template](#setting-a-template)
- [Placeholders](#placeholders)
- [Formatters](#formatters)
- [Folders](#folders)
- [How names are cleaned](#how-names-are-cleaned)
- [Missing values and optional parts](#missing-values-and-optional-parts)
- [Validation](#validation)
- [Examples](#examples)

## Default templates

| Type | Template | Example |
|------|----------|---------|
| Movies | `{title} ({year})` | `The Matrix (1999).mkv` |
| TV | `{title} - S{season2}E{episode2} - {episode_title}` | `Breaking Bad - S01E01 - Pilot.mkv` |
| Music | `{artist}/{album} ({year})/{track2} - {title}` | `Pink Floyd/The Wall (1979)/06 - Comfortably Numb.flac` |

## Naming presets

A preset fills in all three templates with the naming a media server expects, including its folders. Folders are created under the destination folder (next to the original file, or under the output folder you choose), so a preset never assumes where your library starts.

**Desktop app:** **Settings** → **Templates** → **Naming preset**. **Command line:** `tidytitles config preset plex` (list them with `tidytitles config presets`).

A preset is only a quick way to fill in the templates. You can edit any of them afterward, and nothing else is stored: the app shows the preset whose three templates equal yours, or **Custom**.

| Preset | Movies | TV | Music |
|--------|--------|----|-------|
| `default` (TidyTitles) | `{title} ({year})` | `{title} - S{season2}E{episode2} - {episode_title}` | `{artist}/{album} ({year})/{track2} - {title}` |
| `plex` | `{title} ({year})< {tmdb-{tmdb_id}}>< {edition-{edition}}>/{title} ({year})< {edition-{edition}}>` | `{title} ({year})< {tvdb-{tvdb_id}}>< {tmdb-{tmdb_id}}>/Season {season2}/{title} ({year}) - s{season2}e{episode2}< - {episode_title}>` | `{album_artist}/{album}/{disc_multi}{track2} - {title}` |
| `jellyfin` | `{title} ({year})< [tmdbid-{tmdb_id}]>/{title} ({year})< [tmdbid-{tmdb_id}]>< - {edition}>` | `{title} ({year})< [tvdbid-{tvdb_id}]>< [tmdbid-{tmdb_id}]>/Season {season2}/{title} S{season2}E{episode2}< - {episode_title}>` | `{album_artist}/{album}/<{disc_multi}->{track2} - {title}` |
| `kodi` | `{title} ({year})/{title} ({year})` | `{title} ({year})/Season {season2}/{title} S{season2}E{episode2}< - {episode_title}>` | `{album_artist}/{album}/<Disc {disc_multi}/>{track2} - {title}` |

Results for Blade Runner (1982, Director's Cut in the file name), Breaking Bad S01E01 "Pilot" (matched on TVDB), and Pink Floyd's two-disc The Wall:

| Preset | Movie | Episode | Track |
|--------|-------|---------|-------|
| `default` | `Blade Runner (1982).mkv` | `Breaking Bad - S01E01 - Pilot.mkv` | `Pink Floyd/The Wall (1979)/06 - Comfortably Numb.flac` |
| `plex` | `Blade Runner (1982) {tmdb-78} {edition-Director's Cut}/Blade Runner (1982) {edition-Director's Cut}.mkv` | `Breaking Bad (2008) {tvdb-81189}/Season 01/Breaking Bad (2008) - s01e01 - Pilot.mkv` | `Pink Floyd/The Wall/206 - Comfortably Numb.flac` |
| `jellyfin` | `Blade Runner (1982) [tmdbid-78]/Blade Runner (1982) [tmdbid-78] - Director's Cut.mkv` | `Breaking Bad (2008) [tvdbid-81189]/Season 01/Breaking Bad S01E01 - Pilot.mkv` | `Pink Floyd/The Wall/2-06 - Comfortably Numb.flac` |
| `kodi` | `Blade Runner (1982)/Blade Runner (1982).mkv` | `Breaking Bad (2008)/Season 01/Breaking Bad S01E01 - Pilot.mkv` | `Pink Floyd/The Wall/Disc 2/06 - Comfortably Numb.flac` |

Without an edition, ID, or episode title, those parts disappear (see [optional parts](#missing-values-and-optional-parts)). A single-disc album gets no disc number. Each preset follows its project's naming guide:

- **Plex:** [movies](https://support.plex.tv/articles/naming-and-organizing-your-movie-media-files/), [editions](https://support.plex.tv/articles/multiple-editions/), [TV shows](https://support.plex.tv/articles/naming-and-organizing-your-tv-show-files/), [music](https://support.plex.tv/articles/200265296-adding-music-media-from-folders/). Editions need Plex Pass and work for movies only. Compilations belong under "Various Artists", which is what `{album_artist}` gives when the album is tagged that way.
- **Jellyfin:** [movies](https://jellyfin.org/docs/general/server/media/movies/), [shows](https://jellyfin.org/docs/general/server/media/shows/), [music](https://jellyfin.org/docs/general/server/media/music/). An edition becomes a version label after the movie's folder name. Jellyfin reads music by its tags; the file names only need to be unique.
- **Kodi:** [movies](https://kodi.wiki/view/Naming_video_files/Movies), [TV shows](https://kodi.wiki/view/Naming_video_files/TV_shows), [music](https://kodi.wiki/view/Music_tagging). Kodi reads music by its tags; the recommended folders are artist, album, and one folder per disc.

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

Any placeholder can be used in any template. One that has no value for the file renders as nothing (see [Missing values and optional parts](#missing-values-and-optional-parts)).

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
| `{air_date}` | | Date the episode first aired | `2008-01-20` |
| `{air_year}` | | Year the episode first aired | `2008` |
| `{tmdb_id}` | TMDB ID | TMDB ID of the show (shows matched on TMDB) | `603`, `1396` |
| `{tvdb_id}` | | TVDB ID of the show (shows matched on TVDB) | `81189` |

### Release details from the original filename

These come from the original filename, not from TMDB or TVDB, so they are often empty.

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{quality}` | Resolution | `1080p`, `720p`, `2160p` |
| `{source}` | Source | `Blu-ray`, `Web`, `HDTV` |
| `{codec}` | Video codec | `H.264`, `H.265` |
| `{group}` | Release group | `KyoGo` |
| `{edition}` | Edition | `Director's Cut`, `Extended`, `Theatrical`, `Unrated`, `Uncut`, `Remastered`, `Restored`, `Criterion`, `Special`, `Collector`, `Limited`, `IMAX` |
| `{audio_codec}` | Audio codec | `Dolby Digital Plus`, `Dolby TrueHD`, `Dolby Atmos`, `DTS`, `DTS-HD`, `AAC`, `FLAC` |
| `{audio_channels}` | Audio channels | `2.0`, `5.1`, `7.1` |
| `{hdr}` | HDR format | `HDR10`, `Dolby Vision` |

For `The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv` these are `1080p`, `Blu-ray`, `H.264`, and `GROUP`. For `Tenet.2020.2160p.UHD.BluRay.TrueHD.7.1.Atmos.DV.HDR.x265-GRP.mkv`, `{audio_codec}` is `Dolby TrueHD, Dolby Atmos`, `{audio_channels}` is `7.1`, and `{hdr}` is `Dolby Vision, HDR10`: several values are joined with a comma and a space. Note the normalized spellings, the same ones the [guessit](https://github.com/guessit-io/guessit) library uses. Some tags are not recognized: `Final Cut`, `Anniversary Edition`, `DoVi`, `HDR10Plus`, `HLG`; `HDR10+` counts as `HDR10`. A `.mp3`, `.flac`, `.opus`, or `.aac` file reports its format as `{audio_codec}`.

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
| `{genre}` | First genre (from the tags when the match has none) | `Progressive Rock` |
| `{track_total}` | Number of tracks on the album | `26` |
| `{disc_total}` | Number of discs in the album | `2` |
| `{disc_multi}` | Disc number, only when the album has more than one disc | `2` |

The album artist, genre, and the totals come from MusicBrainz where it has them, otherwise from the file's tags ("track 6 of 26", "disc 2 of 2"). `{disc_multi}{track2}` gives Plex's `206` for track 6 of disc 2 and plain `06` for a single-disc album.
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

## Missing values and optional parts

A placeholder without a value becomes empty text, and the surrounding text stays:

```
{title} ({year}) [{quality}]
  with quality:     Mission Impossible (1996) [1080p].mkv
  without quality:  Mission Impossible (1996) [].mkv
```

The same applies to music without a year in its tags: `{album} ({year})` becomes `Back in Black ()`.

To make a part optional, put it between `<` and `>`. The rule:

1. **A section disappears when none of its placeholders has a value**, together with its text. Otherwise only the `<` and `>` are removed.
2. **Inside a section that stays, an empty placeholder leaves no debris:** brackets left empty are removed, and separators (space, `-`, `_`, `.`, `,`) next to the empty value are dropped where they would touch a bracket or the edge of the section. Between two values, only one separator is kept.
3. **Where a section disappears, the spaces around it collapse to one**, and none is left at the start or end of a file or folder name.

```
{title} ({year})< [{quality}]>
  with quality:     Mission Impossible (1996) [1080p].mkv
  without quality:  Mission Impossible (1996).mkv

{title} ({year})< [{quality} {source}]>
  only the source:  Mission Impossible (1996) [Blu-ray].mkv

{title}< - {episode_title}>              no title: Breaking Bad.mkv
{album}< ({year})>                       no year:  Back in Black
<{quality}-{group}>                      no quality: GROUP
{artist}/{album}/<Disc {disc_multi}/>{track2} - {title}    single disc: no Disc folder
```

Put the space or separator that belongs to an optional part inside the section, as above. Sections can be nested: `{title}< [{quality}< {source}>]>`. `<` and `>` can never appear in a file name, so templates written before sections existed give the same names as before. A `<` without a matching `>` (or the reverse) is an error when saving.

Literal braces work inside a section, which is how the Plex preset writes `{edition-Director's Cut}`: `{title} ({year})< {edition-{edition}}>`.

## Validation

Templates are checked when you save them (in the app or with `config set-template`). These errors prevent saving:

| Error | Cause |
|-------|-------|
| `Unknown field: {foo}` | A placeholder name that is not in the lists above. Names are case-sensitive and use underscores: `{episode_title}`, not `{EpisodeTitle}`. |
| `Unknown formatter: bar` | A formatter that is not in the list above. |
| `Mismatched braces in template` | The number of `{` and `}` differs. |
| `Mismatched < > in template` | A `<` without a matching `>`, or the reverse. |
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

# Release details, only when the file name has them
"{title} ({year})< - {edition}>< [{quality} {hdr} {audio_codec} {audio_channels}]>"
# → Tenet (2020) [2160p Dolby Vision, HDR10 Dolby TrueHD, Dolby Atmos 7.1].mkv
# → The Matrix (1999).mkv

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

# With the air date
"{title} - S{season2}E{episode2}< ({air_date})>"
# → Breaking Bad - S01E01 (2008-01-20).mkv
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
