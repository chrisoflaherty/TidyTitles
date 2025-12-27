"""Tests for MusicBrainz provider."""

import pytest

from file_renamer.core.models import Album, Artist, Track
from file_renamer.providers.musicbrainz import MusicBrainzClient


class TestMusicBrainzClientParsing:
    """Tests for MusicBrainz response parsing."""

    def test_parse_recording_basic(self) -> None:
        """Test parsing a basic recording response."""
        client = MusicBrainzClient()
        data = {
            "id": "abc123",
            "title": "Comfortably Numb",
            "length": 382000,
            "artist-credit": [
                {
                    "artist": {
                        "id": "artist123",
                        "name": "Pink Floyd",
                        "sort-name": "Pink Floyd",
                    }
                }
            ],
        }

        track = client._parse_recording(data)

        assert track.id == "abc123"
        assert track.title == "Comfortably Numb"
        assert track.artist.name == "Pink Floyd"
        assert track.artist.id == "artist123"
        assert track.duration_ms == 382000

    def test_parse_recording_with_release(self) -> None:
        """Test parsing a recording with album info."""
        client = MusicBrainzClient()
        data = {
            "id": "abc123",
            "title": "Comfortably Numb",
            "artist-credit": [
                {"artist": {"id": "artist123", "name": "Pink Floyd"}}
            ],
            "releases": [
                {
                    "id": "release123",
                    "title": "The Wall",
                    "date": "1979-11-30",
                    "artist-credit": [
                        {"artist": {"id": "artist123", "name": "Pink Floyd"}}
                    ],
                }
            ],
        }

        track = client._parse_recording(data)

        assert track.album is not None
        assert track.album.title == "The Wall"
        assert track.album.year == 1979

    def test_parse_recording_no_artist(self) -> None:
        """Test parsing a recording with no artist credit."""
        client = MusicBrainzClient()
        data = {
            "id": "abc123",
            "title": "Unknown Track",
        }

        track = client._parse_recording(data)

        assert track.title == "Unknown Track"
        assert track.artist.name == "Unknown Artist"

    def test_parse_release_basic(self) -> None:
        """Test parsing a basic release response."""
        client = MusicBrainzClient()
        data = {
            "id": "release123",
            "title": "The Wall",
            "date": "1979-11-30",
            "track-count": 26,
            "artist-credit": [
                {
                    "artist": {
                        "id": "artist123",
                        "name": "Pink Floyd",
                        "sort-name": "Pink Floyd",
                    }
                }
            ],
        }

        album = client._parse_release(data)

        assert album.id == "release123"
        assert album.title == "The Wall"
        assert album.year == 1979
        assert album.total_tracks == 26
        assert album.artist.name == "Pink Floyd"

    def test_parse_release_no_date(self) -> None:
        """Test parsing a release with no date."""
        client = MusicBrainzClient()
        data = {
            "id": "release123",
            "title": "Unknown Album",
            "artist-credit": [
                {"artist": {"id": "artist123", "name": "Artist"}}
            ],
        }

        album = client._parse_release(data)

        assert album.title == "Unknown Album"
        assert album.year is None

    def test_parse_release_with_media_track_count(self) -> None:
        """Test parsing a release with track count in media."""
        client = MusicBrainzClient()
        data = {
            "id": "release123",
            "title": "Double Album",
            "artist-credit": [
                {"artist": {"id": "artist123", "name": "Artist"}}
            ],
            "media": [
                {"track-count": 12},
                {"track-count": 14},
            ],
        }

        album = client._parse_release(data)

        assert album.total_tracks == 26


class TestMusicBrainzClientConstants:
    """Tests for MusicBrainz client constants."""

    def test_base_url(self) -> None:
        """Test that the base URL is correct."""
        assert MusicBrainzClient.BASE_URL == "https://musicbrainz.org/ws/2"

    def test_provider_name(self) -> None:
        """Test that the provider name is correct."""
        assert MusicBrainzClient.PROVIDER_NAME == "musicbrainz"

    def test_user_agent_set(self) -> None:
        """Test that a User-Agent is set (required by MusicBrainz)."""
        assert MusicBrainzClient.USER_AGENT
        assert "TidyTitles" in MusicBrainzClient.USER_AGENT


class TestMusicBrainzClientInit:
    """Tests for MusicBrainz client initialization."""

    def test_default_rate_limit(self) -> None:
        """Test default rate limit is 1 second."""
        client = MusicBrainzClient()
        assert client._rate_limit_delay == 1.0

    def test_custom_rate_limit(self) -> None:
        """Test custom rate limit can be set."""
        client = MusicBrainzClient(rate_limit_delay=2.0)
        assert client._rate_limit_delay == 2.0

    def test_client_not_initialized_before_context(self) -> None:
        """Test client is not initialized before entering context."""
        client = MusicBrainzClient()
        assert client._client is None
