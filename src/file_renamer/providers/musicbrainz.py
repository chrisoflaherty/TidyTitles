"""MusicBrainz API client for music metadata."""

import asyncio
import time
from typing import Any, Optional

import httpx

from file_renamer.core.exceptions import ProviderError, RateLimitError
from file_renamer.core.models import Album, Artist, Track

from .cache import APICache


class MusicBrainzClient:
    """Client for MusicBrainz API.

    MusicBrainz is a free, open music database that requires no API key.
    It requires a User-Agent header and has a rate limit of 1 request per second.
    """

    BASE_URL = "https://musicbrainz.org/ws/2"
    PROVIDER_NAME = "musicbrainz"

    # MusicBrainz requires identifying User-Agent
    USER_AGENT = "TidyTitles/0.1.0 (https://github.com/user/tidytitles)"

    def __init__(
        self,
        cache: Optional[APICache] = None,
        rate_limit_delay: float = 1.0,
    ) -> None:
        """Initialize the MusicBrainz client.

        Args:
            cache: Optional cache for API responses.
            rate_limit_delay: Minimum seconds between requests (default 1.0).
        """
        self._cache = cache
        self._rate_limit_delay = rate_limit_delay
        self._client: Optional[httpx.AsyncClient] = None
        self._last_request_time: float = 0

    async def __aenter__(self) -> "MusicBrainzClient":
        """Enter async context."""
        self._client = httpx.AsyncClient(
            base_url=self.BASE_URL,
            headers={
                "User-Agent": self.USER_AGENT,
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

    async def _request(
        self,
        endpoint: str,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        """Make a rate-limited API request.

        Args:
            endpoint: API endpoint path.
            params: Query parameters.

        Returns:
            JSON response data.

        Raises:
            RateLimitError: If rate limited by MusicBrainz.
            ProviderError: If API returns an error.
        """
        if not self._client:
            raise ProviderError("Client not initialized. Use 'async with' context.")

        # Enforce rate limiting
        elapsed = time.time() - self._last_request_time
        if elapsed < self._rate_limit_delay:
            await asyncio.sleep(self._rate_limit_delay - elapsed)

        # Check cache first
        if self._cache:
            cached = self._cache.get(self.PROVIDER_NAME, endpoint, params)
            if cached is not None:
                return cached

        # Make request
        params["fmt"] = "json"
        response = await self._client.get(endpoint, params=params)
        self._last_request_time = time.time()

        if response.status_code == 503:
            raise RateLimitError("MusicBrainz rate limit exceeded. Please wait.")
        if response.status_code >= 400:
            raise ProviderError(f"MusicBrainz API error: {response.status_code}")

        data = response.json()

        # Cache successful response
        if self._cache:
            self._cache.set(self.PROVIDER_NAME, endpoint, params, data)

        return data

    async def search_recording(
        self,
        title: str,
        artist: Optional[str] = None,
        album: Optional[str] = None,
    ) -> list[Track]:
        """Search for recordings (tracks) by title.

        Args:
            title: Track title to search for.
            artist: Optional artist name to narrow search.
            album: Optional album name to narrow search.

        Returns:
            List of matching Track objects.
        """
        # Build Lucene query
        query_parts = [f'recording:"{title}"']
        if artist:
            query_parts.append(f'artist:"{artist}"')
        if album:
            query_parts.append(f'release:"{album}"')

        data = await self._request(
            "/recording",
            {"query": " AND ".join(query_parts), "limit": "10"},
        )

        return [
            self._parse_recording(r)
            for r in data.get("recordings", [])
        ]

    async def search_release(
        self,
        album: str,
        artist: Optional[str] = None,
    ) -> list[Album]:
        """Search for releases (albums) by title.

        Args:
            album: Album title to search for.
            artist: Optional artist name to narrow search.

        Returns:
            List of matching Album objects.
        """
        query_parts = [f'release:"{album}"']
        if artist:
            query_parts.append(f'artist:"{artist}"')

        data = await self._request(
            "/release",
            {"query": " AND ".join(query_parts), "limit": "10"},
        )

        return [
            self._parse_release(r)
            for r in data.get("releases", [])
        ]

    async def get_recording(self, recording_id: str) -> Optional[Track]:
        """Get recording details by MusicBrainz ID.

        Args:
            recording_id: MusicBrainz recording UUID.

        Returns:
            Track object or None if not found.
        """
        try:
            data = await self._request(
                f"/recording/{recording_id}",
                {"inc": "artist-credits+releases"},
            )
            return self._parse_recording(data)
        except ProviderError:
            return None

    async def get_release(self, release_id: str) -> Optional[Album]:
        """Get release details by MusicBrainz ID.

        Args:
            release_id: MusicBrainz release UUID.

        Returns:
            Album object or None if not found.
        """
        try:
            data = await self._request(
                f"/release/{release_id}",
                {"inc": "artist-credits+recordings"},
            )
            return self._parse_release(data)
        except ProviderError:
            return None

    def _parse_recording(self, data: dict[str, Any]) -> Track:
        """Parse a recording response into a Track object."""
        # Get artist from artist-credit
        artist_credit = data.get("artist-credit", [])
        if artist_credit:
            first_artist = artist_credit[0].get("artist", {})
            artist = Artist(
                id=first_artist.get("id", ""),
                name=first_artist.get("name", "Unknown Artist"),
                sort_name=first_artist.get("sort-name"),
                disambiguation=first_artist.get("disambiguation"),
            )
        else:
            artist = Artist(id="", name="Unknown Artist")

        # Get album from first release if available
        album = None
        track_number = None
        releases = data.get("releases", [])
        if releases:
            album = self._parse_release(releases[0])
            # Try to get track number from medium
            for medium in releases[0].get("media", []):
                for track in medium.get("tracks", []):
                    if track.get("recording", {}).get("id") == data.get("id"):
                        track_number = track.get("position")
                        break
                if track_number:
                    break

        return Track(
            id=data.get("id", ""),
            title=data.get("title", ""),
            artist=artist,
            album=album,
            track_number=track_number,
            duration_ms=data.get("length"),
        )

    def _parse_release(self, data: dict[str, Any]) -> Album:
        """Parse a release response into an Album object."""
        # Get artist from artist-credit
        artist_credit = data.get("artist-credit", [])
        if artist_credit:
            first_artist = artist_credit[0].get("artist", {})
            artist = Artist(
                id=first_artist.get("id", ""),
                name=first_artist.get("name", "Unknown Artist"),
                sort_name=first_artist.get("sort-name"),
            )
        else:
            artist = Artist(id="", name="Unknown Artist")

        # Parse year from date
        year = None
        date_str = data.get("date", "")
        if date_str:
            try:
                year = int(date_str[:4])
            except (ValueError, TypeError):
                pass

        # Get track count from media
        total_tracks = data.get("track-count")
        if not total_tracks:
            for medium in data.get("media", []):
                if medium.get("track-count"):
                    total_tracks = (total_tracks or 0) + medium["track-count"]

        return Album(
            id=data.get("id", ""),
            title=data.get("title", ""),
            artist=artist,
            year=year,
            total_tracks=total_tracks,
        )
