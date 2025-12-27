"""Base protocols for API providers."""

from typing import Optional, Protocol

from file_renamer.core.models import Album, Episode, Movie, Track, TVShow


class MovieProvider(Protocol):
    """Protocol for movie metadata providers."""

    async def search_movie(
        self,
        title: str,
        year: Optional[int] = None,
    ) -> list[Movie]:
        """Search for movies by title and optional year."""
        ...

    async def get_movie(self, movie_id: int) -> Optional[Movie]:
        """Get movie details by ID."""
        ...


class TVProvider(Protocol):
    """Protocol for TV show metadata providers."""

    async def search_show(
        self,
        title: str,
        year: Optional[int] = None,
    ) -> list[TVShow]:
        """Search for TV shows by title and optional year."""
        ...

    async def get_show(self, show_id: int) -> Optional[TVShow]:
        """Get TV show details by ID."""
        ...

    async def get_episode(
        self,
        show_id: int,
        season: int,
        episode: int,
    ) -> Optional[Episode]:
        """Get episode details."""
        ...


class MusicProvider(Protocol):
    """Protocol for music metadata providers."""

    async def search_recording(
        self,
        title: str,
        artist: Optional[str] = None,
        album: Optional[str] = None,
    ) -> list[Track]:
        """Search for recordings (tracks) by title and optional artist/album."""
        ...

    async def search_release(
        self,
        album: str,
        artist: Optional[str] = None,
    ) -> list[Album]:
        """Search for releases (albums) by title and optional artist."""
        ...

    async def get_recording(self, recording_id: str) -> Optional[Track]:
        """Get recording details by MusicBrainz ID."""
        ...

    async def get_release(self, release_id: str) -> Optional[Album]:
        """Get release details by MusicBrainz ID."""
        ...
