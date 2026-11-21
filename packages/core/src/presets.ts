/**
 * Naming presets: ready-made sets of movie, TV, and music templates that
 * follow the naming a media server expects.
 *
 * A preset is only a way to fill in the three templates. Nothing about the
 * preset is stored; the preset in effect is the one whose templates equal
 * the configured ones (`matchPreset`), and "Custom" otherwise.
 *
 * Presets build folders relative to the destination folder and never
 * assume where the library root is.
 */

import { TemplateEngine } from "./template";

export interface PresetTemplates {
  movie: string;
  tv: string;
  music: string;
}

export interface NamingPreset {
  /** Stable identifier used by the CLI (`tidytitles config preset plex`). */
  id: string;
  /** Display name. */
  name: string;
  /** One-line summary. */
  description: string;
  templates: PresetTemplates;
  /** The naming guide the preset follows. */
  sources: string[];
}

export const NAMING_PRESETS: readonly NamingPreset[] = [
  {
    id: "default",
    name: "TidyTitles",
    description: "TidyTitles' own default: no movie or TV folders, music by artist and album.",
    templates: {
      movie: TemplateEngine.DEFAULT_MOVIE_TEMPLATE,
      tv: TemplateEngine.DEFAULT_TV_TEMPLATE,
      music: TemplateEngine.DEFAULT_MUSIC_TEMPLATE,
    },
    sources: [],
  },
  {
    id: "plex",
    name: "Plex",
    description:
      "A folder per movie with its TMDB ID and edition, show and “Season 01” folders, multi-disc tracks numbered 101, 201, …",
    templates: {
      movie:
        "{title} ({year})< {tmdb-{tmdb_id}}>< {edition-{edition}}>/{title} ({year})< {edition-{edition}}>",
      tv:
        "{title} ({year})< {tvdb-{tvdb_id}}>< {tmdb-{tmdb_id}}>/Season {season2}/{title} ({year}) - s{season2}e{episode2}< - {episode_title}>",
      music: "{album_artist}/{album}/{disc_multi}{track2} - {title}",
    },
    sources: [
      "https://support.plex.tv/articles/naming-and-organizing-your-movie-media-files/",
      "https://support.plex.tv/articles/multiple-editions/",
      "https://support.plex.tv/articles/naming-and-organizing-your-tv-show-files/",
      "https://support.plex.tv/articles/200265296-adding-music-media-from-folders/",
    ],
  },
  {
    id: "jellyfin",
    name: "Jellyfin",
    description:
      "A folder per movie with its TMDB ID, the edition as a version label, show and “Season 01” folders, one folder per album.",
    templates: {
      movie:
        "{title} ({year})< [tmdbid-{tmdb_id}]>/{title} ({year})< [tmdbid-{tmdb_id}]>< - {edition}>",
      tv:
        "{title} ({year})< [tvdbid-{tvdb_id}]>< [tmdbid-{tmdb_id}]>/Season {season2}/{title} S{season2}E{episode2}< - {episode_title}>",
      music: "{album_artist}/{album}/<{disc_multi}->{track2} - {title}",
    },
    sources: [
      "https://jellyfin.org/docs/general/server/media/movies/",
      "https://jellyfin.org/docs/general/server/media/shows/",
      "https://jellyfin.org/docs/general/server/media/music/",
    ],
  },
  {
    id: "kodi",
    name: "Kodi",
    description: "A folder per movie, show and “Season 01” folders, artist and album folders with a folder per disc.",
    templates: {
      movie: "{title} ({year})/{title} ({year})",
      tv: "{title} ({year})/Season {season2}/{title} S{season2}E{episode2}< - {episode_title}>",
      music: "{album_artist}/{album}/<Disc {disc_multi}/>{track2} - {title}",
    },
    sources: [
      "https://kodi.wiki/view/Naming_video_files/Movies",
      "https://kodi.wiki/view/Naming_video_files/TV_shows",
      "https://kodi.wiki/view/Music_tagging",
    ],
  },
];

/** Name shown when the templates match no preset. */
export const CUSTOM_PRESET_NAME = "Custom";

/** The preset with this id (case-insensitive), or undefined. */
export function findPreset(id: string): NamingPreset | undefined {
  const wanted = id.trim().toLowerCase();
  return NAMING_PRESETS.find((p) => p.id === wanted);
}

/** The preset whose three templates equal these, or undefined ("Custom"). */
export function matchPreset(templates: PresetTemplates): NamingPreset | undefined {
  return NAMING_PRESETS.find(
    (p) =>
      p.templates.movie === templates.movie &&
      p.templates.tv === templates.tv &&
      p.templates.music === templates.music,
  );
}
