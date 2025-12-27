"""Tests for music file parser."""

from pathlib import Path

import pytest

from file_renamer.core.music_parser import (
    MUSIC_EXTENSIONS,
    MusicFilenameParser,
    create_music_parser,
    is_music_file,
)


class TestMusicFilenameParser:
    """Tests for the filename-based music parser."""

    def test_parse_artist_album_track_title(self) -> None:
        """Test parsing 'Artist - Album - 01 - Title' format."""
        parser = MusicFilenameParser()
        result = parser.parse(Path("Pink Floyd - The Wall - 06 - Comfortably Numb.mp3"))

        assert result.artist == "Pink Floyd"
        assert result.album == "The Wall"
        assert result.track_number == 6
        assert result.title == "Comfortably Numb"
        assert result.source == "filename"

    def test_parse_track_artist_title(self) -> None:
        """Test parsing '01 - Artist - Title' format."""
        parser = MusicFilenameParser()
        result = parser.parse(Path("06 - Pink Floyd - Comfortably Numb.flac"))

        assert result.track_number == 6
        assert result.artist == "Pink Floyd"
        assert result.title == "Comfortably Numb"
        assert result.source == "filename"

    def test_parse_artist_title(self) -> None:
        """Test parsing 'Artist - Title' format."""
        parser = MusicFilenameParser()
        result = parser.parse(Path("Pink Floyd - Comfortably Numb.mp3"))

        assert result.artist == "Pink Floyd"
        assert result.title == "Comfortably Numb"
        assert result.track_number is None
        assert result.source == "filename"

    def test_parse_track_dot_title(self) -> None:
        """Test parsing '01. Title' format."""
        parser = MusicFilenameParser()
        result = parser.parse(Path("06. Comfortably Numb.mp3"))

        assert result.track_number == 6
        assert result.title == "Comfortably Numb"
        assert result.artist is None
        assert result.source == "filename"

    def test_parse_track_space_title(self) -> None:
        """Test parsing '01 Title' format."""
        parser = MusicFilenameParser()
        result = parser.parse(Path("06 Comfortably Numb.mp3"))

        assert result.track_number == 6
        assert result.title == "Comfortably Numb"
        assert result.artist is None
        assert result.source == "filename"

    def test_parse_unknown_format(self) -> None:
        """Test parsing unrecognized filename falls back to stem as title."""
        parser = MusicFilenameParser()
        result = parser.parse(Path("random_track.mp3"))

        assert result.title == "random_track"
        assert result.artist is None
        assert result.track_number is None
        assert result.source == "filename"

    def test_can_read_music_extensions(self) -> None:
        """Test can_read returns True for music files."""
        parser = MusicFilenameParser()

        assert parser.can_read(Path("song.mp3")) is True
        assert parser.can_read(Path("song.flac")) is True
        assert parser.can_read(Path("song.m4a")) is True
        assert parser.can_read(Path("song.ogg")) is True

    def test_can_read_non_music(self) -> None:
        """Test can_read returns False for non-music files."""
        parser = MusicFilenameParser()

        assert parser.can_read(Path("video.mkv")) is False
        assert parser.can_read(Path("video.mp4")) is False
        assert parser.can_read(Path("document.txt")) is False


class TestMusicExtensions:
    """Tests for music file extension detection."""

    def test_music_extensions_set(self) -> None:
        """Test that common music extensions are included."""
        assert ".mp3" in MUSIC_EXTENSIONS
        assert ".flac" in MUSIC_EXTENSIONS
        assert ".m4a" in MUSIC_EXTENSIONS
        assert ".ogg" in MUSIC_EXTENSIONS
        assert ".opus" in MUSIC_EXTENSIONS
        assert ".wav" in MUSIC_EXTENSIONS

    def test_video_not_in_music_extensions(self) -> None:
        """Test that video extensions are not in music extensions."""
        assert ".mkv" not in MUSIC_EXTENSIONS
        assert ".mp4" not in MUSIC_EXTENSIONS
        assert ".avi" not in MUSIC_EXTENSIONS


class TestIsMusicFile:
    """Tests for the is_music_file helper."""

    def test_is_music_file_true(self) -> None:
        """Test is_music_file returns True for music files."""
        assert is_music_file(Path("song.mp3")) is True
        assert is_music_file(Path("song.FLAC")) is True  # Case insensitive
        assert is_music_file(Path("song.M4A")) is True

    def test_is_music_file_false(self) -> None:
        """Test is_music_file returns False for non-music files."""
        assert is_music_file(Path("video.mkv")) is False
        assert is_music_file(Path("video.mp4")) is False


class TestCreateMusicParser:
    """Tests for the music parser factory."""

    def test_create_parser_with_mutagen(self) -> None:
        """Test creating parser with mutagen enabled."""
        parser = create_music_parser(use_mutagen=True)
        # Should return MutagenParser if mutagen is installed
        assert parser is not None
        assert hasattr(parser, "parse")
        assert hasattr(parser, "can_read")

    def test_create_parser_without_mutagen(self) -> None:
        """Test creating parser with mutagen disabled."""
        parser = create_music_parser(use_mutagen=False)
        assert isinstance(parser, MusicFilenameParser)
