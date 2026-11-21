/**
 * Choices for the episode order and metadata language settings, sent to the
 * renderer with the settings (the renderer cannot import core). No Electron
 * imports.
 */

import {
  EPISODE_ORDERS,
  episodeOrderCapability,
  findMetadataLanguage,
  METADATA_LANGUAGES,
  metadataLanguageName,
} from "@tidytitles/core";
import {
  TV_PROVIDER_CHOICES,
  type EpisodeOrderNotes,
  type MetadataLanguageChoice,
} from "../shared/ipc";

/**
 * The common languages, English first. A code set in config.toml that is not
 * one of them (say "de-AT") is offered too, at the end, so the dialog shows
 * it and saving keeps it.
 */
export function metadataLanguageChoices(current: string): MetadataLanguageChoice[] {
  const choices = METADATA_LANGUAGES.map(({ code, name }) => ({ code, name }));
  if (!findMetadataLanguage(current)) {
    choices.push({ code: current, name: metadataLanguageName(current) });
  }
  return choices;
}

/** What each TV provider can do with each order (see `episodeOrderCapability`). */
export function episodeOrderNotes(): EpisodeOrderNotes {
  const notes = {} as EpisodeOrderNotes;
  for (const provider of TV_PROVIDER_CHOICES) {
    notes[provider] = {} as EpisodeOrderNotes[typeof provider];
    for (const order of EPISODE_ORDERS) {
      const capability = episodeOrderCapability(provider, order);
      notes[provider][order] = {
        partial: capability.support === "partial",
        ...(capability.note ? { note: capability.note } : {}),
      };
    }
  }
  return notes;
}
