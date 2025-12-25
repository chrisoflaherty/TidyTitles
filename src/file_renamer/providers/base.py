"""Base protocols for API providers."""

from typing import Optional, Protocol

from file_renamer.core.models import Episode, Movie, TVShow


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
