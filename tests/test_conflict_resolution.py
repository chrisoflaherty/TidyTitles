"""Tests for conflict resolution."""

import tempfile
from pathlib import Path

import pytest

from file_renamer.core.conflict_resolution import (
    ConflictStrategy,
    find_available_path,
    resolve_conflict,
)


class TestFindAvailablePath:
    """Tests for find_available_path function."""

    def test_path_does_not_exist(self):
        """Test when path doesn't exist, returns original."""
        path = Path("/nonexistent/movie.mkv")
        result = find_available_path(path)
        assert result == path

    def test_path_exists_finds_version_1(self):
        """Test when path exists, finds (1) version."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)

            # Create existing file
            existing = tmpdir_path / "movie.mkv"
            existing.touch()

            # Find available path
            result = find_available_path(existing)

            assert result == tmpdir_path / "movie (1).mkv"
            assert not result.exists()

    def test_path_exists_finds_version_2(self):
        """Test when (1) also exists, finds (2)."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)

            # Create existing files
            (tmpdir_path / "movie.mkv").touch()
            (tmpdir_path / "movie (1).mkv").touch()

            # Find available path
            result = find_available_path(tmpdir_path / "movie.mkv")

            assert result == tmpdir_path / "movie (2).mkv"
            assert not result.exists()

    def test_preserves_extension(self):
        """Test that file extension is preserved."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)

            # Create existing file
            existing = tmpdir_path / "movie.mp4"
            existing.touch()

            # Find available path
            result = find_available_path(existing)

            assert result == tmpdir_path / "movie (1).mp4"
            assert result.suffix == ".mp4"

    def test_works_with_parentheses_in_name(self):
        """Test with parentheses already in filename."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)

            # Create existing file
            existing = tmpdir_path / "Movie (2024).mkv"
            existing.touch()

            # Find available path
            result = find_available_path(existing)

            assert result == tmpdir_path / "Movie (2024) (1).mkv"

    def test_max_attempts_exceeded(self):
        """Test RuntimeError when max attempts exceeded."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)

            # Create a file that exists
            existing = tmpdir_path / "movie.mkv"
            existing.touch()

            # Should raise error with max_attempts=0
            with pytest.raises(RuntimeError, match="Could not find available path"):
                find_available_path(existing, max_attempts=0)


class TestResolveConflict:
    """Tests for resolve_conflict function."""

    def test_skip_strategy_no_conflict(self):
        """Test SKIP strategy when no conflict exists."""
        path = Path("/nonexistent/movie.mkv")
        result_path, was_modified = resolve_conflict(path, ConflictStrategy.SKIP)

        assert result_path == path
        assert was_modified is False

    def test_skip_strategy_with_conflict(self):
        """Test SKIP strategy when conflict exists."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)
            existing = tmpdir_path / "movie.mkv"
            existing.touch()

            result_path, was_modified = resolve_conflict(
                existing, ConflictStrategy.SKIP
            )

            assert result_path == existing
            assert was_modified is False

    def test_overwrite_strategy_no_conflict(self):
        """Test OVERWRITE strategy when no conflict exists."""
        path = Path("/nonexistent/movie.mkv")
        result_path, was_modified = resolve_conflict(path, ConflictStrategy.OVERWRITE)

        assert result_path == path
        assert was_modified is False

    def test_overwrite_strategy_with_conflict(self):
        """Test OVERWRITE strategy when conflict exists."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)
            existing = tmpdir_path / "movie.mkv"
            existing.touch()

            result_path, was_modified = resolve_conflict(
                existing, ConflictStrategy.OVERWRITE
            )

            assert result_path == existing
            assert was_modified is False

    def test_auto_version_strategy_no_conflict(self):
        """Test AUTO_VERSION strategy when no conflict exists."""
        path = Path("/nonexistent/movie.mkv")
        result_path, was_modified = resolve_conflict(
            path, ConflictStrategy.AUTO_VERSION
        )

        assert result_path == path
        assert was_modified is False

    def test_auto_version_strategy_with_conflict(self):
        """Test AUTO_VERSION strategy when conflict exists."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)
            existing = tmpdir_path / "movie.mkv"
            existing.touch()

            result_path, was_modified = resolve_conflict(
                existing, ConflictStrategy.AUTO_VERSION
            )

            assert result_path == tmpdir_path / "movie (1).mkv"
            assert was_modified is True

    def test_auto_version_finds_next_available(self):
        """Test AUTO_VERSION finds next available version."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)

            # Create existing files
            (tmpdir_path / "movie.mkv").touch()
            (tmpdir_path / "movie (1).mkv").touch()
            (tmpdir_path / "movie (2).mkv").touch()

            result_path, was_modified = resolve_conflict(
                tmpdir_path / "movie.mkv", ConflictStrategy.AUTO_VERSION
            )

            assert result_path == tmpdir_path / "movie (3).mkv"
            assert was_modified is True


class TestConflictStrategy:
    """Tests for ConflictStrategy enum."""

    def test_strategy_values(self):
        """Test that strategy values match expected strings."""
        assert ConflictStrategy.SKIP.value == "skip"
        assert ConflictStrategy.OVERWRITE.value == "overwrite"
        assert ConflictStrategy.AUTO_VERSION.value == "auto_version"

    def test_strategy_from_string(self):
        """Test creating strategy from string value."""
        assert ConflictStrategy("skip") == ConflictStrategy.SKIP
        assert ConflictStrategy("overwrite") == ConflictStrategy.OVERWRITE
        assert ConflictStrategy("auto_version") == ConflictStrategy.AUTO_VERSION

    def test_invalid_strategy_raises_error(self):
        """Test that invalid strategy string raises ValueError."""
        with pytest.raises(ValueError):
            ConflictStrategy("invalid")
