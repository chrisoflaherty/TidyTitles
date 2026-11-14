"""Run the Python GuessItParser over filenames read from stdin (one per line).

Prints one JSON object per line with ParsedInfo fields in camelCase, so the
TypeScript parity script can compare them. Used by parser-parity.ts.

Run with PYTHONPATH pointing at the repo's src/ directory.
"""

import json
import sys

from file_renamer.core.parser import GuessItParser

parser = GuessItParser()
for line in sys.stdin:
    name = line.rstrip("\n")
    if not name:
        continue
    info = parser.parse(name)
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
    }
    # guessit values are str subclasses or plain ints/lists; default=str keeps
    # anything unexpected visible instead of crashing.
    print(json.dumps(out, default=str), flush=True)
