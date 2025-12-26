"""Conflict resolution strategies for file renaming."""

from enum import Enum
from pathlib import Path


class ConflictStrategy(Enum):
    """Strategy for handling filename conflicts."""

    SKIP = "skip"  # Skip files that would overwrite
    OVERWRITE = "overwrite"  # Overwrite existing files
    AUTO_VERSION = "auto_version"  # Auto-increment version numbers


def find_available_path(path: Path, max_attempts: int = 1000) -> Path:
    """Find an available path by auto-incrementing version numbers.

    If the path exists, tries appending (1), (2), (3), etc. before the extension
    until an available path is found.

    Args:
        path: Desired file path.
        max_attempts: Maximum number of versions to try.

    Returns:
        Available path (may be the original if it doesn't exist).

    Raises:
        RuntimeError: If no available path found within max_attempts.

    Examples:
        >>> find_available_path(Path("/movies/Movie (2024).mkv"))
        Path("/movies/Movie (2024) (1).mkv")  # if original exists

        >>> find_available_path(Path("/movies/Movie.mkv"))
        Path("/movies/Movie (1).mkv")  # if original exists
    """
    if not path.exists():
        return path

    # Extract components
    parent = path.parent
    stem = path.stem
    suffix = path.suffix

    # Try incrementing versions
    for version in range(1, max_attempts + 1):
        versioned_name = f"{stem} ({version}){suffix}"
        versioned_path = parent / versioned_name

        if not versioned_path.exists():
            return versioned_path

    raise RuntimeError(
        f"Could not find available path after {max_attempts} attempts: {path}"
    )


def resolve_conflict(
    destination: Path,
    strategy: ConflictStrategy,
) -> tuple[Path, bool]:
    """Resolve a filename conflict using the specified strategy.

    Args:
        destination: Desired destination path.
        strategy: Conflict resolution strategy.

    Returns:
        Tuple of (resolved_path, was_modified).
        - resolved_path: The path to use (may be modified for auto-versioning)
        - was_modified: True if the path was changed from the original

    Examples:
        >>> resolve_conflict(Path("/movies/Movie.mkv"), ConflictStrategy.SKIP)
        (Path("/movies/Movie.mkv"), False)

        >>> resolve_conflict(Path("/movies/Movie.mkv"), ConflictStrategy.AUTO_VERSION)
        (Path("/movies/Movie (1).mkv"), True)  # if original exists
    """
    if not destination.exists():
        return destination, False

    if strategy == ConflictStrategy.SKIP:
        # Return original path, caller will skip this operation
        return destination, False

    elif strategy == ConflictStrategy.OVERWRITE:
        # Return original path, caller will overwrite
        return destination, False

    elif strategy == ConflictStrategy.AUTO_VERSION:
        # Find available versioned path
        new_path = find_available_path(destination)
        was_modified = new_path != destination
        return new_path, was_modified

    else:
        raise ValueError(f"Unknown conflict strategy: {strategy}")


def preview_conflicts(
    operations: list,
) -> dict[str, list]:
    """Preview which operations will have conflicts.

    Args:
        operations: List of RenameOperation objects.

    Returns:
        Dictionary with conflict information:
        - 'will_overwrite': List of operations that will overwrite existing files
        - 'no_conflict': List of operations without conflicts
    """
    conflicts = {
        "will_overwrite": [],
        "no_conflict": [],
    }

    for op in operations:
        if op.will_overwrite:
            conflicts["will_overwrite"].append(op)
        else:
            conflicts["no_conflict"].append(op)

    return conflicts
