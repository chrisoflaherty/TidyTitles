# API Keys

File Renamer uses external APIs to fetch accurate metadata for your media files. This guide explains how to obtain and configure API keys.

## Overview

| Provider | Used For | Cost | Required? |
|----------|----------|------|-----------|
| TMDB | Movies | Free | Yes (for movies) |
| TVDB | TV Shows | Free tier available | Optional |

## TMDB (The Movie Database)

TMDB provides movie metadata including titles, release dates, and more.

### Getting a TMDB API Key

1. **Create an account**
   - Go to https://www.themoviedb.org/signup
   - Fill out the registration form
   - Verify your email address

2. **Request an API key**
   - Log in to your account
   - Go to https://www.themoviedb.org/settings/api
   - Click "Create" under "Request an API Key"
   - Select "Developer"
   - Fill out the application form:
     - **Application Name**: File Renamer (or any name)
     - **Application URL**: Can be left blank or use a placeholder
     - **Application Summary**: Personal media file organization tool

3. **Get your key**
   - After approval (usually instant), you'll see your API keys
   - Copy the **"API Key (v3 auth)"** - this is a 32-character string
   - Alternatively, you can use the **"API Read Access Token"** (longer string)

### TMDB Key Types

File Renamer supports both key types:

| Key Type | Length | Header |
|----------|--------|--------|
| API Key (v3) | ~32 chars | Added as URL parameter |
| Read Access Token | ~200 chars | Added as Bearer token |

Both work identically. Use whichever you prefer.

### Configure TMDB

```bash
file-renamer config set-key tmdb YOUR_API_KEY
```

## TVDB (TheTVDB)

TVDB provides TV show and episode metadata.

### Getting a TVDB API Key

1. **Create an account**
   - Go to https://thetvdb.com/
   - Click "Register" and create an account

2. **Subscribe to API access**
   - Go to https://thetvdb.com/api-information
   - Choose a subscription tier:
     - **Free**: Limited requests, personal use
     - **Paid**: Higher limits, commercial use

3. **Generate API key**
   - Go to your dashboard
   - Navigate to API Keys section
   - Generate a new API key
   - Copy the key

### TVDB Subscriber PIN

Some TVDB features require a subscriber PIN in addition to the API key. If you have a paid subscription, you can find your PIN in your account settings.

### Configure TVDB

```bash
# API key only
file-renamer config set-key tvdb YOUR_API_KEY

# With subscriber PIN (edit config file directly)
# Add to [api] section: tvdb_pin = "YOUR_PIN"
```

## Using Environment Variables

For security or automation, you can use environment variables instead of storing keys in the config file:

```bash
# Set keys
export FILE_RENAMER_API__TMDB_API_KEY=your_tmdb_key
export FILE_RENAMER_API__TVDB_API_KEY=your_tvdb_key

# Run command
file-renamer rename /path/to/media
```

### In Scripts

```bash
#!/bin/bash
export FILE_RENAMER_API__TMDB_API_KEY=your_key
file-renamer rename /media/movies --type movie --yes
```

### In CI/CD

Store keys as secrets and inject them as environment variables.

## Security Best Practices

1. **Don't commit keys to version control**
   - The config file is in `.gitignore` by default
   - Never hardcode keys in scripts you share

2. **Use environment variables for automation**
   - Keeps keys out of config files
   - Easier to rotate keys

3. **Limit key permissions**
   - TMDB and TVDB keys are read-only by design
   - They can only fetch data, not modify anything

4. **Rotate keys periodically**
   - Generate new keys occasionally
   - Revoke old keys you're no longer using

## Troubleshooting

### "Invalid TMDB API key"

- Verify you copied the complete key
- Check for extra spaces
- Try the API Read Access Token instead of the v3 key
- Verify your TMDB account is in good standing

### "Invalid TVDB API key"

- Ensure your subscription is active
- Check if your API key has expired
- Try generating a new key
- Verify you're using the correct key type

### "Authentication failed"

- Check your internet connection
- Verify the API service is online
- Try again in a few minutes (rate limiting)

### Testing API Keys

You can test your TMDB key with curl:

```bash
# Test TMDB v3 key
curl "https://api.themoviedb.org/3/movie/550?api_key=YOUR_KEY"

# Test TMDB Read Access Token
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "https://api.themoviedb.org/3/movie/550"
```

A successful response returns JSON data about "Fight Club" (movie ID 550).
