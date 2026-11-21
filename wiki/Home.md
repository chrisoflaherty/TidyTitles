# TidyTitles Documentation

TidyTitles renames movie, TV, and music files to clean, consistent names using metadata from TMDB, TVDB, and MusicBrainz. It comes as a desktop app for macOS, Windows, and Linux and as a command-line tool, `tidytitles`. Both share the same settings and rename history.

## Start here

- [Installation](Installation.md): download the app, get past the unsigned-app warnings, install the command-line tool, or build from source
- [Getting Started](Getting-Started.md): your first rename, in the app and on the command line, plus notes for users of the old Python version

## Guides

- [GUI Guide](GUI-Guide.md): every control, status, dialog, and shortcut in the desktop app
- [CLI Reference](CLI-Reference.md): every command, option, exit code, and environment variable
- [Templates](Templates.md): placeholders, formatters, folders, and how names are cleaned
- [Configuration](Configuration.md): `config.toml`, file locations, conflict handling, associated files, cover art, history, and cache
- [API Keys](API-Keys.md): getting and entering TMDB and TVDB keys

## Help

- [Troubleshooting](Troubleshooting.md): common problems and fixes
- [Issue tracker](https://github.com/chrisoflaherty/TidyTitles/issues)

## For developers

- [BUILD.md](../BUILD.md): repository layout, building, testing, packaging, and releasing

## At a glance

| | |
|---|---|
| Metadata | TMDB (movies and TV), TVDB (TV), MusicBrainz (music; no key needed) |
| Video files | `.mkv`, `.mp4`, `.avi`, `.mov`, `.wmv`, `.flv`, `.webm`, `.m4v`, `.mpg`, `.mpeg`, `.ts`, `.m2ts` |
| Audio files | `.mp3`, `.flac`, `.m4a`, `.ogg`, `.opus`, `.wav`, `.aiff`, `.wma`, `.aac`, `.ape` |
| Associated files | Subtitles (`.srt`, `.vtt`, `.ass`, `.ssa`, `.sub`, `.idx`), `.nfo`, images (`.jpg`, `.jpeg`, `.png`, `.tbn`) |
| Conflict handling | Skip, replace, or add a number |
| Undo | Any of the last 200 renames (configurable), from the app or the CLI |
| Output folders | A folder per media type; move, copy, or hard link files there |
| Settings | `config.toml` in `~/Library/Application Support/file-renamer/` (macOS), `%LOCALAPPDATA%\file-renamer\file-renamer\` (Windows), `~/.config/file-renamer/` (Linux) |
