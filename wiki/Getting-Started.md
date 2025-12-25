# Getting Started

This guide will walk you through setting up File Renamer and renaming your first files.

## Step 1: Install File Renamer

See the [Installation Guide](Installation.md) for detailed instructions.

```bash
git clone https://github.com/yourusername/file-renamer.git
cd file-renamer
pip install -e .
```

## Step 2: Get API Keys

File Renamer uses external APIs to fetch accurate metadata:

### TMDB (Required for Movies)

1. Go to https://www.themoviedb.org/signup and create a free account
2. Go to https://www.themoviedb.org/settings/api
3. Click "Create" under "Request an API Key"
4. Choose "Developer" and fill out the form
5. Copy your **API Key (v3 auth)**

### TVDB (Optional, for TV Shows)

1. Go to https://thetvdb.com/api-information
2. Create a free account
3. Subscribe to a plan (free tier available)
4. Generate an API key from your dashboard

## Step 3: Configure API Keys

```bash
# Initialize configuration
file-renamer config init

# Add your TMDB key
file-renamer config set-key tmdb YOUR_TMDB_API_KEY

# (Optional) Add your TVDB key
file-renamer config set-key tvdb YOUR_TVDB_API_KEY
```

Verify your configuration:

```bash
file-renamer config show
```

You should see:

```
API Keys:
  TMDB: configured
  TVDB: configured  (or "not set" if skipped)
```

## Step 4: Preview Your Files

Before renaming, always preview what will happen:

```bash
# See how files are parsed
file-renamer preview /path/to/your/media

# See what they would be renamed to (without actually renaming)
file-renamer rename /path/to/your/media --dry-run
```

Example output:

```
                            Parsed File Information
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━┳━━━━━━━━━━━━━━┳━━━━━━┳━━━━━━━━┳━━━━━━━━━┓
┃ Filename                       ┃ Type  ┃ Title        ┃ Year ┃ Season ┃ Episode ┃
┡━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━╇━━━━━━━━━━━━━━╇━━━━━━╇━━━━━━━━╇━━━━━━━━━┩
│ The.Matrix.1999.1080p.BluRay…  │ movie │ The Matrix   │ 1999 │ -      │ -       │
│ Breaking.Bad.S01E01.720p.mkv   │ tv    │ Breaking Bad │ -    │ 1      │ 1       │
└────────────────────────────────┴───────┴──────────────┴──────┴────────┴─────────┘
```

## Step 5: Rename Files

Once you're happy with the preview, rename for real:

```bash
# Rename with confirmation prompt
file-renamer rename /path/to/your/media

# Skip confirmation
file-renamer rename /path/to/your/media --yes

# Force a specific media type
file-renamer rename /path/to/movies --type movie
file-renamer rename /path/to/shows --type tv
```

## Step 6: Customize Templates (Optional)

Change how files are named:

```bash
# Include quality in movie names
file-renamer config set-template movie "{title} ({year}) [{quality}]"

# Simpler TV naming
file-renamer config set-template tv "{title} S{season2}E{episode2}"
```

See [Templates](Templates.md) for all available placeholders.

## Using the GUI

If you installed with GUI support:

```bash
file-renamer-gui
```

1. Click "Browse" or drag-and-drop a folder
2. Select the media type (Auto/Movies/TV Shows)
3. Click "Fetch Metadata" to look up titles
4. Review the preview table
5. Click "Rename Files" to apply changes

## Next Steps

- [CLI Reference](CLI-Reference.md) - Full command documentation
- [Templates](Templates.md) - Customize naming patterns
- [Configuration](Configuration.md) - All settings options
- [Troubleshooting](Troubleshooting.md) - Common issues
