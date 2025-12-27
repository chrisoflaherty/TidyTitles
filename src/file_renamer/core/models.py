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
