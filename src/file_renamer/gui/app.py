"""Main application window."""

import asyncio
from pathlib import Path
from typing import Optional

from PySide6.QtCore import QThread, Signal, Qt, QTimer
from PySide6.QtWidgets import (
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QProgressDialog,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from file_renamer.core.conflict_resolution import ConflictStrategy
from file_renamer.core.models import MediaType, RenameOperation, RenameStatus
from file_renamer.core.parser import create_parser
from file_renamer.core.renamer import FileRenamer
from file_renamer.core.template import TemplateEngine
from file_renamer.providers.cache import APICache
from file_renamer.providers.tmdb import TMDBClient
from file_renamer.providers.tvdb import TVDBClient
from file_renamer.services.config_service import ConfigService
from file_renamer.services.rename_service import RenameService


class DummyMovieProvider:
    """Dummy movie provider when TMDB is not configured."""

    async def search_movie(self, title: str, year: Optional[int] = None) -> list:
        return []

    async def get_movie(self, movie_id: int):
        return None


class DummyTVProvider:
    """Dummy TV provider when TVDB is not configured."""

    async def search_show(self, title: str, year: Optional[int] = None) -> list:
        return []

    async def get_show(self, show_id: int):
        return None

    async def get_episode(self, show_id: int, season: int, episode: int):
        return None


class SettingsDialog(QDialog):
    """Dialog for editing application settings including templates."""

    # Sample data for live preview
    SAMPLE_MOVIE = {
        "title": "The Matrix",
        "year": 1999,
        "quality": "1080p",
        "source": "BluRay",
    }
    SAMPLE_TV = {
        "title": "Breaking Bad",
        "year": 2008,
        "season": 1,
        "season2": "01",
        "episode": 1,
        "episode2": "01",
        "episode_title": "Pilot",
        "quality": "720p",
        "source": "HDTV",
    }

    def __init__(self, config: "ConfigService", parent=None) -> None:
        super().__init__(parent)
        self.config = config
        self.template_engine = TemplateEngine()

        self.setWindowTitle("Settings")
        self.setMinimumWidth(500)
        self._setup_ui()
        self._load_settings()

    def _setup_ui(self) -> None:
        """Set up the dialog UI."""
        layout = QVBoxLayout(self)

        # Movie template section
        movie_group = QGroupBox("Movie Template")
        movie_layout = QVBoxLayout(movie_group)

        self.movie_input = QLineEdit()
        self.movie_input.textChanged.connect(self._update_movie_preview)
        movie_layout.addWidget(self.movie_input)

        self.movie_preview = QLabel()
        self.movie_preview.setStyleSheet("color: gray; font-style: italic;")
        movie_layout.addWidget(self.movie_preview)

        self.movie_error = QLabel()
        self.movie_error.setStyleSheet("color: red;")
        self.movie_error.hide()
        movie_layout.addWidget(self.movie_error)

        layout.addWidget(movie_group)

        # TV template section
        tv_group = QGroupBox("TV Show Template")
        tv_layout = QVBoxLayout(tv_group)

        self.tv_input = QLineEdit()
        self.tv_input.textChanged.connect(self._update_tv_preview)
        tv_layout.addWidget(self.tv_input)

        self.tv_preview = QLabel()
        self.tv_preview.setStyleSheet("color: gray; font-style: italic;")
        tv_layout.addWidget(self.tv_preview)

        self.tv_error = QLabel()
        self.tv_error.setStyleSheet("color: red;")
        self.tv_error.hide()
        tv_layout.addWidget(self.tv_error)

        layout.addWidget(tv_group)

        # API Keys section
        api_group = QGroupBox("API Keys")
        api_layout = QFormLayout(api_group)

        # TMDB Key
        tmdb_row = QHBoxLayout()
        self.tmdb_input = QLineEdit()
        self.tmdb_input.setEchoMode(QLineEdit.EchoMode.Password)
        self.tmdb_input.setPlaceholderText("Enter TMDB API key")
        tmdb_row.addWidget(self.tmdb_input)
        self.tmdb_show_btn = QPushButton("Show")
        self.tmdb_show_btn.setFixedWidth(50)
        self.tmdb_show_btn.clicked.connect(lambda: self._toggle_password(self.tmdb_input, self.tmdb_show_btn))
        tmdb_row.addWidget(self.tmdb_show_btn)
        api_layout.addRow("TMDB:", tmdb_row)

        # TVDB Key
        tvdb_row = QHBoxLayout()
        self.tvdb_input = QLineEdit()
        self.tvdb_input.setEchoMode(QLineEdit.EchoMode.Password)
        self.tvdb_input.setPlaceholderText("Enter TVDB API key")
        tvdb_row.addWidget(self.tvdb_input)
        self.tvdb_show_btn = QPushButton("Show")
        self.tvdb_show_btn.setFixedWidth(50)
        self.tvdb_show_btn.clicked.connect(lambda: self._toggle_password(self.tvdb_input, self.tvdb_show_btn))
        tvdb_row.addWidget(self.tvdb_show_btn)
        api_layout.addRow("TVDB:", tvdb_row)

        # TVDB PIN
        tvdb_pin_row = QHBoxLayout()
        self.tvdb_pin_input = QLineEdit()
        self.tvdb_pin_input.setEchoMode(QLineEdit.EchoMode.Password)
        self.tvdb_pin_input.setPlaceholderText("Optional")
        tvdb_pin_row.addWidget(self.tvdb_pin_input)
        self.tvdb_pin_show_btn = QPushButton("Show")
        self.tvdb_pin_show_btn.setFixedWidth(50)
        self.tvdb_pin_show_btn.clicked.connect(lambda: self._toggle_password(self.tvdb_pin_input, self.tvdb_pin_show_btn))
        tvdb_pin_row.addWidget(self.tvdb_pin_show_btn)
        api_layout.addRow("TVDB PIN:", tvdb_pin_row)

        layout.addWidget(api_group)

        # Placeholders reference
        placeholders_group = QGroupBox("Available Placeholders")
        placeholders_layout = QVBoxLayout(placeholders_group)

        placeholders_text = QLabel(
            "<b>Common:</b> {title}, {year}, {quality}, {source}<br>"
            "<b>TV Only:</b> {season}, {season2}, {episode}, {episode2}, {episode_title}<br>"
            "<b>Formatters:</b> {title|lower}, {title|upper}, {episode|pad:3}"
        )
        placeholders_text.setWordWrap(True)
        placeholders_layout.addWidget(placeholders_text)

        layout.addWidget(placeholders_group)

        # Buttons
        button_box = QDialogButtonBox(
            QDialogButtonBox.Save | QDialogButtonBox.Cancel
        )
        button_box.accepted.connect(self._save_settings)
        button_box.rejected.connect(self.reject)
        layout.addWidget(button_box)

    def _load_settings(self) -> None:
        """Load current settings into the dialog."""
        settings = self.config.settings
        self.movie_input.setText(settings.templates.movie)
        self.tv_input.setText(settings.templates.tv)
        self._update_movie_preview()
        self._update_tv_preview()

        # Load API keys
        self.tmdb_input.setText(settings.api.tmdb_api_key)
        self.tvdb_input.setText(settings.api.tvdb_api_key)
        self.tvdb_pin_input.setText(settings.api.tvdb_pin)

    def _update_movie_preview(self) -> None:
        """Update movie template preview."""
        template = self.movie_input.text()

        # Validate
        is_valid, errors = self.template_engine.validate_template(template)
        if not is_valid:
            self.movie_error.setText("Error: " + "; ".join(errors))
            self.movie_error.show()
            self.movie_preview.setText("")
        else:
            self.movie_error.hide()
            # Generate preview
            preview = self.template_engine.render(template, self.SAMPLE_MOVIE)
            self.movie_preview.setText(f"Preview: {preview}.mkv")

    def _update_tv_preview(self) -> None:
        """Update TV template preview."""
        template = self.tv_input.text()

        # Validate
        is_valid, errors = self.template_engine.validate_template(template)
        if not is_valid:
            self.tv_error.setText("Error: " + "; ".join(errors))
            self.tv_error.show()
            self.tv_preview.setText("")
        else:
            self.tv_error.hide()
            # Generate preview
            preview = self.template_engine.render(template, self.SAMPLE_TV)
            self.tv_preview.setText(f"Preview: {preview}.mkv")

    def _save_settings(self) -> None:
        """Save settings and close dialog."""
        movie_template = self.movie_input.text()
        tv_template = self.tv_input.text()

        # Validate both templates
        movie_valid, movie_errors = self.template_engine.validate_template(movie_template)
        tv_valid, tv_errors = self.template_engine.validate_template(tv_template)

        if not movie_valid or not tv_valid:
            errors = []
            if not movie_valid:
                errors.append(f"Movie: {'; '.join(movie_errors)}")
            if not tv_valid:
                errors.append(f"TV: {'; '.join(tv_errors)}")
            QMessageBox.warning(
                self, "Invalid Templates", "\n".join(errors)
            )
            return

        # Save to config
        settings = self.config.settings
        settings.templates.movie = movie_template
        settings.templates.tv = tv_template

        # Save API keys
        settings.api.tmdb_api_key = self.tmdb_input.text().strip()
        settings.api.tvdb_api_key = self.tvdb_input.text().strip()
        settings.api.tvdb_pin = self.tvdb_pin_input.text().strip()

        self.config.save(settings)

        self.accept()

    def _toggle_password(self, line_edit: QLineEdit, button: QPushButton) -> None:
        """Toggle password visibility for a QLineEdit field."""
        if line_edit.echoMode() == QLineEdit.EchoMode.Password:
            line_edit.setEchoMode(QLineEdit.EchoMode.Normal)
            button.setText("Hide")
        else:
            line_edit.setEchoMode(QLineEdit.EchoMode.Password)
            button.setText("Show")


class FetchWorker(QThread):
    """Background worker for fetching metadata."""

    progress = Signal(int, int, str)
    finished = Signal(list)
    error = Signal(str)

    def __init__(
        self,
        files: list[Path],
        force_type: Optional[MediaType],
        config: ConfigService,
        provider: str,  # "tmdb", "tvdb", or "auto"
    ) -> None:
        super().__init__()
        self.files = files
        self.force_type = force_type
        self.config = config
        self.provider = provider
        self._operations: list[RenameOperation] = []

    def run(self) -> None:
        """Run the fetch operation in a background thread."""
        try:
            asyncio.run(self._fetch())
            self.finished.emit(self._operations)
        except Exception as e:
            import traceback
            traceback.print_exc()
            self.error.emit(str(e))

    async def _fetch(self) -> None:
        """Fetch metadata asynchronously."""
        settings = self.config.settings

        parser = create_parser()
        cache = APICache(self.config.cache_dir)
        template = TemplateEngine(
            movie_template=settings.templates.movie,
            tv_template=settings.templates.tv,
        )

        # Only create providers that have keys and are selected
        tmdb = None
        tvdb = None
        movie_provider = DummyMovieProvider()
        tv_provider = DummyTVProvider()

        use_tmdb = self.provider in ("tmdb", "auto") and settings.api.tmdb_api_key
        use_tvdb = self.provider in ("tvdb", "auto") and settings.api.tvdb_api_key

        if use_tmdb:
            tmdb = TMDBClient(settings.api.tmdb_api_key, cache)
        if use_tvdb:
            tvdb = TVDBClient(settings.api.tvdb_api_key, cache)

        def progress_callback(current: int, total: int, message: str) -> None:
            self.progress.emit(current, total, message)

        try:
            # Enter async contexts for available providers
            if tmdb:
                await tmdb.__aenter__()
                movie_provider = tmdb
                # Also use TMDB for TV if TVDB not available
                if not tvdb:
                    tv_provider = tmdb
            if tvdb:
                await tvdb.__aenter__()
                tv_provider = tvdb
                # Also use TVDB for movies if TMDB not available
                if not tmdb:
                    movie_provider = tvdb

            # Parse conflict resolution strategy
            try:
                conflict_strategy = ConflictStrategy(settings.conflict_resolution)
            except ValueError:
                conflict_strategy = ConflictStrategy.SKIP

            service = RenameService(
                parser=parser,
                movie_provider=movie_provider,
                tv_provider=tv_provider,
                template_engine=template,
                associated_files_settings=settings.associated_files,
                conflict_strategy=conflict_strategy,
            )

            self._operations = await service.process_files(
                self.files,
                self.force_type,
                progress_callback=progress_callback,
            )
        finally:
            # Clean up providers
            if tmdb:
                await tmdb.__aexit__(None, None, None)
            if tvdb:
                await tvdb.__aexit__(None, None, None)


class FileRenamerApp(QMainWindow):
    """Main application window."""

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("File Renamer")
        self.setMinimumSize(900, 600)

        self.config = ConfigService()
        self.config.load()

        self.files: list[Path] = []
        self.operations: list[RenameOperation] = []
        self.worker: Optional[FetchWorker] = None
        self.progress: Optional[QProgressDialog] = None

        self._setup_ui()
        self._update_provider_options()

    def _setup_ui(self) -> None:
        """Set up the user interface."""
        central = QWidget()
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)

        # Top bar - folder selection
        top_bar = QHBoxLayout()

        self.path_input = QLineEdit()
        self.path_input.setPlaceholderText("Drag and drop files/folders here or use Browse...")
        self.path_input.setReadOnly(True)
        top_bar.addWidget(self.path_input, stretch=1)

        browse_btn = QPushButton("Browse...")
        browse_btn.clicked.connect(self._on_browse)
        top_bar.addWidget(browse_btn)

        self.clear_btn = QPushButton("Clear")
        self.clear_btn.clicked.connect(self._on_clear)
        self.clear_btn.setEnabled(False)
        top_bar.addWidget(self.clear_btn)

        layout.addLayout(top_bar)

        # Options bar
        options_bar = QHBoxLayout()

        options_bar.addWidget(QLabel("Type:"))
        self.type_combo = QComboBox()
        self.type_combo.addItems(["Auto-detect", "Movies", "TV Shows"])
        self.type_combo.setMinimumWidth(120)
        options_bar.addWidget(self.type_combo)

        options_bar.addSpacing(20)

        options_bar.addWidget(QLabel("Provider:"))
        self.provider_combo = QComboBox()
        self.provider_combo.setMinimumWidth(150)
        options_bar.addWidget(self.provider_combo)

        options_bar.addStretch()

        settings_btn = QPushButton("Settings")
        settings_btn.clicked.connect(self._on_settings)
        options_bar.addWidget(settings_btn)

        self.fetch_btn = QPushButton("Fetch Metadata")
        self.fetch_btn.clicked.connect(self._on_fetch)
        self.fetch_btn.setEnabled(False)
        options_bar.addWidget(self.fetch_btn)

        layout.addLayout(options_bar)

        # Preview table
        self.table = QTableWidget()
        self.table.setColumnCount(4)
        self.table.setHorizontalHeaderLabels(["Type", "Original", "New Name", "Status"])
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(2, QHeaderView.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeToContents)
        self.table.setSelectionBehavior(QTableWidget.SelectRows)
        layout.addWidget(self.table)

        # Bottom bar - actions
        bottom_bar = QHBoxLayout()

        self.status_label = QLabel("Ready")
        bottom_bar.addWidget(self.status_label)

        bottom_bar.addStretch()

        self.rename_btn = QPushButton("Rename Files")
        self.rename_btn.clicked.connect(self._on_rename)
        self.rename_btn.setEnabled(False)
        bottom_bar.addWidget(self.rename_btn)

        layout.addLayout(bottom_bar)

        # Enable drag and drop
        self.setAcceptDrops(True)

    def _on_settings(self) -> None:
        """Open the settings dialog."""
        dialog = SettingsDialog(self.config, self)
        if dialog.exec() == QDialog.Accepted:
            # Reload config to pick up changes
            self.config.load()
            # Refresh available providers based on new API keys
            self._update_provider_options()
            self.status_label.setText("Settings saved")

    def _update_provider_options(self) -> None:
        """Update provider dropdown based on available API keys."""
        settings = self.config.settings
        has_tmdb = bool(settings.api.tmdb_api_key)
        has_tvdb = bool(settings.api.tvdb_api_key)

        self.provider_combo.clear()

        if has_tmdb and has_tvdb:
            self.provider_combo.addItem("Auto (TMDB + TVDB)", "auto")
            self.provider_combo.addItem("TMDB (Movies)", "tmdb")
            self.provider_combo.addItem("TVDB (TV Shows)", "tvdb")
        elif has_tmdb:
            self.provider_combo.addItem("TMDB", "tmdb")
        elif has_tvdb:
            self.provider_combo.addItem("TVDB", "tvdb")
        else:
            self.provider_combo.addItem("No API keys configured", "none")

    def dragEnterEvent(self, event) -> None:
        """Handle drag enter event."""
        if event.mimeData().hasUrls():
            event.acceptProposedAction()

    def dropEvent(self, event) -> None:
        """Handle drop event - supports multiple files and folders."""
        urls = event.mimeData().urls()
        if not urls:
            return

        # Define video extensions
        video_exts = {".mkv", ".mp4", ".avi", ".mov", ".m4v", ".webm", ".flv", ".mpg", ".mpeg", ".ts", ".m2ts"}

        new_files = []
        for url in urls:
            path = Path(url.toLocalFile())

            if path.is_file():
                # Check if it's a video file
                if path.suffix.lower() in video_exts:
                    new_files.append(path)
            elif path.is_dir():
                # Add all video files from the directory
                for ext in video_exts:
                    new_files.extend(path.glob(f"*{ext}"))

        if new_files:
            self._add_files(new_files)
        else:
            self.status_label.setText("No video files found in dropped items")

    def _on_browse(self) -> None:
        """Handle browse button click - supports both folders and files."""
        # Show dialog with option to select folder or files
        dialog = QFileDialog(self, "Select Files or Folder", str(Path.home()))
        dialog.setFileMode(QFileDialog.ExistingFiles)  # Allow multiple file selection
        dialog.setNameFilter("Video Files (*.mkv *.mp4 *.avi *.mov *.m4v *.webm *.flv *.mpg *.mpeg *.ts *.m2ts);;All Files (*)")

        if dialog.exec():
            selected_files = [Path(f) for f in dialog.selectedFiles()]
            if selected_files:
                # If single directory-like selection, load the path
                if len(selected_files) == 1 and selected_files[0].is_dir():
                    self._load_path(selected_files[0])
                else:
                    # Add individual files
                    self._add_files(selected_files)

    def _on_clear(self) -> None:
        """Clear the file list."""
        self.files = []
        self.operations = []
        self.path_input.setText("")
        self.table.setRowCount(0)
        self.fetch_btn.setEnabled(False)
        self.rename_btn.setEnabled(False)
        self.clear_btn.setEnabled(False)
        self.status_label.setText("File list cleared")

    def _add_files(self, new_files: list[Path]) -> None:
        """Add files to the existing file list (accumulative).

        Args:
            new_files: List of file paths to add.
        """
        # Remove duplicates and add to existing files
        existing_paths = {f.resolve() for f in self.files}
        for f in new_files:
            resolved = f.resolve()
            if resolved not in existing_paths:
                self.files.append(f)
                existing_paths.add(resolved)

        # Sort files
        self.files = sorted(self.files, key=lambda p: p.name)

        # Update UI
        self._update_table_with_files()
        self._update_file_display()

        # Enable/disable buttons based on file count
        provider = self.provider_combo.currentData()
        has_files = len(self.files) > 0
        self.fetch_btn.setEnabled(has_files and provider != "none")
        self.rename_btn.setEnabled(False)
        self.clear_btn.setEnabled(has_files)
        self.status_label.setText(f"Added files - Total: {len(self.files)} file(s)")

    def _load_path(self, path: Path) -> None:
        """Load files from a path (replaces existing list)."""
        if path.is_file():
            self.files = [path]
        else:
            self.files = []
            for ext in [".mkv", ".mp4", ".avi", ".mov", ".m4v"]:
                self.files.extend(path.glob(f"*{ext}"))
            self.files = sorted(self.files)

        # Update UI
        self._update_table_with_files()
        self.path_input.setText(str(path))

        # Enable/disable buttons based on file count
        provider = self.provider_combo.currentData()
        has_files = len(self.files) > 0
        self.fetch_btn.setEnabled(has_files and provider != "none")
        self.rename_btn.setEnabled(False)
        self.clear_btn.setEnabled(has_files)
        self.status_label.setText(f"Found {len(self.files)} file(s)")

    def _update_file_display(self) -> None:
        """Update the path input to show file count or path."""
        if len(self.files) == 0:
            self.path_input.setText("")
        elif len(self.files) == 1:
            self.path_input.setText(str(self.files[0]))
        else:
            # Show parent directory if all files are in the same directory
            parents = {f.parent for f in self.files}
            if len(parents) == 1:
                self.path_input.setText(f"{list(parents)[0]} ({len(self.files)} files)")
            else:
                self.path_input.setText(f"{len(self.files)} files from multiple locations")

    def _update_table_with_files(self) -> None:
        """Update the table with just filenames (before fetching)."""
        self.table.setRowCount(len(self.files))
        for i, f in enumerate(self.files):
            self.table.setItem(i, 0, QTableWidgetItem("Video"))
            self.table.setItem(i, 1, QTableWidgetItem(f.name))
            self.table.setItem(i, 2, QTableWidgetItem(""))
            self.table.setItem(i, 3, QTableWidgetItem("Pending"))

    def _on_fetch(self) -> None:
        """Handle fetch button click."""
        # Check provider selection
        provider = self.provider_combo.currentData()
        if provider == "none":
            QMessageBox.warning(
                self,
                "API Keys Required",
                "Please configure API keys using the CLI:\n\n"
                "file-renamer config set-key tmdb YOUR_KEY\n"
                "file-renamer config set-key tvdb YOUR_KEY",
            )
            return

        # Determine force type
        force_type: Optional[MediaType] = None
        if self.type_combo.currentIndex() == 1:
            force_type = MediaType.MOVIE
        elif self.type_combo.currentIndex() == 2:
            force_type = MediaType.TV_EPISODE

        # Disable fetch button
        self.fetch_btn.setEnabled(False)
        self.status_label.setText("Fetching metadata...")

        # Create progress dialog
        self.progress = QProgressDialog(
            "Fetching metadata...", "Cancel", 0, len(self.files), self
        )
        self.progress.setWindowTitle("Fetching")
        self.progress.setWindowModality(Qt.WindowModal)
        self.progress.setMinimumDuration(0)
        self.progress.setValue(0)
        self.progress.show()

        # Start worker
        self.worker = FetchWorker(self.files, force_type, self.config, provider)
        self.worker.progress.connect(self._on_progress)
        self.worker.finished.connect(self._on_fetch_complete)
        self.worker.error.connect(self._on_fetch_error)

        # Use a timer to start the worker after the dialog is shown
        QTimer.singleShot(100, self.worker.start)

    def _on_progress(self, current: int, total: int, message: str) -> None:
        """Handle progress update."""
        if self.progress:
            self.progress.setValue(current)
            self.progress.setLabelText(message)

            # Check if canceled
            if self.progress.wasCanceled():
                if self.worker:
                    self.worker.terminate()
                self.fetch_btn.setEnabled(True)
                self.status_label.setText("Canceled")

    def _on_fetch_complete(self, operations: list[RenameOperation]) -> None:
        """Handle fetch completion."""
        if self.progress:
            self.progress.close()
            self.progress = None

        self.operations = operations
        self._update_table_with_operations()
        self.fetch_btn.setEnabled(True)
        self.rename_btn.setEnabled(len(operations) > 0)
        self.status_label.setText(f"Found {len(operations)} match(es)")

    def _on_fetch_error(self, error: str) -> None:
        """Handle fetch error."""
        if self.progress:
            self.progress.close()
            self.progress = None

        self.fetch_btn.setEnabled(True)
        self.status_label.setText("Error")
        QMessageBox.critical(self, "Error", f"Failed to fetch metadata:\n{error}")

    def _update_table_with_operations(self) -> None:
        """Update the table with rename operations."""
        # Calculate total rows (operations + associated files)
        total_rows = sum(1 + len(op.associated_files) for op in self.operations)
        self.table.setRowCount(total_rows)

        row = 0
        for op in self.operations:
            # Main video file
            self.table.setItem(row, 0, QTableWidgetItem("Video"))
            self.table.setItem(row, 1, QTableWidgetItem(op.source.name))
            self.table.setItem(row, 2, QTableWidgetItem(op.destination.name))
            self.table.setItem(row, 3, QTableWidgetItem(op.status.name.capitalize()))
            row += 1

            # Associated files
            for assoc in op.associated_files:
                type_label = f"  └─ {assoc.file_type.capitalize()}"
                self.table.setItem(row, 0, QTableWidgetItem(type_label))
                self.table.setItem(row, 1, QTableWidgetItem(assoc.source.name))
                self.table.setItem(row, 2, QTableWidgetItem(assoc.destination.name))
                self.table.setItem(row, 3, QTableWidgetItem(""))
                row += 1

    def _on_rename(self) -> None:
        """Handle rename button click."""
        total_files = sum(op.total_files for op in self.operations)
        video_count = len(self.operations)
        assoc_count = sum(len(op.associated_files) for op in self.operations)

        message = f"Rename {video_count} video file(s)"
        if assoc_count > 0:
            message += f" + {assoc_count} associated file(s) = {total_files} total file(s)"
        message += "?"

        reply = QMessageBox.question(
            self,
            "Confirm Rename",
            message,
            QMessageBox.Yes | QMessageBox.No,
        )

        if reply != QMessageBox.Yes:
            return

        # Create progress dialog for rename
        progress = QProgressDialog(
            "Renaming files...", "Cancel", 0, len(self.operations), self
        )
        progress.setWindowTitle("Renaming")
        progress.setWindowModality(Qt.WindowModal)
        progress.setMinimumDuration(0)
        progress.setValue(0)
        progress.show()

        # Progress callback
        def on_rename_progress(current: int, total: int, message: str) -> None:
            progress.setValue(current)
            progress.setLabelText(message)
            # Process events to keep UI responsive
            from PySide6.QtWidgets import QApplication
            QApplication.processEvents()

        # Execute rename with progress tracking
        renamer = FileRenamer()
        renamer.execute(self.operations, progress_callback=on_rename_progress)

        progress.close()

        # Update table
        self._update_table_with_operations()

        # Show results
        completed = sum(1 for op in self.operations if op.status == RenameStatus.COMPLETED)
        failed = sum(1 for op in self.operations if op.status == RenameStatus.FAILED)

        message = f"Completed: {completed}"
        if failed:
            message += f"\nFailed: {failed}"

        QMessageBox.information(self, "Rename Complete", message)
        self.rename_btn.setEnabled(False)
        self.status_label.setText("Rename complete")
