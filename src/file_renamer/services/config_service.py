"""Configuration management service."""

import tomllib
from pathlib import Path
from typing import Any, Optional

import platformdirs
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class TemplateSettings(BaseModel):
    """Template configuration."""

    movie: str = "{title} ({year})"
    tv: str = "{title} - S{season2}E{episode2} - {episode_title}"


class APISettings(BaseModel):
    """API configuration."""

    tmdb_api_key: str = ""
    tvdb_api_key: str = ""
    tvdb_pin: str = ""


class AssociatedFilesSettings(BaseModel):
    """Associated files configuration."""

    enabled: bool = True
    subtitles: bool = True
    nfo: bool = True
    images: bool = True


class Settings(BaseSettings):
    """Application settings."""

    model_config = SettingsConfigDict(
        env_prefix="FILE_RENAMER_",
        env_nested_delimiter="__",
    )

    templates: TemplateSettings = Field(default_factory=TemplateSettings)
    api: APISettings = Field(default_factory=APISettings)
    associated_files: AssociatedFilesSettings = Field(
        default_factory=AssociatedFilesSettings
    )

    # Behavior settings
    dry_run: bool = False
    overwrite: bool = False
    preview_before_rename: bool = True
    conflict_resolution: str = "skip"  # "skip", "overwrite", or "auto_version"

    # Provider preferences
    movie_provider: str = "tmdb"
    tv_provider: str = "tvdb"


class ConfigService:
    """Service for managing application configuration."""

    APP_NAME = "file-renamer"

    def __init__(self, config_path: Optional[Path] = None) -> None:
        """Initialize the config service.

        Args:
            config_path: Optional custom path to config file.
        """
        if config_path:
            self.config_dir = config_path.parent
            self.config_file = config_path
        else:
            self.config_dir = Path(platformdirs.user_config_dir(self.APP_NAME))
            self.config_file = self.config_dir / "config.toml"

        self.cache_dir = Path(platformdirs.user_cache_dir(self.APP_NAME))
        self._settings: Optional[Settings] = None

    def _ensure_dirs(self) -> None:
        """Ensure config and cache directories exist."""
        self.config_dir.mkdir(parents=True, exist_ok=True)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def load(self) -> Settings:
        """Load settings from config file and environment.

        Returns:
            Settings object.
        """
        config_data: dict[str, Any] = {}

        # Load from TOML file if it exists
        if self.config_file.exists():
            with open(self.config_file, "rb") as f:
                raw_config = tomllib.load(f)

            # Map TOML structure to Settings model
            if "templates" in raw_config:
                config_data["templates"] = raw_config["templates"]
            if "api" in raw_config:
                config_data["api"] = raw_config["api"]
            if "associated_files" in raw_config:
                config_data["associated_files"] = raw_config["associated_files"]
            if "behavior" in raw_config:
                behavior = raw_config["behavior"]
                if "dry_run" in behavior:
                    config_data["dry_run"] = behavior["dry_run"]
                if "overwrite" in behavior:
                    config_data["overwrite"] = behavior["overwrite"]
                if "preview_before_rename" in behavior:
                    config_data["preview_before_rename"] = behavior["preview_before_rename"]
                if "conflict_resolution" in behavior:
                    config_data["conflict_resolution"] = behavior["conflict_resolution"]
            if "providers" in raw_config:
                providers = raw_config["providers"]
                if "movie" in providers:
                    config_data["movie_provider"] = providers["movie"]
                if "tv" in providers:
                    config_data["tv_provider"] = providers["tv"]

        # Create settings (environment variables take precedence)
        self._settings = Settings(**config_data)
        return self._settings

    def save(self, settings: Optional[Settings] = None) -> None:
        """Save settings to config file.

        Args:
            settings: Settings to save. Uses current settings if not provided.
        """
        self._ensure_dirs()
        settings = settings or self._settings or Settings()

        # Convert to TOML format
        content = self._to_toml(settings)
        self.config_file.write_text(content)

    def _to_toml(self, settings: Settings) -> str:
        """Convert settings to TOML string."""
        lines = [
            "# File Renamer Configuration",
            "",
            "[templates]",
            f'movie = "{settings.templates.movie}"',
            f'tv = "{settings.templates.tv}"',
            "",
            "[api]",
            f'tmdb_api_key = "{settings.api.tmdb_api_key}"',
            f'tvdb_api_key = "{settings.api.tvdb_api_key}"',
            f'tvdb_pin = "{settings.api.tvdb_pin}"',
            "",
            "[associated_files]",
            f"enabled = {str(settings.associated_files.enabled).lower()}",
            f"subtitles = {str(settings.associated_files.subtitles).lower()}",
            f"nfo = {str(settings.associated_files.nfo).lower()}",
            f"images = {str(settings.associated_files.images).lower()}",
            "",
            "[behavior]",
            f"dry_run = {str(settings.dry_run).lower()}",
            f"overwrite = {str(settings.overwrite).lower()}",
            f"preview_before_rename = {str(settings.preview_before_rename).lower()}",
            f'conflict_resolution = "{settings.conflict_resolution}"',
            "",
            "[providers]",
            f'movie = "{settings.movie_provider}"',
            f'tv = "{settings.tv_provider}"',
        ]
        return "\n".join(lines) + "\n"

    @property
    def settings(self) -> Settings:
        """Get current settings, loading if necessary."""
        if self._settings is None:
            self.load()
        return self._settings  # type: ignore

    def get_api_key(self, provider: str) -> str:
        """Get API key for a provider.

        Args:
            provider: Provider name (tmdb or tvdb).

        Returns:
            API key string.
        """
        settings = self.settings
        if provider == "tmdb":
            return settings.api.tmdb_api_key
        elif provider == "tvdb":
            return settings.api.tvdb_api_key
        return ""

    def set_api_key(self, provider: str, key: str) -> None:
        """Set API key for a provider.

        Args:
            provider: Provider name (tmdb or tvdb).
            key: API key to set.
        """
        settings = self.settings
        if provider == "tmdb":
            settings.api.tmdb_api_key = key
        elif provider == "tvdb":
            settings.api.tvdb_api_key = key
        self.save(settings)
