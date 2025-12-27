"""Template engine for generating filenames."""

import re
from typing import Any, Callable, Optional

from .exceptions import TemplateError
from .models import Episode, Movie, Track


class TemplateEngine:
    """Template engine for generating filenames from metadata.

    Supported placeholders:
        {title}          - Movie/show title
        {original_title} - Original language title
        {year}           - Release year
        {season}         - Season number
        {season2}        - Season number (2 digits, zero-padded)
        {episode}        - Episode number
        {episode2}       - Episode number (2 digits, zero-padded)
        {episode_title}  - Episode title
        {quality}        - Video quality (1080p, 720p, etc.)
        {source}         - Video source (BluRay, WEB-DL, etc.)
        {codec}          - Video codec
        {group}          - Release group
        {ext}            - File extension

    Formatters (pipe syntax):
        {title|lower}       - lowercase
        {title|upper}       - uppercase
        {title|title}       - title case
        {title|clean}       - remove invalid filename characters
        {season|pad:2}      - zero-pad to N digits
        {title|replace:_: } - replace underscores with spaces
    """

    DEFAULT_MOVIE_TEMPLATE = "{title} ({year})"
    DEFAULT_TV_TEMPLATE = "{title} - S{season2}E{episode2} - {episode_title}"
    DEFAULT_MUSIC_TEMPLATE = "{artist}/{album} ({year})/{track2} - {title}"

    PLACEHOLDER_PATTERN = re.compile(
        r"\{(?P<field>\w+)(?:\|(?P<formatter>\w+)(?::(?P<arg>[^}]+))?)?\}"
    )

    # Characters invalid in filenames on various OSes (excluding path separator)
    INVALID_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
    # Same but preserves forward slash for directory templates
    INVALID_CHARS_PRESERVE_SLASH = re.compile(r'[<>:"\\|?*\x00-\x1f]')

    FORMATTERS: dict[str, Callable[..., str]] = {
        "lower": lambda s: str(s).lower(),
        "upper": lambda s: str(s).upper(),
        "title": lambda s: str(s).title(),
        "clean": lambda s: TemplateEngine.INVALID_CHARS.sub("", str(s)),
        "pad": lambda s, n: str(s).zfill(int(n)),
        "replace": lambda s, old, new: str(s).replace(old, new),
    }

    VALID_FIELDS = {
        # Common fields
        "title",
        "original_title",
        "year",
        "ext",
        # Video fields
        "season",
        "season2",
        "episode",
        "episode2",
        "episode_title",
        "quality",
        "source",
        "codec",
        "group",
        # Music fields
        "artist",
        "album",
        "album_artist",
        "track",
        "track2",
        "disc",
        "disc2",
        "genre",
    }

    def __init__(
        self,
        movie_template: str = DEFAULT_MOVIE_TEMPLATE,
        tv_template: str = DEFAULT_TV_TEMPLATE,
        music_template: str = DEFAULT_MUSIC_TEMPLATE,
    ) -> None:
        """Initialize the template engine.

        Args:
            movie_template: Template for movie filenames.
            tv_template: Template for TV episode filenames.
            music_template: Template for music track filenames.
        """
        self.movie_template = movie_template
        self.tv_template = tv_template
        self.music_template = music_template

    def render(self, template: str, context: dict[str, Any]) -> str:
        """Render a template with the given context.

        Args:
            template: Template string with placeholders.
            context: Dictionary of values to substitute.

        Returns:
            Rendered string with placeholders replaced.
        """

        def replace_match(match: re.Match[str]) -> str:
            field = match.group("field")
            formatter = match.group("formatter")
            arg = match.group("arg")

            value = context.get(field)
            if value is None:
                return ""

            value = str(value)

            if formatter:
                if formatter == "pad" and arg:
                    value = self.FORMATTERS["pad"](value, arg)
                elif formatter == "replace" and arg:
                    parts = arg.split(":")
                    if len(parts) >= 2:
                        value = self.FORMATTERS["replace"](value, parts[0], parts[1])
                elif formatter in self.FORMATTERS:
                    value = self.FORMATTERS[formatter](value)

            return value

        return self.PLACEHOLDER_PATTERN.sub(replace_match, template)

    def render_movie(
        self,
        movie: Movie,
        extension: str = "",
        extra_context: Optional[dict[str, Any]] = None,
    ) -> str:
        """Generate a filename for a movie.

        Args:
            movie: Movie metadata.
            extension: File extension (with or without leading dot).
            extra_context: Additional context values (quality, source, etc.).

        Returns:
            Generated filename.
        """
        context: dict[str, Any] = {
            "title": movie.title,
            "original_title": movie.original_title,
            "year": movie.year,
            "ext": extension.lstrip(".") if extension else "",
        }

        if extra_context:
            context.update(extra_context)

        result = self.render(self.movie_template, context)

        # Clean invalid characters from each path component (preserve slashes)
        result = self._clean_path(result)

        if extension:
            ext = extension.lstrip(".")
            if not result.endswith(f".{ext}"):
                result += f".{ext}"

        return result

    def render_episode(
        self,
        episode: Episode,
        extension: str = "",
        extra_context: Optional[dict[str, Any]] = None,
    ) -> str:
        """Generate a filename for a TV episode.

        Args:
            episode: Episode metadata.
            extension: File extension (with or without leading dot).
            extra_context: Additional context values (quality, source, etc.).

        Returns:
            Generated filename.
        """
        context: dict[str, Any] = {
            "title": episode.show.title,
            "original_title": episode.show.original_title,
            "year": episode.show.year,
            "season": episode.season,
            "season2": str(episode.season).zfill(2),
            "episode": episode.episode,
            "episode2": str(episode.episode).zfill(2),
            "episode_title": episode.title,
            "ext": extension.lstrip(".") if extension else "",
        }

        if extra_context:
            context.update(extra_context)

        result = self.render(self.tv_template, context)

        # Clean invalid characters from each path component (preserve slashes)
        result = self._clean_path(result)

        if extension:
            ext = extension.lstrip(".")
            if not result.endswith(f".{ext}"):
                result += f".{ext}"

        return result

    def render_track(
        self,
        track: Track,
        extension: str = "",
        extra_context: Optional[dict[str, Any]] = None,
    ) -> str:
        """Generate a filename for a music track.

        Args:
            track: Track metadata.
            extension: File extension (with or without leading dot).
            extra_context: Additional context values.

        Returns:
            Generated filename (may include directory path).
        """
        context: dict[str, Any] = {
            "title": track.title,
            "artist": track.artist.name,
            "album": track.album.title if track.album else "",
            "album_artist": track.album.artist.name if track.album else track.artist.name,
            "year": track.album.year if track.album and track.album.year else "",
            "track": track.track_number or "",
            "track2": str(track.track_number or 0).zfill(2),
            "disc": track.disc_number or "",
            "disc2": str(track.disc_number or 1).zfill(2),
            "genre": track.genres[0] if track.genres else "",
            "ext": extension.lstrip(".") if extension else "",
        }

        if extra_context:
            context.update(extra_context)

        result = self.render(self.music_template, context)

        # Clean invalid characters from each path component (preserve slashes)
        result = self._clean_path(result)

        if extension:
            ext = extension.lstrip(".")
            if not result.endswith(f".{ext}"):
                result += f".{ext}"

        return result

    def _clean_path(self, path: str) -> str:
        """Clean invalid characters from a path while preserving directory structure.

        Args:
            path: Path string that may contain forward slashes.

        Returns:
            Cleaned path with invalid characters removed from each component.
        """
        if "/" not in path:
            # Simple case: no directories, clean entire string
            return self.INVALID_CHARS.sub("", path)

        # Split by forward slash, clean each component, rejoin
        parts = path.split("/")
        cleaned_parts = [self.INVALID_CHARS.sub("", part) for part in parts]
        # Remove empty parts (from leading/trailing/double slashes)
        cleaned_parts = [p for p in cleaned_parts if p]
        return "/".join(cleaned_parts)

    def validate_template(self, template: str) -> tuple[bool, list[str]]:
        """Validate a template string.

        Args:
            template: Template string to validate.

        Returns:
            Tuple of (is_valid, list of error messages).
        """
        errors: list[str] = []

        for match in self.PLACEHOLDER_PATTERN.finditer(template):
            field = match.group("field")
            formatter = match.group("formatter")

            if field not in self.VALID_FIELDS:
                errors.append(f"Unknown field: {{{field}}}")

            if formatter and formatter not in self.FORMATTERS:
                errors.append(f"Unknown formatter: {formatter}")

        # Check for unclosed braces
        open_count = template.count("{")
        close_count = template.count("}")
        if open_count != close_count:
            errors.append("Mismatched braces in template")

        return len(errors) == 0, errors

    @classmethod
    def get_available_fields(cls) -> dict[str, str]:
        """Get documentation for available template fields.

        Returns:
            Dictionary mapping field names to descriptions.
        """
        return {
            # Common
            "title": "Movie, TV show, or track title",
            "original_title": "Original language title",
            "year": "Release year",
            "ext": "File extension",
            # Video
            "season": "Season number",
            "season2": "Season number (2 digits, zero-padded)",
            "episode": "Episode number",
            "episode2": "Episode number (2 digits, zero-padded)",
            "episode_title": "Episode title",
            "quality": "Video quality (e.g., 1080p)",
            "source": "Video source (e.g., BluRay)",
            "codec": "Video codec (e.g., x264)",
            "group": "Release group",
            # Music
            "artist": "Track artist name",
            "album": "Album title",
            "album_artist": "Album artist (for compilations)",
            "track": "Track number",
            "track2": "Track number (2 digits, zero-padded)",
            "disc": "Disc number",
            "disc2": "Disc number (2 digits, zero-padded)",
            "genre": "Music genre",
        }

    @classmethod
    def get_available_formatters(cls) -> dict[str, str]:
        """Get documentation for available formatters.

        Returns:
            Dictionary mapping formatter names to descriptions.
        """
        return {
            "lower": "Convert to lowercase",
            "upper": "Convert to uppercase",
            "title": "Convert to title case",
            "clean": "Remove invalid filename characters",
            "pad:N": "Zero-pad to N digits",
            "replace:old:new": "Replace old with new",
        }
