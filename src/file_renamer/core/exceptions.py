"""Custom exceptions for file renamer."""


class FileRenamerError(Exception):
    """Base exception for all application errors."""


class ParsingError(FileRenamerError):
    """Failed to parse filename."""


class ProviderError(FileRenamerError):
    """Error from external API provider."""


class AuthenticationError(ProviderError):
    """Authentication failed with API provider."""


class RateLimitError(ProviderError):
    """Rate limit exceeded for API provider."""


class RenameError(FileRenamerError):
    """Error during file rename operation."""


class TemplateError(FileRenamerError):
    """Invalid template syntax."""


class ConfigError(FileRenamerError):
    """Configuration error."""
