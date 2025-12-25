"""Main rename service orchestrating the rename workflow."""

from pathlib import Path
from typing import Callable, Optional, Union

from file_renamer.core.models import (
    Episode,
    MediaFile,
    MediaType,
    Movie,
    RenameOperation,
)
from file_renamer.core.parser import FilenameParser
from file_renamer.core.renamer import FileRenamer
from file_renamer.core.template import TemplateEngine
from file_renamer.providers.base import MovieProvider, TVProvider


# Common video file extensions
VIDEO_EXTENSIONS = {
    ".mkv",
    ".mp4",
    ".avi",
    ".mov",
    ".wmv",
    ".flv",
    ".webm",
    ".m4v",
    ".mpg",
    ".mpeg",
    ".ts",
    ".m2ts",
}


class RenameService:
    """Main service orchestrating the rename workflow."""

    def __init__(
        self,
        parser: FilenameParser,
        movie_provider: MovieProvider,
        tv_provider: TVProvider,
        template_engine: TemplateEngine,
        file_renamer: Optional[FileRenamer] = None,
    ) -> None:
        """Initialize the rename service.

        Args:
            parser: Filename parser instance.
            movie_provider: Movie metadata provider.
            tv_provider: TV show metadata provider.
            template_engine: Template engine for generating filenames.
            file_renamer: File renamer instance.
        """
        self._parser = parser
        self._movie_provider = movie_provider
        self._tv_provider = tv_provider
        self._template = template_engine
        self._renamer = file_renamer or FileRenamer()

    def scan_directory(
        self,
        directory: Path,
        recursive: bool = False,
    ) -> list[Path]:
        """Scan a directory for video files.

        Args:
            directory: Directory to scan.
            recursive: If True, scan subdirectories.

        Returns:
            List of video file paths.
        """
        files: list[Path] = []

        if recursive:
            for ext in VIDEO_EXTENSIONS:
                files.extend(directory.rglob(f"*{ext}"))
        else:
            for ext in VIDEO_EXTENSIONS:
                files.extend(directory.glob(f"*{ext}"))

        return sorted(files)

    def parse_files(
        self,
        paths: list[Path],
        progress_callback: Optional[Callable[[int, int, str], None]] = None,
    ) -> list[MediaFile]:
        """Parse filenames to extract media information.

        Args:
            paths: List of file paths to parse.
            progress_callback: Optional progress callback.

        Returns:
            List of MediaFile objects.
        """
        media_files = []
        total = len(paths)

        for i, path in enumerate(paths):
            if progress_callback:
                progress_callback(i + 1, total, f"Parsing: {path.name}")

            parsed = self._parser.parse(path.name)
            media_files.append(MediaFile(path=path, parsed_info=parsed))

        return media_files

    async def fetch_metadata(
        self,
        media_files: list[MediaFile],
        force_type: Optional[MediaType] = None,
        progress_callback: Optional[Callable[[int, int, str], None]] = None,
    ) -> list[MediaFile]:
        """Fetch metadata for media files from external providers.

        Args:
            media_files: List of media files to process.
            force_type: If set, treat all files as this media type.
            progress_callback: Optional progress callback.

        Returns:
            List of MediaFile objects with matched metadata.
        """
        total = len(media_files)

        for i, media_file in enumerate(media_files):
            if progress_callback:
                progress_callback(
                    i + 1, total, f"Fetching: {media_file.parsed_info.title}"
                )

            media_type = force_type or media_file.parsed_info.media_type

            if media_type == MediaType.MOVIE:
                await self._fetch_movie_metadata(media_file)
            elif media_type == MediaType.TV_EPISODE:
                await self._fetch_tv_metadata(media_file)

        return media_files

    async def _fetch_movie_metadata(self, media_file: MediaFile) -> None:
        """Fetch movie metadata for a media file."""
        parsed = media_file.parsed_info
        movies = await self._movie_provider.search_movie(parsed.title, parsed.year)

        if movies:
            # Use the first (best) match
            media_file.matched_metadata = movies[0]

    async def _fetch_tv_metadata(self, media_file: MediaFile) -> None:
        """Fetch TV episode metadata for a media file."""
        parsed = media_file.parsed_info

        # Search for the show
        shows = await self._tv_provider.search_show(parsed.title, parsed.year)

        if shows and parsed.season is not None and parsed.episode is not None:
            # Get episode details
            episode = await self._tv_provider.get_episode(
                shows[0].id, parsed.season, parsed.episode
            )
            if episode:
                media_file.matched_metadata = episode

    def generate_preview(
        self,
        media_files: list[MediaFile],
        destination_dir: Optional[Path] = None,
    ) -> list[RenameOperation]:
        """Generate a preview of rename operations.

        Args:
            media_files: List of media files with metadata.
            destination_dir: Optional destination directory. If not set,
                files are renamed in place.

        Returns:
            List of RenameOperation objects.
        """
        operations = []

        for media_file in media_files:
            if not media_file.matched_metadata:
                continue

            # Build extra context from parsed info
            extra_context = {
                "quality": media_file.parsed_info.quality,
                "source": media_file.parsed_info.source,
                "codec": media_file.parsed_info.codec,
                "group": media_file.parsed_info.group,
            }

            # Generate new filename
            if isinstance(media_file.matched_metadata, Movie):
                new_name = self._template.render_movie(
                    media_file.matched_metadata,
                    media_file.extension,
                    extra_context,
                )
            elif isinstance(media_file.matched_metadata, Episode):
                new_name = self._template.render_episode(
                    media_file.matched_metadata,
                    media_file.extension,
                    extra_context,
                )
            else:
                continue

            # Determine destination path
            dest_dir = destination_dir or media_file.path.parent
            new_path = dest_dir / new_name

            operations.append(
                RenameOperation(
                    source=media_file.path,
                    destination=new_path,
                    media_file=media_file,
                )
            )

        return operations

    def execute_rename(
        self,
        operations: list[RenameOperation],
        progress_callback: Optional[Callable[[int, int, str], None]] = None,
    ) -> list[RenameOperation]:
        """Execute rename operations.

        Args:
            operations: List of operations to execute.
            progress_callback: Optional progress callback.

        Returns:
            List of operations with updated status.
        """
        return self._renamer.execute(operations, progress_callback)

    def undo_rename(
        self,
        operations: list[RenameOperation],
        progress_callback: Optional[Callable[[int, int, str], None]] = None,
    ) -> list[RenameOperation]:
        """Undo rename operations.

        Args:
            operations: List of operations to undo.
            progress_callback: Optional progress callback.

        Returns:
            List of operations with updated status.
        """
        return self._renamer.undo(operations, progress_callback)

    async def process_files(
        self,
        paths: list[Path],
        force_type: Optional[MediaType] = None,
        destination_dir: Optional[Path] = None,
        progress_callback: Optional[Callable[[int, int, str], None]] = None,
    ) -> list[RenameOperation]:
        """Process files end-to-end: parse, fetch metadata, generate preview.

        This is a convenience method that combines parse_files, fetch_metadata,
        and generate_preview.

        Args:
            paths: List of file paths to process.
            force_type: If set, treat all files as this media type.
            destination_dir: Optional destination directory.
            progress_callback: Optional progress callback.

        Returns:
            List of RenameOperation objects ready for execution.
        """
        # Parse filenames
        media_files = self.parse_files(paths, progress_callback)

        # Fetch metadata
        media_files = await self.fetch_metadata(
            media_files, force_type, progress_callback
        )

        # Generate preview
        return self.generate_preview(media_files, destination_dir)
