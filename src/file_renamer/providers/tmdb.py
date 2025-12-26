"""TMDB API client for movie metadata."""

from datetime import date
from typing import Any, Optional

import httpx

from file_renamer.core.exceptions import AuthenticationError, ProviderError, RateLimitError
from file_renamer.core.models import Episode, Movie, TVShow

from .cache import APICache


class TMDBClient:
    """Client for The Movie Database (TMDB) API."""

    BASE_URL = "https://api.themoviedb.org/3"
    PROVIDER_NAME = "tmdb"

    def __init__(
        self,
        api_key: str,
        cache: Optional[APICache] = None,
        language: str = "en-US",
    ) -> None:
        """Initialize the TMDB client.

        Args:
            api_key: TMDB API key (v3) or API read access token (Bearer token).
                     Short keys (~32 chars) are treated as v3 API keys.
                     Long keys are treated as Bearer tokens.
            cache: Optional cache instance for response caching.
            language: Language for API responses.
        """
        self._api_key = api_key
        self._cache = cache
        self._language = language
        self._client: Optional[httpx.AsyncClient] = None
        # Determine if this is a v3 API key or a Bearer token
        # Bearer tokens are much longer (200+ chars)
        self._use_bearer = len(api_key) > 50

    async def __aenter__(self) -> "TMDBClient":
        """Enter async context."""
        headers = {"Accept": "application/json"}
        if self._use_bearer:
            headers["Authorization"] = f"Bearer {self._api_key}"

        self._client = httpx.AsyncClient(
            base_url=self.BASE_URL,
            headers=headers,
            timeout=30.0,
        )
        return self

    async def __aexit__(self, *args: Any) -> None:
        """Exit async context."""
        if self._client:
            await self._client.aclose()
            self._client = None

    def _ensure_client(self) -> httpx.AsyncClient:
        """Ensure the HTTP client is initialized."""
        if self._client is None:
            raise RuntimeError("TMDBClient must be used as an async context manager")
        return self._client

    async def _request(
        self,
        endpoint: str,
        params: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """Make an API request with caching and error handling."""
        client = self._ensure_client()
        params = params or {}
        params["language"] = self._language

        # Add API key as query param if not using Bearer auth
        if not self._use_bearer:
            params["api_key"] = self._api_key

        # Check cache
        if self._cache:
            cached = self._cache.get(self.PROVIDER_NAME, endpoint, params)
            if cached is not None:
                return cached

        response = await client.get(endpoint, params=params)

        if response.status_code == 401:
            raise AuthenticationError("Invalid TMDB API key")
        if response.status_code == 429:
            raise RateLimitError("TMDB rate limit exceeded")
        if response.status_code >= 400:
            raise ProviderError(f"TMDB API error: {response.status_code}")

        data = response.json()

        # Cache the response
        if self._cache:
            self._cache.set(self.PROVIDER_NAME, endpoint, params, data)

        return data

    async def search_movie(
        self,
        title: str,
        year: Optional[int] = None,
    ) -> list[Movie]:
        """Search for movies by title.

        Args:
            title: Movie title to search for.
            year: Optional release year to narrow results.

        Returns:
            List of matching Movie objects.
        """
        params: dict[str, Any] = {"query": title}
        if year:
            params["year"] = year

        data = await self._request("/search/movie", params)

        movies = []
        for item in data.get("results", []):
            release_date = None
            release_year = 0
            if item.get("release_date"):
                try:
                    release_date = date.fromisoformat(item["release_date"])
                    release_year = release_date.year
                except ValueError:
                    pass

            movies.append(
                Movie(
                    id=item["id"],
                    title=item["title"],
                    original_title=item.get("original_title", item["title"]),
                    year=release_year,
                    release_date=release_date,
                    overview=item.get("overview"),
                    genres=[],  # Would need separate call to get genre names
                    poster_path=item.get("poster_path"),
                    provider=self.PROVIDER_NAME,
                )
            )

        return movies

    async def get_movie(self, movie_id: int) -> Optional[Movie]:
        """Get movie details by ID.

        Args:
            movie_id: TMDB movie ID.

        Returns:
            Movie object or None if not found.
        """
        try:
            data = await self._request(f"/movie/{movie_id}")
        except ProviderError:
            return None

        release_date = None
        release_year = 0
        if data.get("release_date"):
            try:
                release_date = date.fromisoformat(data["release_date"])
                release_year = release_date.year
            except ValueError:
                pass

        genres = [g["name"] for g in data.get("genres", [])]

        return Movie(
            id=data["id"],
            title=data["title"],
            original_title=data.get("original_title", data["title"]),
            year=release_year,
            release_date=release_date,
            overview=data.get("overview"),
            genres=genres,
            poster_path=data.get("poster_path"),
            provider=self.PROVIDER_NAME,
        )

    async def search_show(
        self,
        title: str,
        year: Optional[int] = None,
    ) -> list[TVShow]:
        """Search for TV shows by title.

        Args:
            title: TV show title to search for.
            year: Optional first air date year to narrow results.

        Returns:
            List of matching TVShow objects.
        """
        params: dict[str, Any] = {"query": title}
        if year:
            params["first_air_date_year"] = year

        data = await self._request("/search/tv", params)

        shows = []
        for item in data.get("results", []):
            first_air_year = 0
            if item.get("first_air_date"):
                try:
                    first_air_year = int(item["first_air_date"][:4])
                except (ValueError, IndexError):
                    pass

            shows.append(
                TVShow(
                    id=item["id"],
                    title=item["name"],
                    original_title=item.get("original_name", item["name"]),
                    year=first_air_year,
                    network=None,  # Would need separate call
                    status=None,
                    genres=[],  # Would need separate call to get genre names
                    poster_path=item.get("poster_path"),
                    provider=self.PROVIDER_NAME,
                )
            )

        return shows

    async def get_show(self, show_id: int) -> Optional[TVShow]:
        """Get TV show details by ID.

        Args:
            show_id: TMDB TV show ID.

        Returns:
            TVShow object or None if not found.
        """
        try:
            data = await self._request(f"/tv/{show_id}")
        except ProviderError:
            return None

        first_air_year = 0
        if data.get("first_air_date"):
            try:
                first_air_year = int(data["first_air_date"][:4])
            except (ValueError, IndexError):
                pass

        genres = [g["name"] for g in data.get("genres", [])]
        networks = data.get("networks", [])
        network = networks[0]["name"] if networks else None

        return TVShow(
            id=data["id"],
            title=data["name"],
            original_title=data.get("original_name", data["name"]),
            year=first_air_year,
            network=network,
            status=data.get("status"),
            genres=genres,
            poster_path=data.get("poster_path"),
            provider=self.PROVIDER_NAME,
        )

    async def get_episode(
        self,
        show_id: int,
        season: int,
        episode: int,
    ) -> Optional[Episode]:
        """Get episode details.

        Args:
            show_id: TMDB TV show ID.
            season: Season number.
            episode: Episode number.

        Returns:
            Episode object or None if not found.
        """
        # First get the show info
        show = await self.get_show(show_id)
        if not show:
            return None

        # Then get the episode
        try:
            data = await self._request(f"/tv/{show_id}/season/{season}/episode/{episode}")
        except ProviderError:
            return None

        air_date = None
        if data.get("air_date"):
            try:
                air_date = date.fromisoformat(data["air_date"])
            except ValueError:
                pass

        return Episode(
            show=show,
            season=data.get("season_number", season),
            episode=data.get("episode_number", episode),
            title=data.get("name", ""),
            air_date=air_date,
            overview=data.get("overview"),
        )
