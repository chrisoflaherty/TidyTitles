"""Data models for file renamer."""

from dataclasses import dataclass, field
from datetime import date
from enum import Enum, auto
from pathlib import Path
from typing import Optional, Union


class MediaType(Enum):
    """Type of media file."""

    MOVIE = auto()
    TV_EPISODE = auto()
    MUSIC = auto()
    UNKNOWN = auto()


class RenameStatus(Enum):
    """Status of a rename operation."""

    PENDING = auto()
    COMPLETED = auto()
    FAILED = auto()
    SKIPPED = auto()


class VerificationStatus(Enum):
    """Verification status for metadata from various sources."""

    # Music-specific statuses
    VERIFIED = auto()      # Tags verified against MusicBrainz
    UNVERIFIED = auto()    # Tags exist but not found in MusicBrainz
    FROM_PROVIDER = auto() # Metadata came directly from provider search

    # Movie/TV statuses
    AUTO_MATCHED = auto()      # System automatically found a match
    MANUAL_SELECTION = auto()  # User manually selected this result


@dataclass
class ParsedInfo:
    """Information extracted from filename parsing."""

    title: str
    year: Optional[int] = None
    season: Optional[int] = None
    episode: Optional[int] = None
    episode_title: Optional[str] = None
    media_type: MediaType = MediaType.UNKNOWN
    quality: Optional[str] = None
    source: Optional[str] = None
    codec: Optional[str] = None
    group: Optional[str] = None
    raw_filename: str = ""


@dataclass
class Movie:
    """Movie metadata from external provider."""

    id: int
    title: str
    original_title: str
    year: int
    release_date: Optional[date] = None
    overview: Optional[str] = None
    genres: list[str] = field(default_factory=list)
    poster_path: Optional[str] = None
    provider: str = "tmdb"
    verification_status: Optional["VerificationStatus"] = None


@dataclass
class TVShow:
    """TV show metadata."""

    id: int
    title: str
    original_title: str
    year: int
    network: Optional[str] = None
    status: Optional[str] = None
    genres: list[str] = field(default_factory=list)
    poster_path: Optional[str] = None
    provider: str = "tvdb"


@dataclass
class Episode:
    """TV episode metadata."""

    show: TVShow
    season: int
    episode: int
    title: str
    air_date: Optional[date] = None
    overview: Optional[str] = None
    verification_status: Optional["VerificationStatus"] = None


@dataclass
class Artist:
    """Music artist metadata."""

    id: str  # MusicBrainz uses UUIDs
    name: str
    sort_name: Optional[str] = None
    disambiguation: Optional[str] = None
    provider: str = "musicbrainz"


@dataclass
class Album:
    """Music album (release) metadata."""

    id: str
    title: str
    artist: Artist
    year: Optional[int] = None
    release_date: Optional[date] = None
    total_tracks: Optional[int] = None
    total_discs: Optional[int] = None
    cover_art_url: Optional[str] = None
    provider: str = "musicbrainz"


@dataclass
class Track:
    """Music track (recording) metadata."""

    id: str
    title: str
    artist: Artist
    album: Optional[Album] = None
    track_number: Optional[int] = None
    disc_number: Optional[int] = None
    duration_ms: Optional[int] = None
    genres: list[str] = field(default_factory=list)
    verification_status: Optional["VerificationStatus"] = None


@dataclass
class ParsedMusicInfo:
    """Information extracted from music file tags or filename."""

    title: Optional[str] = None
    artist: Optional[str] = None
    album: Optional[str] = None
    album_artist: Optional[str] = None
    year: Optional[int] = None
    track_number: Optional[int] = None
    disc_number: Optional[int] = None
    genre: Optional[str] = None
    duration_ms: Optional[int] = None
    raw_filename: str = ""
    source: str = "unknown"  # "tags" or "filename"

    def is_complete(self) -> bool:
        """Check if all required fields for renaming are present."""
        return all([
            self.title,
            self.artist,
            self.album,
            self.track_number is not None,
            self.year is not None,
        ])


@dataclass
class MediaFile:
    """Represents a media file to be renamed."""

    path: Path
    parsed_info: ParsedInfo
    parsed_music_info: Optional[ParsedMusicInfo] = None
    matched_metadata: Optional[Union[Movie, Episode, Track]] = None

    @property
    def filename(self) -> str:
        """Get the filename without directory."""
        return self.path.name

    @property
    def extension(self) -> str:
        """Get the file extension."""
        return self.path.suffix


@dataclass
class AssociatedFileRename:
    """Represents a rename operation for an associated file."""

    source: Path
    destination: Path
    file_type: str  # "subtitle", "nfo", "image", "other"


@dataclass
class RenameOperation:
    """Represents a planned rename operation."""

    source: Path
    destination: Path
    media_file: MediaFile
    status: RenameStatus = RenameStatus.PENDING
    error_message: Optional[str] = None
    associated_files: list[AssociatedFileRename] = field(default_factory=list)

    @property
    def will_overwrite(self) -> bool:
        """Check if this rename would overwrite an existing file."""
        return self.destination.exists() and self.source != self.destination

    @property
    def total_files(self) -> int:
        """Get total number of files that will be renamed (main + associated)."""
        return 1 + len(self.associated_files)


def track_from_parsed_info(
    parsed: ParsedMusicInfo,
    verification_status: VerificationStatus,
) -> Track:
    """Create a Track from ParsedMusicInfo (file tags).

    Args:
        parsed: Parsed music info from file tags.
        verification_status: The verification status to assign.

    Returns:
        A Track object created from the parsed info.
    """
    # Create Artist from parsed info
    artist = Artist(
        id="local",
        name=parsed.artist or "Unknown Artist",
        provider="local",
    )

    # Create Album if we have album info
    album = None
    if parsed.album:
        album = Album(
            id="local",
            title=parsed.album,
            artist=artist,
            year=parsed.year,
            provider="local",
        )

    return Track(
        id="local",
        title=parsed.title or "",
        artist=artist,
        album=album,
        track_number=parsed.track_number,
        disc_number=parsed.disc_number,
        duration_ms=parsed.duration_ms,
        verification_status=verification_status,
    )
