"""TVDB API client for TV show metadata."""

from datetime import date
from typing import Any, Optional

import httpx

from file_renamer.core.exceptions import AuthenticationError, ProviderError, RateLimitError
from file_renamer.core.models import Episode, TVShow

from .cache import APICache


class TVDBClient:
    """Client for TheTVDB API v4."""

    BASE_URL = "https://api4.thetvdb.com/v4"
    PROVIDER_NAME = "tvdb"

    def __init__(
        self,
        api_key: str,
        cache: Optional[APICache] = None,
        pin: Optional[str] = None,
    ) -> None:
        """Initialize the TVDB client.

        Args:
            api_key: TVDB API key.
            cache: Optional cache instance for response caching.
            pin: Optional subscriber PIN for extended access.
        """
        self._api_key = api_key
        self._pin = pin
        self._cache = cache
        self._token: Optional[str] = None
        self._client: Optional[httpx.AsyncClient] = None

    async def _authenticate(self) -> None:
        """Authenticate with TVDB and obtain bearer token."""
        auth_data: dict[str, str] = {"apikey": self._api_key}
        if self._pin:
            auth_data["pin"] = self._pin

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{self.BASE_URL}/login",
                json=auth_data,
            )

            if response.status_code == 401:
                raise AuthenticationError("Invalid TVDB API key")
            if response.status_code >= 400:
                raise ProviderError(f"TVDB authentication failed: {response.status_code}")

            data = response.json()
            self._token = data["data"]["token"]

    async def __aenter__(self) -> "TVDBClient":
        """Enter async context."""
        await self._authenticate()
        self._client = httpx.AsyncClient(
            base_url=self.BASE_URL,
            headers={
                "Authorization": f"Bearer {self._token}",
                "Accept": "application/json",
            },
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
            raise RuntimeError("TVDBClient must be used as an async context manager")
        return self._client

    async def _request(
        self,
        endpoint: str,
        params: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """Make an API request with caching and error handling."""
        client = self._ensure_client()
        params = params or {}

        # Check cache
        if self._cache:
            cached = self._cache.get(self.PROVIDER_NAME, endpoint, params)
            if cached is not None:
                return cached

        response = await client.get(endpoint, params=params)

        if response.status_code == 401:
            raise AuthenticationError("TVDB token expired or invalid")
        if response.status_code == 429:
            raise RateLimitError("TVDB rate limit exceeded")
        if response.status_code >= 400:
            raise ProviderError(f"TVDB API error: {response.status_code}")

        data = response.json()

        # Cache the response
        if self._cache:
            self._cache.set(self.PROVIDER_NAME, endpoint, params, data)

        return data

    async def search_show(
        self,
        title: str,
        year: Optional[int] = None,
    ) -> list[TVShow]:
        """Search for TV shows by title.

        Args:
            title: Show title to search for.
            year: Optional release year to narrow results.

        Returns:
            List of matching TVShow objects.
        """
        params: dict[str, Any] = {"query": title, "type": "series"}
        if year:
            params["year"] = year

        data = await self._request("/search", params)

        shows = []
        for item in data.get("data", []):
            # Extract year from first aired date
            show_year = 0
            if item.get("year"):
                show_year = int(item["year"])
            elif item.get("first_air_time"):
                try:
                    show_year = int(item["first_air_time"][:4])
                except (ValueError, TypeError):
                    pass

            # Get the TVDB series ID
            tvdb_id = item.get("tvdb_id") or item.get("id")
            if isinstance(tvdb_id, str):
                tvdb_id = int(tvdb_id)

            shows.append(
                TVShow(
                    id=tvdb_id,
                    title=item.get("name", item.get("title", "")),
                    original_title=item.get("name", item.get("title", "")),
                    year=show_year,
                    network=item.get("network"),
                    status=item.get("status"),
                    genres=[],
                    poster_path=item.get("image_url") or item.get("thumbnail"),
                    provider=self.PROVIDER_NAME,
                )
            )

        return shows

    async def get_show(self, show_id: int) -> Optional[TVShow]:
        """Get TV show details by ID.

        Args:
            show_id: TVDB series ID.

        Returns:
            TVShow object or None if not found.
        """
        try:
            data = await self._request(f"/series/{show_id}")
        except ProviderError:
            return None

        item = data.get("data", {})

        show_year = 0
        if item.get("year"):
            show_year = int(item["year"])
        elif item.get("firstAired"):
            try:
                show_year = int(item["firstAired"][:4])
            except (ValueError, TypeError):
                pass

        genres = [g["name"] for g in item.get("genres", [])]

        return TVShow(
            id=item["id"],
            title=item.get("name", ""),
            original_title=item.get("originalName", item.get("name", "")),
            year=show_year,
            network=item.get("originalNetwork", {}).get("name") if item.get("originalNetwork") else None,
            status=item.get("status", {}).get("name") if isinstance(item.get("status"), dict) else item.get("status"),
            genres=genres,
            poster_path=item.get("image"),
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
            show_id: TVDB series ID.
            season: Season number.
            episode: Episode number.

        Returns:
            Episode object or None if not found.
        """
        # First get the show details
        show = await self.get_show(show_id)
        if not show:
            return None

        # Get episodes for the season
        try:
            data = await self._request(
                f"/series/{show_id}/episodes/default",
                params={"season": season},
            )
        except ProviderError:
            return None

        episodes = data.get("data", {}).get("episodes", [])

        for ep in episodes:
            if ep.get("seasonNumber") == season and ep.get("number") == episode:
                air_date = None
                if ep.get("aired"):
                    try:
                        air_date = date.fromisoformat(ep["aired"])
                    except ValueError:
                        pass

                return Episode(
                    show=show,
                    season=season,
                    episode=episode,
                    title=ep.get("name", f"Episode {episode}"),
                    air_date=air_date,
                    overview=ep.get("overview"),
                )

        return None
