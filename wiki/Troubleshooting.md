# Troubleshooting

Common issues and their solutions.

## Installation Issues

### "Command not found: file-renamer"

The CLI isn't in your PATH. Try:

```bash
# Run with Python module syntax
python3 -m file_renamer.cli.main --help

# Or ensure pip scripts are in PATH
export PATH="$PATH:$(python3 -m site --user-base)/bin"
```

### "No module named 'file_renamer'"

The package isn't installed correctly:

```bash
# Reinstall
cd /path/to/file-renamer
pip install -e .
```

### "PySide6 not installed"

Install GUI dependencies:

```bash
pip install PySide6
# or
pip install -e ".[gui]"
```

## API Issues

### "Invalid TMDB API key"

1. Verify your key is correct:
   ```bash
   file-renamer config show
   ```

2. Test the key directly:
   ```bash
   curl "https://api.themoviedb.org/3/movie/550?api_key=YOUR_KEY"
   ```

3. Try using the API Read Access Token instead of the v3 key

4. Re-set the key:
   ```bash
   file-renamer config set-key tmdb YOUR_CORRECT_KEY
   ```

### "Invalid TVDB API key"

1. Verify your TVDB subscription is active
2. Generate a new API key from your TVDB dashboard
3. Check if your key has expired

### "Rate limit exceeded"

The APIs have rate limits. Wait a few minutes and try again. For large collections, the cache helps avoid repeated requests.

### "No matches found"

The API couldn't find your media. Try:

1. Check the parsed title with `file-renamer preview`
2. Rename the file to include the correct title/year
3. Use `--type movie` or `--type tv` to force detection

## File Issues

### "Source file does not exist"

The file was moved or deleted between preview and rename. Re-run the command.

### "Destination already exists"

A file with the new name already exists. Options:

1. Delete or rename the existing file
2. Use a different output directory with `--output`

### "Permission denied"

You don't have write permissions. Try:

```bash
# Check permissions
ls -la /path/to/file

# Run with sudo (not recommended)
sudo file-renamer rename /path/to/file
```

### Files not detected

File Renamer only processes video files with these extensions:
- `.mkv`, `.mp4`, `.avi`, `.mov`, `.m4v`, `.wmv`, `.flv`, `.webm`

If your files have a different extension, rename them first.

## Parsing Issues

### Wrong title detected

The filename parser may misinterpret complex filenames. Solutions:

1. Check parsed results:
   ```bash
   file-renamer preview /path/to/file
   ```

2. Simplify the filename:
   ```
   Before: Movie.Title.REMASTERED.2024.Directors.Cut.1080p.mkv
   After:  Movie Title 2024.mkv
   ```

3. Force the media type:
   ```bash
   file-renamer rename /path --type movie
   ```

### TV show detected as movie (or vice versa)

Force the correct type:

```bash
file-renamer rename /path/to/shows --type tv
file-renamer rename /path/to/movies --type movie
```

### Wrong year detected

The parser may pick up a year from quality info (e.g., "2160p" → 2160). Ensure the actual year is in the filename:

```
Before: Movie.4K.2160p.mkv
After:  Movie.2024.4K.2160p.mkv
```

## Configuration Issues

### "Config file not found"

Initialize the configuration:

```bash
file-renamer config init
```

### Settings not applying

1. Check current config:
   ```bash
   file-renamer config show
   ```

2. Environment variables override config file settings

3. Try removing and re-setting:
   ```bash
   file-renamer config set-template movie "{title} ({year})"
   ```

### Config file corrupted

Reset to defaults:

```bash
# Remove old config
rm ~/Library/Application\ Support/file-renamer/config.toml  # macOS
rm ~/.config/file-renamer/config.toml                       # Linux

# Reinitialize
file-renamer config init
```

## GUI Issues

### GUI won't launch

1. Ensure PySide6 is installed:
   ```bash
   pip install PySide6
   ```

2. Check for errors:
   ```bash
   python3 -m file_renamer.gui.main
   ```

### GUI freezes during fetch

Normal for large collections. The progress dialog shows status. Wait for completion or click "Cancel".

### "No API keys configured" in GUI

Configure via CLI first:

```bash
file-renamer config set-key tmdb YOUR_KEY
```

## Performance Issues

### Slow with many files

1. Use the cache (enabled by default)
2. Process in smaller batches
3. Use CLI instead of GUI for large collections:
   ```bash
   file-renamer rename /path --type movie --yes
   ```

### High memory usage

For very large collections (10,000+ files), process in batches or subdirectories.

## Getting Help

If you're still stuck:

1. Check the full error message
2. Run with verbose output (if available)
3. Search existing issues on GitHub
4. Open a new issue with:
   - Your operating system
   - Python version (`python3 --version`)
   - Full error message
   - Steps to reproduce
