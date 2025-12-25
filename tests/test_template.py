"""Tests for template engine."""

import pytest

from file_renamer.core.models import Episode, Movie, TVShow
from file_renamer.core.template import TemplateEngine


class TestTemplateEngine:
    """Tests for the template engine."""

    def test_render_simple(self) -> None:
        """Test simple placeholder rendering."""
        engine = TemplateEngine()
        result = engine.render("{title} ({year})", {"title": "Test", "year": 2024})
        assert result == "Test (2024)"

    def test_render_missing_field(self) -> None:
        """Test rendering with missing field."""
        engine = TemplateEngine()
        result = engine.render("{title} ({year})", {"title": "Test"})
        assert result == "Test ()"

    def test_render_with_formatter_lower(self) -> None:
        """Test lowercase formatter."""
        engine = TemplateEngine()
        result = engine.render("{title|lower}", {"title": "THE MATRIX"})
        assert result == "the matrix"

    def test_render_with_formatter_upper(self) -> None:
        """Test uppercase formatter."""
        engine = TemplateEngine()
        result = engine.render("{title|upper}", {"title": "test"})
        assert result == "TEST"

    def test_render_with_formatter_pad(self) -> None:
        """Test pad formatter."""
        engine = TemplateEngine()
        result = engine.render("{episode|pad:3}", {"episode": 5})
        assert result == "005"

    def test_render_movie(self, sample_movie: Movie) -> None:
        """Test rendering a movie filename."""
        engine = TemplateEngine(movie_template="{title} ({year})")
        result = engine.render_movie(sample_movie, ".mkv")
        assert result == "The Matrix (1999).mkv"

    def test_render_episode(self, sample_episode: Episode) -> None:
        """Test rendering an episode filename."""
        engine = TemplateEngine(
            tv_template="{title} - S{season2}E{episode2} - {episode_title}"
        )
        result = engine.render_episode(sample_episode, ".mkv")
        assert result == "Breaking Bad - S01E01 - Pilot.mkv"

    def test_validate_valid_template(self) -> None:
        """Test validation of a valid template."""
        engine = TemplateEngine()
        is_valid, errors = engine.validate_template("{title} ({year})")
        assert is_valid
        assert len(errors) == 0

    def test_validate_invalid_field(self) -> None:
        """Test validation catches unknown fields."""
        engine = TemplateEngine()
        is_valid, errors = engine.validate_template("{invalid_field}")
        assert not is_valid
        assert len(errors) == 1

    def test_validate_invalid_formatter(self) -> None:
        """Test validation catches unknown formatters."""
        engine = TemplateEngine()
        is_valid, errors = engine.validate_template("{title|invalid}")
        assert not is_valid
        assert len(errors) == 1

    def test_clean_formatter_removes_invalid_chars(self) -> None:
        """Test clean formatter removes invalid filename characters."""
        engine = TemplateEngine()
        result = engine.render("{title|clean}", {"title": 'Test: A/B "Movie"'})
        assert result == "Test AB Movie"
