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
    original_media_stem: str | None = None,
) -> Path:
    """Generate destination path for an associated file.

    Args:
        original_path: Original path of the associated file.
        new_base_name: New base name (without extension) for the media file.
        original_media_stem: Original media file's stem (without extension).
            If provided, used to accurately detect language codes.

    Returns:
        New path for the associated file.
    """
    parent = original_path.parent
    ext = original_path.suffix
    stem = original_path.stem

    suffix_part = None

    if original_media_stem:
        # If we know the original video's stem, extract suffix after it
        # e.g., "Movie.Name.en" with original_media_stem "Movie.Name" -> suffix "en"
        if stem.startswith(f"{original_media_stem}."):
            suffix_part = stem[len(original_media_stem) + 1:]
    else:
        # Fallback: check if stem ends with a short language code pattern
        # Split from the right to find potential language code (e.g., "movie.en")
        if "." in stem:
            last_dot_idx = stem.rfind(".")
            potential_lang = stem[last_dot_idx + 1:]
            # Language codes are typically 2-3 chars (en, es, fra, eng, etc.)
            if len(potential_lang) <= 4 and potential_lang.isalpha():
                suffix_part = potential_lang

    if suffix_part:
        new_name = f"{new_base_name}.{suffix_part}{ext}"
    else:
        new_name = f"{new_base_name}{ext}"

    return parent / new_name
