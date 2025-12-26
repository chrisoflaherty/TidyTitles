"""File renaming operations."""

import shutil
from pathlib import Path
from typing import Callable, Optional

from .exceptions import RenameError
from .models import AssociatedFileRename, RenameOperation, RenameStatus


class FileRenamer:
    """Handles file renaming operations."""

    def __init__(
        self,
        dry_run: bool = False,
        overwrite: bool = False,
    ) -> None:
        """Initialize the file renamer.

        Args:
            dry_run: If True, don't actually rename files.
            overwrite: If True, overwrite existing files.
        """
        self.dry_run = dry_run
        self.overwrite = overwrite

    def rename(
        self,
        source: Path,
        destination: Path,
    ) -> None:
        """Rename a single file.

        Args:
            source: Source file path.
            destination: Destination file path.

        Raises:
            RenameError: If rename fails.
        """
        if not source.exists():
            raise RenameError(f"Source file does not exist: {source}")

        if destination.exists() and not self.overwrite:
            raise RenameError(f"Destination already exists: {destination}")

        if self.dry_run:
            return

        # Create destination directory if needed
        destination.parent.mkdir(parents=True, exist_ok=True)

        try:
            source.rename(destination)
        except OSError as e:
            # If rename fails (e.g., cross-device), try copy + delete
            try:
                shutil.copy2(source, destination)
                source.unlink()
            except OSError as copy_error:
                raise RenameError(f"Failed to rename file: {copy_error}") from e

    def _rename_associated_files(
        self,
        associated: list[AssociatedFileRename],
    ) -> list[str]:
        """Rename associated files.

        Args:
            associated: List of associated file rename operations.

        Returns:
            List of error messages (empty if all successful).
        """
        errors = []

        for assoc in associated:
            try:
                self.rename(assoc.source, assoc.destination)
            except RenameError as e:
                errors.append(f"{assoc.source.name}: {e}")

        return errors

    def execute(
        self,
        operations: list[RenameOperation],
        progress_callback: Optional[Callable[[int, int, str], None]] = None,
    ) -> list[RenameOperation]:
        """Execute a batch of rename operations.

        Args:
            operations: List of rename operations to execute.
            progress_callback: Optional callback for progress updates.
                Receives (current, total, message).

        Returns:
            List of operations with updated status.
        """
        total = len(operations)

        for i, op in enumerate(operations):
            if progress_callback:
                progress_callback(i + 1, total, f"Renaming: {op.source.name}")

            if op.status != RenameStatus.PENDING:
                continue

            # Skip if source and destination are the same
            if op.source == op.destination:
                op.status = RenameStatus.SKIPPED
                op.error_message = "Source and destination are the same"
                continue

            # Check for conflicts
            if op.will_overwrite and not self.overwrite:
                op.status = RenameStatus.SKIPPED
                op.error_message = "Would overwrite existing file"
                continue

            try:
                # Rename the main file
                self.rename(op.source, op.destination)

                # Rename associated files (subtitles, nfo, etc.)
                if op.associated_files:
                    assoc_errors = self._rename_associated_files(op.associated_files)
                    if assoc_errors:
                        # Main file succeeded but some associated files failed
                        op.error_message = f"Associated files: {'; '.join(assoc_errors)}"

                op.status = RenameStatus.COMPLETED
            except RenameError as e:
                op.status = RenameStatus.FAILED
                op.error_message = str(e)

        return operations

    def undo(
        self,
        operations: list[RenameOperation],
        progress_callback: Optional[Callable[[int, int, str], None]] = None,
    ) -> list[RenameOperation]:
        """Undo a batch of rename operations.

        Only undoes completed operations.

        Args:
            operations: List of operations to undo.
            progress_callback: Optional callback for progress updates.

        Returns:
            List of operations with updated status.
        """
        total = len(operations)

        # Process in reverse order
        for i, op in enumerate(reversed(operations)):
            if progress_callback:
                progress_callback(i + 1, total, f"Undoing: {op.destination.name}")

            if op.status != RenameStatus.COMPLETED:
                continue

            try:
                # Undo associated files first (in reverse order)
                if op.associated_files:
                    for assoc in reversed(op.associated_files):
                        self.rename(assoc.destination, assoc.source)

                # Swap source and destination for undo
                self.rename(op.destination, op.source)
                op.status = RenameStatus.PENDING
            except RenameError as e:
                op.error_message = f"Undo failed: {e}"

        return operations
