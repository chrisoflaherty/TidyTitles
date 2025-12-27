"""Cover art download service."""

from pathlib import Path
from typing import Optional

import httpx

from file_renamer.core.models import (
    Album,
    Episode,
    Movie,
    RenameOperation,
    RenameStatus,
    Track,
    TVShow,
)


class CoverArtDownloader:
    """Service for downloading cover art for media files."""

    # TMDB image base URL
    TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p"

    # MusicBrainz Cover Art Archive base URL
    CAA_BASE = "https://coverartarchive.org"

    # Default image sizes
    TMDB_POSTER_SIZE = "w500"  # Options: w92, w154, w185, w342, w500, w780, original
    TMDB_ORIGINAL_SIZE = "original"

    def __init__(
        self,
        filename: str = "poster.jpg",
        music_filename: str = "cover.jpg",
        overwrite: bool = False,
        size: str = "w500",
    ) -> None:
        """Initialize the cover art downloader.

        Args:
            filename: Filename for movie/TV posters (default: poster.jpg).
            music_filename: Filename for album art (default: cover.jpg).
            overwrite: Whether to overwrite existing cover art.
            size: TMDB poster size (w92, w154, w185, w342, w500, w780, original).
        """
        self.filename = filename
        self.music_filename = music_filename
        self.overwrite = overwrite
        self.size = size

    async def download_for_movie(
        self,
        movie: Movie,
        destination_dir: Path,
    ) -> Optional[Path]:
        """Download poster for a movie.

        Args:
            movie: Movie metadata with poster_path.
            destination_dir: Directory to save the poster.

        Returns:
            Path to downloaded file, or None if failed.
        """
        if not movie.poster_path:
            return None

        url = f"{self.TMDB_IMAGE_BASE}/{self.size}{movie.poster_path}"
        dest_path = destination_dir / self.filename

        return await self._download(url, dest_path)

    async def download_for_episode(
        self,
        episode: Episode,
        destination_dir: Path,
    ) -> Optional[Path]:
        """Download poster for a TV episode (uses show poster).

        Args:
            episode: Episode metadata with show poster_path.
            destination_dir: Directory to save the poster.

        Returns:
            Path to downloaded file, or None if failed.
        """
        if not episode.show.poster_path:
            return None

        # Use show poster for episodes
        url = f"{self.TMDB_IMAGE_BASE}/{self.size}{episode.show.poster_path}"
        dest_path = destination_dir / self.filename

        return await self._download(url, dest_path)

    async def download_for_track(
        self,
        track: Track,
        destination_dir: Path,
    ) -> Optional[Path]:
        """Download album art for a music track.

        Args:
            track: Track metadata with album info.
            destination_dir: Directory to save the cover art.

        Returns:
            Path to downloaded file, or None if failed.
        """
        if not track.album:
            return None

        return await self.download_for_album(track.album, destination_dir)

    async def download_for_album(
        self,
        album: Album,
        destination_dir: Path,
    ) -> Optional[Path]:
        """Download cover art for an album.

        Args:
            album: Album metadata.
            destination_dir: Directory to save the cover art.

        Returns:
            Path to downloaded file, or None if failed.
        """
        # Try cover_art_url first if available
        if album.cover_art_url:
            dest_path = destination_dir / self.music_filename
            result = await self._download(album.cover_art_url, dest_path)
            if result:
                return result

        # Fall back to Cover Art Archive using MusicBrainz release ID
        if album.id and album.provider == "musicbrainz":
            url = f"{self.CAA_BASE}/release/{album.id}/front"
            dest_path = destination_dir / self.music_filename
            return await self._download(url, dest_path)

        return None

    async def _download(self, url: str, dest_path: Path) -> Optional[Path]:
        """Download an image from a URL.

        Args:
            url: URL to download from.
            dest_path: Destination path for the file.

        Returns:
            Path to downloaded file, or None if failed.
        """
        # Check if file exists and we shouldn't overwrite
        if dest_path.exists() and not self.overwrite:
            return dest_path  # Already exists, return existing path

        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
                response = await client.get(url)

                if response.status_code == 200:
                    # Ensure directory exists
                    dest_path.parent.mkdir(parents=True, exist_ok=True)

                    # Determine extension from content type if needed
                    content_type = response.headers.get("content-type", "")
                    if "jpeg" in content_type or "jpg" in content_type:
                        ext = ".jpg"
                    elif "png" in content_type:
                        ext = ".png"
                    elif "webp" in content_type:
                        ext = ".webp"
                    else:
                        ext = ".jpg"  # Default

                    # Update extension if different
                    if dest_path.suffix.lower() != ext:
                        dest_path = dest_path.with_suffix(ext)

                    # Write file
                    dest_path.write_bytes(response.content)
                    return dest_path

        except (httpx.HTTPError, OSError):
            pass

        return None

    async def download_for_metadata(
        self,
        metadata: Movie | Episode | Track,
        destination_dir: Path,
    ) -> Optional[Path]:
        """Download cover art based on metadata type.

        Args:
            metadata: Movie, Episode, or Track metadata.
            destination_dir: Directory to save the cover art.

        Returns:
            Path to downloaded file, or None if failed.
        """
        if isinstance(metadata, Movie):
            return await self.download_for_movie(metadata, destination_dir)
        elif isinstance(metadata, Episode):
            return await self.download_for_episode(metadata, destination_dir)
        elif isinstance(metadata, Track):
            return await self.download_for_track(metadata, destination_dir)
        return None

    async def download_for_operations(
        self,
        operations: list[RenameOperation],
        progress_callback: Optional[callable] = None,
    ) -> list[Path]:
        """Download cover art for completed rename operations.

        Args:
            operations: List of rename operations.
            progress_callback: Optional callback(current, total, message).

        Returns:
            List of paths to downloaded cover art files.
        """
        downloaded: list[Path] = []
        completed_ops = [op for op in operations if op.status == RenameStatus.COMPLETED]
        total = len(completed_ops)

        for i, op in enumerate(completed_ops):
            if progress_callback:
                progress_callback(i + 1, total, f"Downloading art: {op.destination.name}")

            metadata = op.media_file.matched_metadata
            if not metadata:
                continue

            # Use destination directory for cover art
            dest_dir = op.destination.parent

            result = await self.download_for_metadata(metadata, dest_dir)
            if result:
                downloaded.append(result)

        return downloaded
