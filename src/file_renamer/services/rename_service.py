"""Main rename service orchestrating the rename workflow."""

from pathlib import Path
from typing import Callable, Optional, Union

from file_renamer.core.associated_files import (
    find_associated_files,
    generate_associated_destination,
    get_extensions_from_settings,
)
from file_renamer.core.conflict_resolution import (
    ConflictStrategy,
    resolve_conflict,
)
from file_renamer.core.models import (
    AssociatedFileRename,
    Episode,
    MediaFile,
    MediaType,
    Movie,
    RenameOperation,
    TVShow,
)
from file_renamer.core.parser import FilenameParser
from file_renamer.core.renamer import FileRenamer
from file_renamer.core.template import TemplateEngine
from file_renamer.providers.base import MovieProvider, TVProvider
from file_renamer.services.config_service import AssociatedFilesSettings


# Type alias for selection callback
# Takes list of options and filename, returns selected index or None to skip
SelectionCallback = Callable[[list[Union[Movie, TVShow]], str], Optional[int]]


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
        associated_files_settings: Optional[AssociatedFilesSettings] = None,
        conflict_strategy: ConflictStrategy = ConflictStrategy.SKIP,
        selection_callback: Optional[SelectionCallback] = None,
    ) -> None:
        """Initialize the rename service.

        Args:
            parser: Filename parser instance.
            movie_provider: Movie metadata provider.
            tv_provider: TV show metadata provider.
            template_engine: Template engine for generating filenames.
            file_renamer: File renamer instance.
            associated_files_settings: Settings for associated file handling.
            conflict_strategy: Strategy for resolving filename conflicts.
            selection_callback: Optional callback for selecting from multiple search results.
        """
        self._parser = parser
        self._movie_provider = movie_provider
        self._tv_provider = tv_provider
        self._template = template_engine
        self._renamer = file_renamer or FileRenamer()
        self._associated_files_settings = associated_files_settings or AssociatedFilesSettings()
        self._conflict_strategy = conflict_strategy
        self._selection_callback = selection_callback

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

        if not movies:
            return

        # If only one result, use it automatically
        if len(movies) == 1:
            media_file.matched_metadata = movies[0]
            return

        # Multiple results - use selection callback if available
        if self._selection_callback:
            selected_index = self._selection_callback(movies, media_file.filename)
            if selected_index is not None and 0 <= selected_index < len(movies):
                media_file.matched_metadata = movies[selected_index]
        else:
            # No callback - use first match (default behavior)
            media_file.matched_metadata = movies[0]

    async def _fetch_tv_metadata(self, media_file: MediaFile) -> None:
        """Fetch TV episode metadata for a media file."""
        parsed = media_file.parsed_info

        # Search for the show
        shows = await self._tv_provider.search_show(parsed.title, parsed.year)

        if not shows or parsed.season is None or parsed.episode is None:
            return

        # Select the show (with callback if multiple results)
        selected_show = None
        if len(shows) == 1:
            selected_show = shows[0]
        elif self._selection_callback:
            selected_index = self._selection_callback(shows, media_file.filename)
            if selected_index is not None and 0 <= selected_index < len(shows):
                selected_show = shows[selected_index]
        else:
            # No callback - use first match (default behavior)
            selected_show = shows[0]

        if selected_show:
            # Get episode details
            episode = await self._tv_provider.get_episode(
                selected_show.id, parsed.season, parsed.episode
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

            # Apply conflict resolution to main file
            new_path, was_versioned = resolve_conflict(new_path, self._conflict_strategy)

            # Find associated files (subtitles, nfo, images, etc.)
            associated_renames = []
            if self._associated_files_settings.enabled:
                # Build extension set based on settings
                extensions = get_extensions_from_settings(
                    include_subtitles=self._associated_files_settings.subtitles,
                    include_nfo=self._associated_files_settings.nfo,
                    include_images=self._associated_files_settings.images,
                )

                if extensions:  # Only search if at least one type is enabled
                    associated_files = find_associated_files(media_file.path, extensions)

                    # Generate destination paths for associated files
                    # Use the potentially versioned base name from the main file
                    new_base_name = new_path.stem  # Base name without extension
                    original_media_stem = media_file.path.stem
                    for assoc_file in associated_files:
                        assoc_dest = generate_associated_destination(
                            assoc_file.path, new_base_name, original_media_stem
                        )
                        # Use destination_dir if specified
                        if destination_dir:
                            assoc_dest = destination_dir / assoc_dest.name

                        # Apply conflict resolution to associated files
                        assoc_dest, _ = resolve_conflict(assoc_dest, self._conflict_strategy)

                        associated_renames.append(
                            AssociatedFileRename(
                                source=assoc_file.path,
                                destination=assoc_dest,
                                file_type=assoc_file.file_type,
                            )
                        )

            operations.append(
                RenameOperation(
                    source=media_file.path,
                    destination=new_path,
                    media_file=media_file,
                    associated_files=associated_renames,
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
