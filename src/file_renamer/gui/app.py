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
        self.config.save(settings)

        self.accept()


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

            service = RenameService(
                parser=parser,
                movie_provider=movie_provider,
                tv_provider=tv_provider,
                template_engine=template,
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
        self.path_input.setPlaceholderText("Select a folder or drop files here...")
        self.path_input.setReadOnly(True)
        top_bar.addWidget(self.path_input, stretch=1)

        browse_btn = QPushButton("Browse...")
        browse_btn.clicked.connect(self._on_browse)
        top_bar.addWidget(browse_btn)

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
        self.table.setColumnCount(3)
        self.table.setHorizontalHeaderLabels(["Original", "New Name", "Status"])
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeToContents)
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
        """Handle drop event."""
        urls = event.mimeData().urls()
        if urls:
            path = Path(urls[0].toLocalFile())
            self._load_path(path)

    def _on_browse(self) -> None:
        """Handle browse button click."""
        path = QFileDialog.getExistingDirectory(
            self, "Select Folder", str(Path.home())
        )
        if path:
            self._load_path(Path(path))

    def _load_path(self, path: Path) -> None:
        """Load files from a path."""
        self.path_input.setText(str(path))

        if path.is_file():
            self.files = [path]
        else:
            self.files = []
            for ext in [".mkv", ".mp4", ".avi", ".mov", ".m4v"]:
                self.files.extend(path.glob(f"*{ext}"))
            self.files = sorted(self.files)

        self._update_table_with_files()

        # Enable fetch only if we have files and a valid provider
        provider = self.provider_combo.currentData()
        self.fetch_btn.setEnabled(len(self.files) > 0 and provider != "none")
        self.rename_btn.setEnabled(False)
        self.status_label.setText(f"Found {len(self.files)} file(s)")

    def _update_table_with_files(self) -> None:
        """Update the table with just filenames (before fetching)."""
        self.table.setRowCount(len(self.files))
        for i, f in enumerate(self.files):
            self.table.setItem(i, 0, QTableWidgetItem(f.name))
            self.table.setItem(i, 1, QTableWidgetItem(""))
            self.table.setItem(i, 2, QTableWidgetItem("Pending"))

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
        self.table.setRowCount(len(self.operations))
        for i, op in enumerate(self.operations):
            self.table.setItem(i, 0, QTableWidgetItem(op.source.name))
            self.table.setItem(i, 1, QTableWidgetItem(op.destination.name))
            self.table.setItem(i, 2, QTableWidgetItem(op.status.name.capitalize()))

    def _on_rename(self) -> None:
        """Handle rename button click."""
        reply = QMessageBox.question(
            self,
            "Confirm Rename",
            f"Rename {len(self.operations)} file(s)?",
            QMessageBox.Yes | QMessageBox.No,
        )

        if reply != QMessageBox.Yes:
            return

        # Execute rename
        renamer = FileRenamer()
        renamer.execute(self.operations)

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
