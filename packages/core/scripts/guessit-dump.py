"""Run guessit over filenames read from stdin (one per line).

Prints one JSON object per line with ParsedInfo fields in camelCase, so the
TypeScript parity script can compare them. Used by parser-parity.ts.

The mapping from guessit's result to these fields is the one the original
Python app used (its GuessItParser): the first of several episodes or
seasons, `screen_size` as quality, `video_codec` as codec, `release_group`
as group. Needs the `guessit` package.
"""

import json
import sys

import guessit

MEDIA_TYPES = {"movie": "movie", "episode": "tv_episode"}


def first(value):
    """guessit returns a list for several episodes or seasons: take the first."""
    if isinstance(value, list):
        return value[0] if value else None
    return value


for line in sys.stdin:
    name = line.rstrip("\n")
    if not name:
        continue
    result = guessit.guessit(name)
    out = {
        "rawFilename": name,
        "title": result.get("title", ""),
        "year": result.get("year"),
        "season": first(result.get("season")),
        "episode": first(result.get("episode")),
        "episodeTitle": result.get("episode_title"),
        "mediaType": MEDIA_TYPES.get(result.get("type"), "unknown"),
        "quality": result.get("screen_size"),
        "source": result.get("source"),
        "codec": result.get("video_codec"),
        "group": result.get("release_group"),
    }
    # guessit values are str subclasses or plain ints/lists; default=str keeps
    # anything unexpected visible instead of crashing.
    print(json.dumps(out, default=str), flush=True)
