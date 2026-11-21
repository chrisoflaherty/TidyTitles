"""Run the Python GuessItParser over filenames read from stdin (one per line).

Prints one JSON object per line with ParsedInfo fields in camelCase, so the
TypeScript parity script can compare them. Used by parser-parity.ts.

Run with PYTHONPATH pointing at the repo's src/ directory.
"""

import json
import sys

import guessit

from file_renamer.core.parser import GuessItParser

parser = GuessItParser()
for line in sys.stdin:
    name = line.rstrip("\n")
    if not name:
        continue
    info = parser.parse(name)
    # Fields the Python ParsedInfo drops, read from guessit directly: every
    # episode of a multi-episode file, and the air date of a daily show.
    raw = guessit.guessit(name)
    episodes = raw.get("episode")
    date = raw.get("date")
    out = {
        "rawFilename": name,
        "title": info.title,
        "year": info.year,
        "season": info.season,
        "episode": info.episode,
        "episodeTitle": info.episode_title,
        "mediaType": info.media_type.name.lower(),
        "quality": info.quality,
        "source": info.source,
        "codec": info.codec,
        "group": info.group,
        "episodes": episodes if isinstance(episodes, list) and len(episodes) > 1 else None,
        "airDate": date.isoformat() if date is not None and raw.get("type") == "episode" else None,
    }
    # guessit values are str subclasses or plain ints/lists; default=str keeps
    # anything unexpected visible instead of crashing.
    print(json.dumps(out, default=str), flush=True)
