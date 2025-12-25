"""Tests for filename parser."""

import pytest

from file_renamer.core.models import MediaType
from file_renamer.core.parser import RegexParser, create_parser


class TestRegexParser:
    """Tests for the regex-based parser."""

    def test_parse_movie_with_year(self) -> None:
        """Test parsing a movie filename with year."""
        parser = RegexParser()
        result = parser.parse("The.Matrix.1999.1080p.BluRay.x264.mkv")

        assert result.title == "The Matrix"
        assert result.year == 1999
        assert result.media_type == MediaType.MOVIE
        assert result.quality == "1080p"
        assert result.source == "BluRay"

    def test_parse_movie_with_parentheses(self) -> None:
        """Test parsing a movie with year in parentheses."""
        parser = RegexParser()
        result = parser.parse("The Matrix (1999).mkv")

        assert result.title == "The Matrix"
        assert result.year == 1999
        assert result.media_type == MediaType.MOVIE

    def test_parse_tv_episode_sxxexx(self) -> None:
        """Test parsing a TV episode with S01E01 format."""
        parser = RegexParser()
        result = parser.parse("Breaking.Bad.S01E01.720p.HDTV.mkv")

        assert result.title == "Breaking Bad"
        assert result.season == 1
        assert result.episode == 1
        assert result.media_type == MediaType.TV_EPISODE

    def test_parse_tv_episode_xformat(self) -> None:
        """Test parsing a TV episode with 1x01 format."""
        parser = RegexParser()
        result = parser.parse("Breaking Bad 1x01.mkv")

        assert result.title == "Breaking Bad"
        assert result.season == 1
        assert result.episode == 1
        assert result.media_type == MediaType.TV_EPISODE

    def test_parse_unknown(self) -> None:
        """Test parsing an unrecognized filename."""
        parser = RegexParser()
        result = parser.parse("random_file.mkv")

        assert result.media_type == MediaType.UNKNOWN


class TestCreateParser:
    """Tests for the parser factory."""

    def test_create_parser_fallback(self) -> None:
        """Test creating parser with guessit disabled."""
        parser = create_parser(use_guessit=False)
        assert isinstance(parser, RegexParser)
