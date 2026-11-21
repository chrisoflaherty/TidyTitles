"""Run guessit over filenames read from stdin (one per line).

Prints one JSON object per line with ParsedInfo fields in camelCase, so the
TypeScript parity script can compare them. Used by parser-parity.ts.

The mapping from guessit's result to the first eleven fields is the one the
original Python app used (its GuessItParser): the first of several episodes
or seasons, `screen_size` as quality, `video_codec` as codec, `release_group`
as group. Needs the `guessit` package.
"""

import json
import sys

import guessit

MEDIA_TYPES = {"movie": "movie", "episode": "tv_episode"}

# Release details the Python app never read; taken from guessit directly and
# joined the way the TypeScript parser joins several values.
HDR_OTHER = ("HDR10", "Dolby Vision")


def first(value):
    """guessit returns a list for several episodes or seasons: take the first."""
    if isinstance(value, list):
        return value[0] if value else None
    return value


def joined(value):
    if value is None:
        return None
    values = value if isinstance(value, list) else [value]
    return ", ".join(str(v) for v in values) or None


for line in sys.stdin:
    name = line.rstrip("\n")
    if not name:
        continue
    result = guessit.guessit(name)
    other = result.get("other")
    other = other if isinstance(other, list) else [other] if other else []
    # Every episode of a multi-episode file, and the air date of a daily show.
    episodes = result.get("episode")
    date = result.get("date")
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
        "edition": joined(result.get("edition")),
        "audioCodec": joined(result.get("audio_codec")),
        "audioChannels": joined(result.get("audio_channels")),
        "hdr": joined([str(o) for o in other if str(o) in HDR_OTHER] or None),
        "episodes": episodes if isinstance(episodes, list) and len(episodes) > 1 else None,
        "airDate": date.isoformat() if date is not None and result.get("type") == "episode" else None,
    }
    # guessit values are str subclasses or plain ints/lists; default=str keeps
    # anything unexpected visible instead of crashing.
    print(json.dumps(out, default=str), flush=True)
