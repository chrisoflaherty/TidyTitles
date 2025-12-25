"""Filename parsing to extract media information."""

import re
from typing import Protocol

from .models import MediaType, ParsedInfo


class FilenameParser(Protocol):
    """Protocol for filename parsers."""

    def parse(self, filename: str) -> ParsedInfo:
        """Parse a filename and extract media information."""
        ...


class GuessItParser:
    """Parser using the guessit library."""

    def __init__(self) -> None:
        import guessit

        self._guessit = guessit

    def parse(self, filename: str) -> ParsedInfo:
        """Parse a filename using guessit."""
        result = self._guessit.guessit(filename)

        media_type = MediaType.UNKNOWN
        if result.get("type") == "movie":
            media_type = MediaType.MOVIE
        elif result.get("type") == "episode":
            media_type = MediaType.TV_EPISODE

        # Handle multiple episodes (take first)
        episode = result.get("episode")
        if isinstance(episode, list):
            episode = episode[0] if episode else None

        season = result.get("season")
        if isinstance(season, list):
            season = season[0] if season else None

        return ParsedInfo(
            title=result.get("title", ""),
            year=result.get("year"),
            season=season,
            episode=episode,
            episode_title=result.get("episode_title"),
            media_type=media_type,
            quality=result.get("screen_size"),
            source=result.get("source"),
            codec=result.get("video_codec"),
            group=result.get("release_group"),
            raw_filename=filename,
        )


class RegexParser:
    """Fallback regex-based parser for simple cases."""

    TV_PATTERNS = [
        # S01E02 format
        re.compile(
            r"^(?P<title>.+?)[.\s_-]+S(?P<season>\d{1,2})E(?P<episode>\d{1,2})",
            re.IGNORECASE,
        ),
        # 1x02 format
        re.compile(
            r"^(?P<title>.+?)[.\s_-]+(?P<season>\d{1,2})x(?P<episode>\d{1,2})",
            re.IGNORECASE,
        ),
    ]

    MOVIE_PATTERNS = [
        # Title (Year) format
        re.compile(r"^(?P<title>.+?)\s*\((?P<year>(?:19|20)\d{2})\)"),
        # Title.Year format
        re.compile(r"^(?P<title>.+?)[.\s_-]+(?P<year>(?:19|20)\d{2})[.\s_-]"),
    ]

    QUALITY_PATTERN = re.compile(r"(2160p|1080p|720p|480p)", re.IGNORECASE)
    SOURCE_PATTERN = re.compile(
        r"(BluRay|Blu-Ray|BDRip|BRRip|WEB-DL|WEBRip|HDTV|DVDRip)", re.IGNORECASE
    )
    CODEC_PATTERN = re.compile(r"(x264|x265|H\.?264|H\.?265|HEVC|XviD)", re.IGNORECASE)
    GROUP_PATTERN = re.compile(r"-([A-Za-z0-9]+)(?:\.[^.]+)?$")

    def parse(self, filename: str) -> ParsedInfo:
        """Parse a filename using regex patterns."""
        # Remove extension for parsing
        name_without_ext = re.sub(r"\.[^.]+$", "", filename)

        # Try TV patterns first
        for pattern in self.TV_PATTERNS:
            match = pattern.match(name_without_ext)
            if match:
                return self._build_parsed_info(
                    filename=filename,
                    title=self._clean_title(match.group("title")),
                    season=int(match.group("season")),
                    episode=int(match.group("episode")),
                    media_type=MediaType.TV_EPISODE,
                    remaining=name_without_ext[match.end() :],
                )

        # Try movie patterns
        for pattern in self.MOVIE_PATTERNS:
            match = pattern.match(name_without_ext)
            if match:
                return self._build_parsed_info(
                    filename=filename,
                    title=self._clean_title(match.group("title")),
                    year=int(match.group("year")),
                    media_type=MediaType.MOVIE,
                    remaining=name_without_ext[match.end() :],
                )

        # Unable to parse, return with just the title
        return ParsedInfo(
            title=self._clean_title(name_without_ext),
            media_type=MediaType.UNKNOWN,
            raw_filename=filename,
        )

    def _clean_title(self, title: str) -> str:
        """Clean up a title by replacing separators with spaces."""
        cleaned = re.sub(r"[._]", " ", title)
        cleaned = re.sub(r"\s+", " ", cleaned)
        return cleaned.strip()

    def _build_parsed_info(
        self,
        filename: str,
        title: str,
        remaining: str,
        media_type: MediaType,
        year: int | None = None,
        season: int | None = None,
        episode: int | None = None,
    ) -> ParsedInfo:
        """Build ParsedInfo with additional metadata from remaining text."""
        quality_match = self.QUALITY_PATTERN.search(remaining)
        source_match = self.SOURCE_PATTERN.search(remaining)
        codec_match = self.CODEC_PATTERN.search(remaining)
        group_match = self.GROUP_PATTERN.search(filename)

        return ParsedInfo(
            title=title,
            year=year,
            season=season,
            episode=episode,
            media_type=media_type,
            quality=quality_match.group(1) if quality_match else None,
            source=source_match.group(1) if source_match else None,
            codec=codec_match.group(1) if codec_match else None,
            group=group_match.group(1) if group_match else None,
            raw_filename=filename,
        )


def create_parser(use_guessit: bool = True) -> FilenameParser:
    """Create a filename parser instance.

    Args:
        use_guessit: If True, use guessit library. If False, use regex fallback.

    Returns:
        A FilenameParser instance.
    """
    if use_guessit:
        try:
            return GuessItParser()
        except ImportError:
            pass
    return RegexParser()
