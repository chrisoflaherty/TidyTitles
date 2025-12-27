"""Music file tag parsing with filename fallback."""

import re
from pathlib import Path
from typing import Optional, Protocol

from .models import ParsedMusicInfo


class MusicParser(Protocol):
    """Protocol for music tag parsers."""

    def parse(self, file_path: Path) -> ParsedMusicInfo:
        """Parse music file to extract metadata."""
        ...

    def can_read(self, file_path: Path) -> bool:
        """Check if this parser can read the file format."""
        ...


MUSIC_EXTENSIONS = {
    ".mp3", ".flac", ".m4a", ".ogg", ".opus",
    ".wav", ".aiff", ".wma", ".aac", ".ape",
}


class MutagenParser:
    """Music tag parser using mutagen library."""

    def __init__(self) -> None:
        import mutagen
        self._mutagen = mutagen

    def can_read(self, file_path: Path) -> bool:
        """Check if this parser can read the file format."""
        return file_path.suffix.lower() in MUSIC_EXTENSIONS

    def parse(self, file_path: Path) -> ParsedMusicInfo:
        """Parse tags from music file."""
        try:
            audio = self._mutagen.File(file_path, easy=True)
            if audio is None:
                return self._parse_from_filename(file_path)

            # Extract tags
            title = self._get_tag(audio, "title")
            artist = self._get_tag(audio, "artist")
            album = self._get_tag(audio, "album")

            # If no useful tags, fall back to filename
            if not title and not artist:
                return self._parse_from_filename(file_path)

            return ParsedMusicInfo(
                title=title,
                artist=artist,
                album=album,
                album_artist=self._get_tag(audio, "albumartist"),
                year=self._parse_year(self._get_tag(audio, "date")),
                track_number=self._parse_track(self._get_tag(audio, "tracknumber")),
                disc_number=self._parse_track(self._get_tag(audio, "discnumber")),
                genre=self._get_tag(audio, "genre"),
                duration_ms=int(audio.info.length * 1000) if hasattr(audio, "info") and hasattr(audio.info, "length") else None,
                raw_filename=file_path.name,
                source="tags",
            )
        except Exception:
            return self._parse_from_filename(file_path)

    def _get_tag(self, audio: object, key: str) -> Optional[str]:
        """Get tag value, handling list values."""
        try:
            value = audio.get(key)  # type: ignore
            if value:
                return str(value[0]) if isinstance(value, list) else str(value)
        except (KeyError, TypeError, AttributeError):
            pass
        return None

    def _parse_year(self, date_str: Optional[str]) -> Optional[int]:
        """Extract year from date string."""
        if not date_str:
            return None
        try:
            # Handle formats like "2023", "2023-01-15", etc.
            return int(date_str[:4])
        except (ValueError, TypeError):
            return None

    def _parse_track(self, track_str: Optional[str]) -> Optional[int]:
        """Parse track/disc number from string like '5' or '5/12'."""
        if not track_str:
            return None
        try:
            # Handle "5" or "5/12" format
            return int(track_str.split("/")[0])
        except (ValueError, TypeError):
            return None

    def _parse_from_filename(self, file_path: Path) -> ParsedMusicInfo:
        """Fall back to filename parsing."""
        return MusicFilenameParser().parse(file_path)


class MusicFilenameParser:
    """Fallback parser for filename-based extraction."""

    # Common patterns for music filenames
    PATTERNS = [
        # "Artist - Album - 01 - Title"
        re.compile(
            r"^(?P<artist>.+?)\s*-\s*(?P<album>.+?)\s*-\s*(?P<track>\d+)\s*-\s*(?P<title>.+)$"
        ),
        # "01 - Artist - Title"
        re.compile(
            r"^(?P<track>\d+)\s*-\s*(?P<artist>.+?)\s*-\s*(?P<title>.+)$"
        ),
        # "Artist - Title"
        re.compile(
            r"^(?P<artist>.+?)\s*-\s*(?P<title>.+)$"
        ),
        # "01. Title"
        re.compile(
            r"^(?P<track>\d+)\.\s*(?P<title>.+)$"
        ),
        # "01 Title"
        re.compile(
            r"^(?P<track>\d+)\s+(?P<title>.+)$"
        ),
    ]

    def can_read(self, file_path: Path) -> bool:
        """Check if this parser can read the file format."""
        return file_path.suffix.lower() in MUSIC_EXTENSIONS

    def parse(self, file_path: Path) -> ParsedMusicInfo:
        """Parse metadata from filename."""
        stem = file_path.stem

        for pattern in self.PATTERNS:
            match = pattern.match(stem)
            if match:
                groups = match.groupdict()
                return ParsedMusicInfo(
                    title=groups.get("title", "").strip(),
                    artist=groups.get("artist", "").strip() or None,
                    album=groups.get("album", "").strip() or None,
                    track_number=int(groups["track"]) if groups.get("track") else None,
                    raw_filename=file_path.name,
                    source="filename",
                )

        # No pattern matched, use whole stem as title
        return ParsedMusicInfo(
            title=stem,
            raw_filename=file_path.name,
            source="filename",
        )


def create_music_parser(use_mutagen: bool = True) -> MusicParser:
    """Create a music parser instance.

    Args:
        use_mutagen: If True, try to use mutagen for tag reading.

    Returns:
        A MusicParser implementation.
    """
    if use_mutagen:
        try:
            return MutagenParser()
        except ImportError:
            pass
    return MusicFilenameParser()


def is_music_file(file_path: Path) -> bool:
    """Check if a file is a music file based on extension."""
    return file_path.suffix.lower() in MUSIC_EXTENSIONS
