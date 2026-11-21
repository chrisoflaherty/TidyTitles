"""Run the Python GuessItParser over filenames read from stdin (one per line).

Prints one JSON object per line with ParsedInfo fields in camelCase, so the
TypeScript parity script can compare them. Used by parser-parity.ts.

Run with PYTHONPATH pointing at the repo's src/ directory.
"""

import json
import sys

from guessit import guessit

from file_renamer.core.parser import GuessItParser

# Release details the Python app never read; taken from guessit directly and
# joined the way the TypeScript parser joins several values.
HDR_OTHER = ("HDR10", "Dolby Vision")


def joined(value):
    if value is None:
        return None
    values = value if isinstance(value, list) else [value]
    return ", ".join(str(v) for v in values) or None


parser = GuessItParser()
for line in sys.stdin:
    name = line.rstrip("\n")
    if not name:
        continue
    info = parser.parse(name)
    raw = guessit(name)
    other = raw.get("other")
    other = other if isinstance(other, list) else [other] if other else []
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
        "edition": joined(raw.get("edition")),
        "audioCodec": joined(raw.get("audio_codec")),
        "audioChannels": joined(raw.get("audio_channels")),
        "hdr": joined([str(o) for o in other if str(o) in HDR_OTHER] or None),
    }
    # guessit values are str subclasses or plain ints/lists; default=str keeps
    # anything unexpected visible instead of crashing.
    print(json.dumps(out, default=str), flush=True)
