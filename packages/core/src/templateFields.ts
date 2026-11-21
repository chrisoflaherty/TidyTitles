/**
 * Reference for every template placeholder: what it is, where its value
 * comes from, and an example. Shown in the desktop Settings dialog and kept
 * equal to `TemplateEngine.VALID_FIELDS` by the tests.
 */

import { TemplateEngine } from "./template";

export type FieldGroup = "common" | "movie_tv" | "release" | "music";

export interface TemplateFieldDoc {
  field: string;
  group: FieldGroup;
  description: string;
  example: string;
}

export const FIELD_GROUP_LABELS: Readonly<Record<FieldGroup, string>> = {
  common: "Any type",
  movie_tv: "Movies and TV",
  release: "From the original file name",
  music: "Music",
};

/** Example values: The Matrix (1999), Breaking Bad S01E01, Pink Floyd's The Wall. */
const EXAMPLES: Readonly<Record<string, readonly [FieldGroup, string]>> = {
  title: ["common", "The Matrix"],
  original_title: ["movie_tv", "The Matrix"],
  year: ["common", "1999"],
  ext: ["common", "mkv"],
  season: ["movie_tv", "1"],
  season2: ["movie_tv", "01"],
  episode: ["movie_tv", "1"],
  episode2: ["movie_tv", "01"],
  episode_title: ["movie_tv", "Pilot"],
  air_date: ["movie_tv", "2008-01-20"],
  air_year: ["movie_tv", "2008"],
  tmdb_id: ["movie_tv", "603"],
  tvdb_id: ["movie_tv", "81189"],
  quality: ["release", "1080p"],
  source: ["release", "Blu-ray"],
  codec: ["release", "H.264"],
  group: ["release", "GROUP"],
  edition: ["release", "Director's Cut"],
  audio_codec: ["release", "Dolby Digital Plus"],
  audio_channels: ["release", "5.1"],
  hdr: ["release", "HDR10"],
  artist: ["music", "Pink Floyd"],
  album: ["music", "The Wall"],
  album_artist: ["music", "Pink Floyd"],
  track: ["music", "6"],
  track2: ["music", "06"],
  disc: ["music", "2"],
  disc2: ["music", "02"],
  disc_multi: ["music", "2"],
  disc_total: ["music", "2"],
  track_total: ["music", "26"],
  genre: ["music", "Progressive Rock"],
};

/** Every placeholder with its group, description, and an example value. */
export function getTemplateFieldDocs(): TemplateFieldDoc[] {
  const descriptions = TemplateEngine.getAvailableFields();
  return Object.entries(descriptions).map(([field, description]) => {
    const [group, example] = EXAMPLES[field] ?? (["common", ""] as const);
    return { field, group, description, example };
  });
}
