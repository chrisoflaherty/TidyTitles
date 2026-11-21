/** Custom error types for TidyTitles. */

/** Base class for all application errors. */
export class FileRenamerError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Failed to parse a filename. */
export class ParsingError extends FileRenamerError {}

/** Error from an external API provider. */
export class ProviderError extends FileRenamerError {}

/** Authentication failed with an API provider. */
export class AuthenticationError extends ProviderError {}

/** Rate limit exceeded for an API provider. */
export class RateLimitError extends ProviderError {}

/**
 * The provider cannot list this show's episodes in the chosen order (for
 * example TMDB in DVD order for a show with no DVD episode group). Front
 * ends read `order` and `provider` (lookup error kind "order_unavailable").
 */
export class EpisodeOrderUnavailableError extends ProviderError {
  constructor(
    readonly provider: string,
    readonly order: string,
    message: string,
  ) {
    super(message);
  }
}

/** Error during a file rename operation. */
export class RenameError extends FileRenamerError {}

/** Invalid template syntax. */
export class TemplateError extends FileRenamerError {}

/** Configuration error. */
export class ConfigError extends FileRenamerError {}

/**
 * The rename history changed between showing an entry and acting on it (for
 * example, another process recorded a newer rename), so the confirmed entry
 * is no longer the one an undo would reverse.
 */
export class HistoryChangedError extends ConfigError {}
