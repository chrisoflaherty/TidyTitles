/**
 * Public API of @tidytitles/core.
 *
 * Layers, bottom to top: models and errors; parsers and templates;
 * providers; file operations; configuration; the rename service; and the
 * session helpers that front ends build on.
 */

export * from "./models";
export * from "./errors";

export * from "./parser";
export * from "./musicParser";
export * from "./template";
export * from "./templateFields";
export * from "./presets";
export { MULTI_VALUE_SEPARATOR } from "./releaseDetails";

export * from "./providers/base";
export * from "./providers/cache";
export * from "./providers/tmdb";
export * from "./providers/tvdb";
export * from "./providers/musicbrainz";
// Only the public pieces of the HTTP helpers; the rest are internal.
export { DEFAULT_TIMEOUT_MS } from "./providers/util";
export type { JsonObject, QueryParams, ResponseCache } from "./providers/util";

export * from "./renamer";
export * from "./associatedFiles";
export * from "./conflictResolution";
export * from "./coverArt";
export * from "./config";

export * from "./scan";
export * from "./renameService";
export * from "./session";
