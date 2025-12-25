"""Pytest configuration and fixtures."""

import pytest
from pathlib import Path
from datetime import date

from file_renamer.core.models import (
    Episode,
    MediaFile,
    MediaType,
    Movie,
    ParsedInfo,
    TVShow,
)


@pytest.fixture
def sample_movie() -> Movie:
    """Create a sample movie for testing."""
    return Movie(
        id=603,
        title="The Matrix",
        original_title="The Matrix",
        year=1999,
        release_date=date(1999, 3, 31),
        overview="A computer hacker learns about the true nature of reality.",
        genres=["Action", "Science Fiction"],
        provider="tmdb",
    )


@pytest.fixture
def sample_tv_show() -> TVShow:
    """Create a sample TV show for testing."""
    return TVShow(
        id=1396,
        title="Breaking Bad",
        original_title="Breaking Bad",
        year=2008,
        network="AMC",
        status="Ended",
        genres=["Drama", "Crime"],
        provider="tvdb",
    )


@pytest.fixture
def sample_episode(sample_tv_show: TVShow) -> Episode:
    """Create a sample episode for testing."""
    return Episode(
        show=sample_tv_show,
        season=1,
        episode=1,
        title="Pilot",
        air_date=date(2008, 1, 20),
        overview="A high school chemistry teacher receives a terminal diagnosis.",
    )


@pytest.fixture
def sample_parsed_movie() -> ParsedInfo:
    """Create sample parsed info for a movie."""
    return ParsedInfo(
        title="The Matrix",
        year=1999,
        media_type=MediaType.MOVIE,
        quality="1080p",
        source="BluRay",
        codec="x264",
        group="SPARKS",
        raw_filename="The.Matrix.1999.1080p.BluRay.x264-SPARKS.mkv",
    )


@pytest.fixture
def sample_parsed_episode() -> ParsedInfo:
    """Create sample parsed info for a TV episode."""
    return ParsedInfo(
        title="Breaking Bad",
        year=None,
        season=1,
        episode=1,
        episode_title=None,
        media_type=MediaType.TV_EPISODE,
        quality="720p",
        source="HDTV",
        raw_filename="Breaking.Bad.S01E01.720p.HDTV.mkv",
    )


@pytest.fixture
def temp_media_dir(tmp_path: Path) -> Path:
    """Create a temporary directory with sample media files."""
    media_dir = tmp_path / "media"
    media_dir.mkdir()

    # Create sample movie files
    (media_dir / "The.Matrix.1999.1080p.BluRay.mkv").touch()
    (media_dir / "Inception.2010.720p.WEB-DL.mp4").touch()

    # Create sample TV files
    (media_dir / "Breaking.Bad.S01E01.720p.HDTV.mkv").touch()
    (media_dir / "Breaking.Bad.S01E02.720p.HDTV.mkv").touch()

    return media_dir
