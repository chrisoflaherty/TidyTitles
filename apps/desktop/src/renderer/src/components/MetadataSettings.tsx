import { useId } from "react";
import {
  EPISODE_ORDER_CHOICES,
  type EditableSettings,
  type SettingsPayload,
} from "../../../shared/ipc";

type EpisodeOrder = (typeof EPISODE_ORDER_CHOICES)[number];

const ORDER_LABELS: Record<EpisodeOrder, { label: string; hint: string }> = {
  aired: {
    label: "Aired",
    hint: "Season and episode numbers count in broadcast order. Right for most shows.",
  },
  dvd: {
    label: "DVD",
    hint: "Numbers count as on the DVD release, for shows whose discs reorder episodes.",
  },
  absolute: {
    label: "Absolute",
    hint: "One running number for the whole show, as anime is often numbered. New names put every episode in season 1.",
  },
};

/** The TV service used in Auto mode: the preferred one when it has a key, else the other one. */
export function effectiveTvProvider(draft: EditableSettings): "tvdb" | "tmdb" {
  const preferred = draft.tvProvider === "tmdb" ? "tmdb" : "tvdb";
  const hasKey = { tvdb: draft.api.tvdbApiKey.trim() !== "", tmdb: draft.api.tmdbApiKey.trim() !== "" };
  if (hasKey[preferred]) return preferred;
  const other = preferred === "tvdb" ? "tmdb" : "tvdb";
  return hasKey[other] ? other : preferred;
}

/** Episode order and metadata language: `[tv] episode_order` and `[metadata] language`. */
export function MetadataSettings({
  draft,
  payload,
  update,
}: {
  draft: EditableSettings;
  payload: SettingsPayload;
  update: (fn: (d: EditableSettings) => EditableSettings) => void;
}) {
  const baseId = useId();
  const provider = effectiveTvProvider(draft);
  const providerName = provider === "tmdb" ? "TMDB" : "TVDB";
  const order = (EPISODE_ORDER_CHOICES as readonly string[]).includes(draft.tv.episodeOrder)
    ? (draft.tv.episodeOrder as EpisodeOrder)
    : "aired";
  const notes = payload.episodeOrderNotes[provider];
  const note = notes[order].note;

  return (
    <fieldset className="settings-section">
      <legend>Episodes and language</legend>
      <p className="section-description">Used for movie and TV lookups.</p>
      <div className="form-grid">
        <label htmlFor={`${baseId}-order`}>Episode order</label>
        <select
          id={`${baseId}-order`}
          value={order}
          onChange={(e) => update((d) => ({ ...d, tv: { ...d.tv, episodeOrder: e.target.value as EpisodeOrder } }))}
          data-testid="episode-order"
        >
          {EPISODE_ORDER_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {ORDER_LABELS[choice].label}
              {notes[choice].partial ? ` (only some shows on ${providerName})` : ""}
            </option>
          ))}
        </select>
        <label htmlFor={`${baseId}-language`}>Metadata language</label>
        <select
          id={`${baseId}-language`}
          value={draft.metadata.language}
          onChange={(e) => update((d) => ({ ...d, metadata: { ...d.metadata, language: e.target.value } }))}
          data-testid="metadata-language"
        >
          {payload.metadataLanguages.map((language) => (
            <option key={language.code} value={language.code}>
              {language.name}
            </option>
          ))}
        </select>
      </div>
      <p className="form-hint" data-testid="episode-order-hint">
        {ORDER_LABELS[order].hint}
        {note ? ` ${note}` : ""}
      </p>
      <p className="form-hint">
        Titles come in this language when {providerName} has a translation, otherwise in English, then in the
        original language. Files named with a date or with only an episode number (anime) are matched too.
      </p>
    </fieldset>
  );
}
