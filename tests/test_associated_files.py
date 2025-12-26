"""Tests for associated file handling."""

import tempfile
from pathlib import Path

import pytest

from file_renamer.core.associated_files import (
    find_associated_files,
    generate_associated_destination,
    get_extensions_from_settings,
    get_file_type,
)


class TestGetFileType:
    """Tests for get_file_type function."""

    def test_subtitle_extensions(self):
        """Test subtitle file type detection."""
        assert get_file_type(Path("movie.srt")) == "subtitle"
        assert get_file_type(Path("movie.vtt")) == "subtitle"
        assert get_file_type(Path("movie.ass")) == "subtitle"

    def test_nfo_extensions(self):
        """Test NFO file type detection."""
        assert get_file_type(Path("movie.nfo")) == "nfo"

    def test_image_extensions(self):
        """Test image file type detection."""
        assert get_file_type(Path("movie.jpg")) == "image"
        assert get_file_type(Path("movie.png")) == "image"

    def test_other_extensions(self):
        """Test other file types."""
        assert get_file_type(Path("movie.txt")) == "other"


class TestGetExtensionsFromSettings:
    """Tests for get_extensions_from_settings function."""

    def test_all_enabled(self):
        """Test with all types enabled."""
        exts = get_extensions_from_settings(
            include_subtitles=True,
            include_nfo=True,
            include_images=True,
        )
        assert ".srt" in exts
        assert ".nfo" in exts
        assert ".jpg" in exts

    def test_only_subtitles(self):
        """Test with only subtitles enabled."""
        exts = get_extensions_from_settings(
            include_subtitles=True,
            include_nfo=False,
            include_images=False,
        )
        assert ".srt" in exts
        assert ".nfo" not in exts
        assert ".jpg" not in exts

    def test_none_enabled(self):
        """Test with all disabled."""
        exts = get_extensions_from_settings(
            include_subtitles=False,
            include_nfo=False,
            include_images=False,
        )
        assert len(exts) == 0


class TestFindAssociatedFiles:
    """Tests for find_associated_files function."""

    def test_find_subtitle(self):
        """Test finding subtitle file."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)

            # Create test files
            video = tmpdir_path / "movie.mkv"
            subtitle = tmpdir_path / "movie.srt"
            video.touch()
            subtitle.touch()

            # Find associated files
            associated = find_associated_files(video)

            assert len(associated) == 1
            assert associated[0].path == subtitle
            assert associated[0].file_type == "subtitle"

    def test_find_multiple_associated_files(self):
        """Test finding multiple associated files."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)

            # Create test files
            video = tmpdir_path / "movie.mkv"
            subtitle = tmpdir_path / "movie.srt"
            nfo = tmpdir_path / "movie.nfo"
            cover = tmpdir_path / "movie.jpg"

            video.touch()
            subtitle.touch()
            nfo.touch()
            cover.touch()

            # Find associated files
            associated = find_associated_files(video)

            assert len(associated) == 3
            file_types = {a.file_type for a in associated}
            assert "subtitle" in file_types
            assert "nfo" in file_types
            assert "image" in file_types

    def test_find_language_specific_subtitles(self):
        """Test finding language-specific subtitles."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)

            # Create test files
            video = tmpdir_path / "movie.mkv"
            sub_en = tmpdir_path / "movie.en.srt"
            sub_es = tmpdir_path / "movie.es.srt"

            video.touch()
            sub_en.touch()
            sub_es.touch()

            # Find associated files
            associated = find_associated_files(video)

            assert len(associated) == 2
            paths = {a.path.name for a in associated}
            assert "movie.en.srt" in paths
            assert "movie.es.srt" in paths

    def test_no_associated_files(self):
        """Test when no associated files exist."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)

            # Create only video file
            video = tmpdir_path / "movie.mkv"
            video.touch()

            # Find associated files
            associated = find_associated_files(video)

            assert len(associated) == 0

    def test_custom_extensions(self):
        """Test with custom extension set."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)

            # Create test files
            video = tmpdir_path / "movie.mkv"
            subtitle = tmpdir_path / "movie.srt"
            nfo = tmpdir_path / "movie.nfo"

            video.touch()
            subtitle.touch()
            nfo.touch()

            # Find only subtitles
            associated = find_associated_files(video, extensions={".srt"})

            assert len(associated) == 1
            assert associated[0].file_type == "subtitle"


class TestGenerateAssociatedDestination:
    """Tests for generate_associated_destination function."""

    def test_simple_subtitle(self):
        """Test generating destination for simple subtitle."""
        original = Path("/movies/old_name.srt")
        new_base = "New Movie (2024)"

        dest = generate_associated_destination(original, new_base)

        assert dest.name == "New Movie (2024).srt"
        assert dest.parent == Path("/movies")

    def test_language_specific_subtitle(self):
        """Test generating destination for language-specific subtitle."""
        original = Path("/movies/old_name.en.srt")
        new_base = "New Movie (2024)"

        dest = generate_associated_destination(original, new_base)

        assert dest.name == "New Movie (2024).en.srt"
        assert dest.parent == Path("/movies")

    def test_nfo_file(self):
        """Test generating destination for NFO file."""
        original = Path("/movies/old_name.nfo")
        new_base = "New Movie (2024)"

        dest = generate_associated_destination(original, new_base)

        assert dest.name == "New Movie (2024).nfo"

    def test_image_file(self):
        """Test generating destination for image file."""
        original = Path("/movies/old_name.jpg")
        new_base = "New Movie (2024)"

        dest = generate_associated_destination(original, new_base)

        assert dest.name == "New Movie (2024).jpg"
