"""Main rename service orchestrating the rename workflow."""

from dataclasses import replace
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
    ParsedMusicInfo,
    RenameOperation,
    RenameStatus,
    Track,
    TVShow,
    VerificationStatus,
    track_from_parsed_info,
)
from file_renamer.core.music_parser import MusicParser, create_music_parser, is_music_file
from file_renamer.core.parser import FilenameParser
from file_renamer.core.renamer import FileRenamer
from file_renamer.core.template import TemplateEngine
from file_renamer.providers.base import MovieProvider, MusicProvider, TVProvider
from file_renamer.services.config_service import AssociatedFilesSettings


# Type alias for selection callback
# Takes list of options and filename, returns selected index or None to skip
SelectionCallback = Callable[[list[Union[Movie, TVShow, Track]], str], Optional[int]]


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

# Common music file extensions
MUSIC_EXTENSIONS = {
    ".mp3",
    ".flac",
    ".m4a",
    ".ogg",
    ".opus",
    ".wav",
    ".aiff",
    ".wma",
    ".aac",
    ".ape",
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
        music_provider: Optional[MusicProvider] = None,
        music_parser: Optional[MusicParser] = None,
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
            music_provider: Optional music metadata provider.
            music_parser: Optional music file tag parser.
        """
        self._parser = parser
        self._movie_provider = movie_provider
        self._tv_provider = tv_provider
        self._template = template_engine
        self._renamer = file_renamer or FileRenamer()
        self._associated_files_settings = associated_files_settings or AssociatedFilesSettings()
        self._conflict_strategy = conflict_strategy
        self._selection_callback = selection_callback
        self._music_provider = music_provider
        self._music_parser = music_parser or create_music_parser()

    def scan_directory(
        self,
        directory: Path,
        recursive: bool = False,
        media_type: Optional[MediaType] = None,
    ) -> list[Path]:
        """Scan a directory for media files.

        Args:
            directory: Directory to scan.
            recursive: If True, scan subdirectories.
            media_type: If set, only scan for this media type. If None, scan for all.

        Returns:
            List of media file paths.
        """
        files: list[Path] = []

        # Determine which extensions to scan for
        if media_type == MediaType.MUSIC:
            extensions = MUSIC_EXTENSIONS
        elif media_type in (MediaType.MOVIE, MediaType.TV_EPISODE):
            extensions = VIDEO_EXTENSIONS
        else:
            # Scan for all media types
            extensions = VIDEO_EXTENSIONS | MUSIC_EXTENSIONS

        if recursive:
            for ext in extensions:
                files.extend(directory.rglob(f"*{ext}"))
        else:
            for ext in extensions:
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

            # For music files, also parse tags
            parsed_music = None
            if is_music_file(path):
                parsed_music = self._music_parser.parse(path)
                # Music files (by extension) should always be treated as music
                # regardless of what guessit thinks (it often misdetects "01 - Title" as TV episodes)
                parsed.media_type = MediaType.MUSIC

            media_files.append(
                MediaFile(path=path, parsed_info=parsed, parsed_music_info=parsed_music)
            )

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
            elif media_type == MediaType.MUSIC:
                await self._fetch_music_metadata(media_file)

        return media_files

    async def _fetch_movie_metadata(self, media_file: MediaFile) -> None:
        """Fetch movie metadata for a media file."""
        parsed = media_file.parsed_info
        movies = await self._movie_provider.search_movie(parsed.title, parsed.year)

        if not movies:
            return

        # If only one result, use it automatically
        if len(movies) == 1:
            media_file.matched_metadata = replace(
                movies[0], verification_status=VerificationStatus.AUTO_MATCHED
            )
            return

        # Multiple results - use selection callback if available
        if self._selection_callback:
            selected_index = self._selection_callback(movies, media_file.filename)
            if selected_index is not None and 0 <= selected_index < len(movies):
                media_file.matched_metadata = replace(
                    movies[selected_index],
                    verification_status=VerificationStatus.MANUAL_SELECTION,
                )
        else:
            # No callback - use first match (default behavior)
            media_file.matched_metadata = replace(
                movies[0], verification_status=VerificationStatus.AUTO_MATCHED
            )

    async def _fetch_tv_metadata(self, media_file: MediaFile) -> None:
        """Fetch TV episode metadata for a media file."""
        parsed = media_file.parsed_info

        # Search for the show
        shows = await self._tv_provider.search_show(parsed.title, parsed.year)

        if not shows or parsed.season is None or parsed.episode is None:
            return

        # Select the show (with callback if multiple results)
        selected_show = None
        user_selected = False
        if len(shows) == 1:
            selected_show = shows[0]
        elif self._selection_callback:
            selected_index = self._selection_callback(shows, media_file.filename)
            if selected_index is not None and 0 <= selected_index < len(shows):
                selected_show = shows[selected_index]
                user_selected = True
        else:
            # No callback - use first match (default behavior)
            selected_show = shows[0]

        if selected_show:
            # Get episode details
            episode = await self._tv_provider.get_episode(
                selected_show.id, parsed.season, parsed.episode
            )
            if episode:
                # Set verification status based on whether user made selection
                status = (
                    VerificationStatus.MANUAL_SELECTION
                    if user_selected
                    else VerificationStatus.AUTO_MATCHED
                )
                media_file.matched_metadata = replace(episode, verification_status=status)

    def _clean_title_for_search(self, title: str) -> str:
        """Clean a title for MusicBrainz search by removing featured artist suffixes."""
        import re
        # Remove featured artist suffixes: (feat. X), (with X), (ft. X), etc.
        cleaned = re.sub(
            r"\s*\((?:feat\.?|ft\.?|with|featuring)\s+[^)]+\)",
            "",
            title,
            flags=re.IGNORECASE,
        )
        return cleaned.strip()

    async def _fetch_music_metadata(self, media_file: MediaFile) -> None:
        """Fetch music metadata using tag-first approach with MusicBrainz verification.

        Flow:
        1. If tags are complete -> verify against MusicBrainz -> use tags with status
        2. If tags are incomplete -> search MusicBrainz -> present options
        """
        parsed = media_file.parsed_music_info
        if not parsed:
            return

        # Check if file tags are complete
        if parsed.is_complete():
            # Tags are complete - create Track from tags and verify against MusicBrainz
            if self._music_provider:
                try:
                    # Clean title for search (remove "(Feat. X)" etc.)
                    search_title = self._clean_title_for_search(parsed.title or "")

                    # Search MusicBrainz to verify the metadata exists
                    tracks = await self._music_provider.search_recording(
                        title=search_title,
                        artist=parsed.artist,
                        album=parsed.album,
                    )

                    # Check if any result is a close enough match
                    verified = self._verify_track_match(parsed, tracks)

                    if verified:
                        # Create Track from file tags, mark as VERIFIED
                        media_file.matched_metadata = track_from_parsed_info(
                            parsed,
                            VerificationStatus.VERIFIED,
                        )
                    else:
                        # Create Track from file tags, mark as UNVERIFIED
                        media_file.matched_metadata = track_from_parsed_info(
                            parsed,
                            VerificationStatus.UNVERIFIED,
                        )
                except Exception:
                    # Network error or other issue - use tags as unverified
                    media_file.matched_metadata = track_from_parsed_info(
                        parsed,
                        VerificationStatus.UNVERIFIED,
                    )
            else:
                # No provider available - use tags as unverified
                media_file.matched_metadata = track_from_parsed_info(
                    parsed,
                    VerificationStatus.UNVERIFIED,
                )
        else:
            # Tags are incomplete - use MusicBrainz search (original behavior)
            await self._fetch_music_metadata_from_provider(media_file)

    def _verify_track_match(
        self,
        parsed: ParsedMusicInfo,
        tracks: list[Track],
    ) -> bool:
        """Check if any MusicBrainz result matches the parsed tags.

        Uses fuzzy matching to account for slight variations in:
        - Punctuation and special characters
        - "The" prefix
        - Case differences
        - Featured artist suffixes like "(Feat. X)" or "(With X)"

        Args:
            parsed: Parsed music info from file tags.
            tracks: List of Track results from MusicBrainz.

        Returns:
            True if a match is found, False otherwise.
        """
        import re

        if not tracks:
            return False

        def normalize(text: str) -> str:
            """Normalize text for comparison."""
            text = text.lower().strip()
            # Remove featured artist suffixes: (feat. X), (with X), (ft. X), etc.
            text = re.sub(r"\s*\((?:feat\.?|ft\.?|with|featuring)\s+[^)]+\)", "", text, flags=re.IGNORECASE)
            text = re.sub(r"^the\s+", "", text)  # Remove leading "The "
            text = re.sub(r"[^\w\s]", "", text)  # Remove punctuation
            text = re.sub(r"\s+", " ", text)  # Normalize whitespace
            return text.strip()

        parsed_title = normalize(parsed.title or "")
        parsed_artist = normalize(parsed.artist or "")

        for track in tracks:
            track_title = normalize(track.title)
            track_artist = normalize(track.artist.name if track.artist else "")

            # Check if artist matches
            artist_match = parsed_artist == track_artist

            # Check if title matches (exact or one contains the other)
            title_match = (
                parsed_title == track_title
                or (parsed_title and track_title and parsed_title in track_title)
                or (parsed_title and track_title and track_title in parsed_title)
            )

            if title_match and artist_match:
                return True

        return False

    async def _fetch_music_metadata_from_provider(self, media_file: MediaFile) -> None:
        """Fetch music metadata from provider (for incomplete tags)."""
        if not self._music_provider:
            return

        parsed = media_file.parsed_music_info
        if not parsed:
            return

        title = parsed.title or ""
        artist = parsed.artist
        album = parsed.album

        if not title:
            return

        try:
            # Search for recordings
            tracks = await self._music_provider.search_recording(
                title=title,
                artist=artist,
                album=album,
            )
        except Exception:
            # Network error - create from partial tags if we have useful info
            if parsed.title:
                media_file.matched_metadata = track_from_parsed_info(
                    parsed,
                    VerificationStatus.UNVERIFIED,
                )
            return

        if not tracks:
            # No matches found - create Track from partial tags if we have title
            if parsed.title:
                media_file.matched_metadata = track_from_parsed_info(
                    parsed,
                    VerificationStatus.UNVERIFIED,
                )
            return

        # If only one result, use it automatically
        if len(tracks) == 1:
            tracks[0].verification_status = VerificationStatus.FROM_PROVIDER
            media_file.matched_metadata = tracks[0]
            return

        # Multiple results - use selection callback if available
        if self._selection_callback:
            selected_index = self._selection_callback(tracks, media_file.filename)
            if selected_index is not None and 0 <= selected_index < len(tracks):
                tracks[selected_index].verification_status = VerificationStatus.FROM_PROVIDER
                media_file.matched_metadata = tracks[selected_index]
        else:
            # No callback - use first match (default behavior)
            tracks[0].verification_status = VerificationStatus.FROM_PROVIDER
            media_file.matched_metadata = tracks[0]

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
            # If no metadata match found, create a skipped operation to keep the file visible
            if not media_file.matched_metadata:
                operations.append(
                    RenameOperation(
                        source=media_file.path,
                        destination=media_file.path,  # Keep original path
                        media_file=media_file,
                        status=RenameStatus.SKIPPED,
                        error_message="No metadata match found",
                    )
                )
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
            elif isinstance(media_file.matched_metadata, Track):
                track = media_file.matched_metadata
                # If MusicBrainz didn't provide track/disc number, use values from file tags
                if media_file.parsed_music_info:
                    if track.track_number is None and media_file.parsed_music_info.track_number:
                        track.track_number = media_file.parsed_music_info.track_number
                    if track.disc_number is None and media_file.parsed_music_info.disc_number:
                        track.disc_number = media_file.parsed_music_info.disc_number
                new_name = self._template.render_track(
                    track,
                    media_file.extension,
                    extra_context,
                )
            else:
                # Unknown metadata type, create skipped operation
                operations.append(
                    RenameOperation(
                        source=media_file.path,
                        destination=media_file.path,
                        media_file=media_file,
                        status=RenameStatus.SKIPPED,
                        error_message="Unknown metadata type",
                    )
                )
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
                        # Always place associated files in same directory as main file
                        # This handles both destination_dir and directory templates
                        assoc_dest = new_path.parent / assoc_dest.name

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
