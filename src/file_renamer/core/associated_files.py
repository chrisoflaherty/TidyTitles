"""Associated file detection and handling."""

from dataclasses import dataclass
from pathlib import Path


# File extensions for different associated file types
SUBTITLE_EXTENSIONS = {".srt", ".vtt", ".ass", ".ssa", ".sub", ".idx"}
NFO_EXTENSIONS = {".nfo"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tbn"}
SAMPLE_PATTERNS = {"sample", "trailer", "preview"}


@dataclass
class AssociatedFile:
    """Represents a file associated with a media file."""

    path: Path
    file_type: str  # "subtitle", "nfo", "image", "other"

    @property
    def extension(self) -> str:
        """Get the file extension."""
        return self.path.suffix.lower()

    @property
    def name(self) -> str:
        """Get the filename."""
        return self.path.name


def get_file_type(path: Path) -> str:
    """Determine the type of associated file.

    Args:
        path: Path to the file.

    Returns:
        File type: "subtitle", "nfo", "image", or "other".
    """
    ext = path.suffix.lower()

    if ext in SUBTITLE_EXTENSIONS:
        return "subtitle"
    elif ext in NFO_EXTENSIONS:
        return "nfo"
    elif ext in IMAGE_EXTENSIONS:
        return "image"
    else:
        return "other"


def get_extensions_from_settings(
    include_subtitles: bool = True,
    include_nfo: bool = True,
    include_images: bool = True,
) -> set[str]:
    """Get file extensions to search for based on settings.

    Args:
        include_subtitles: Include subtitle extensions.
        include_nfo: Include NFO extensions.
        include_images: Include image extensions.

    Returns:
        Set of file extensions to search for.
    """
    extensions: set[str] = set()

    if include_subtitles:
        extensions |= SUBTITLE_EXTENSIONS
    if include_nfo:
        extensions |= NFO_EXTENSIONS
    if include_images:
        extensions |= IMAGE_EXTENSIONS

    return extensions


def find_associated_files(
    media_path: Path,
    extensions: set[str] | None = None,
) -> list[AssociatedFile]:
    """Find files associated with a media file.

    Associated files are those in the same directory with the same base name
    but different extensions (e.g., movie.mkv and movie.srt).

    Args:
        media_path: Path to the media file.
        extensions: Set of extensions to look for. If None, uses defaults.

    Returns:
        List of associated files found.
    """
    if extensions is None:
        extensions = SUBTITLE_EXTENSIONS | NFO_EXTENSIONS | IMAGE_EXTENSIONS

    # Get the base name without extension
    base_name = media_path.stem
    parent_dir = media_path.parent

    associated = []

    # Look for files with same base name
    for ext in extensions:
        potential_file = parent_dir / f"{base_name}{ext}"
        if potential_file.exists() and potential_file != media_path:
            file_type = get_file_type(potential_file)
            associated.append(AssociatedFile(path=potential_file, file_type=file_type))

    # Also look for language-specific subtitles (e.g., movie.en.srt, movie.es.srt)
    if parent_dir.exists():
        for file in parent_dir.iterdir():
            if file == media_path or file in [a.path for a in associated]:
                continue

            # Check if it matches pattern: base_name.*.ext
            if file.stem.startswith(f"{base_name}."):
                ext = file.suffix.lower()
                if ext in extensions:
                    file_type = get_file_type(file)
                    associated.append(AssociatedFile(path=file, file_type=file_type))

    return associated


def generate_associated_destination(
    original_path: Path,
    new_base_name: str,
) -> Path:
    """Generate destination path for an associated file.

    Args:
        original_path: Original path of the associated file.
        new_base_name: New base name (without extension) for the media file.

    Returns:
        New path for the associated file.
    """
    parent = original_path.parent
    ext = original_path.suffix

    # Check for language-specific subtitle pattern (e.g., movie.en.srt)
    stem = original_path.stem
    # Split on first dot to check for language code
    parts = stem.split(".", 1)

    if len(parts) == 2:
        # Has something after the base name (might be language code)
        suffix_part = parts[1]
        # Keep the suffix part (e.g., "en" from "movie.en.srt")
        new_name = f"{new_base_name}.{suffix_part}{ext}"
    else:
        # Simple case: just base name + extension
        new_name = f"{new_base_name}{ext}"

    return parent / new_name
