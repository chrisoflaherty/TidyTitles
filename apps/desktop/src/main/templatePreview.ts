/**
 * Live template previews for the settings dialog, rendered by the real core
 * TemplateEngine against fixed sample metadata (the samples of the Python
 * settings dialog).
 */

import {
  TemplateEngine,
  TemplateError,
  createAlbum,
  createArtist,
  createEpisode,
  createMovie,
  createTVShow,
  createTrack,
  type TemplateContext,
} from "@tidytitles/core";
import type { TemplatePreview, TemplatePreviewItem, TemplateSet } from "../shared/ipc";

const SAMPLE_MOVIE = createMovie({
  id: 603,
  title: "The Matrix",
  originalTitle: "The Matrix",
  year: 1999,
  provider: "tmdb",
});
const MOVIE_EXTRA: TemplateContext = {
  quality: "1080p",
  source: "BluRay",
  codec: "x264",
  group: "GROUP",
  audio_codec: "DTS-HD",
  audio_channels: "5.1",
};

const SAMPLE_EPISODE = createEpisode({
  show: createTVShow({ id: 81189, title: "Breaking Bad", originalTitle: "Breaking Bad", year: 2008 }),
  season: 1,
  episode: 1,
  title: "Pilot",
  airDate: "2008-01-20",
});
const TV_EXTRA: TemplateContext = {
  quality: "720p",
  source: "HDTV",
  codec: "x264",
  group: "GROUP",
  audio_codec: "AAC",
  audio_channels: "2.0",
};

const PINK_FLOYD = createArtist({ id: "sample", name: "Pink Floyd" });
const SAMPLE_TRACK = createTrack({
  id: "sample",
  title: "Comfortably Numb",
  artist: PINK_FLOYD,
  album: createAlbum({ id: "sample", title: "The Wall", artist: PINK_FLOYD, year: 1979, totalTracks: 26, totalDiscs: 2 }),
  trackNumber: 6,
  discNumber: 2,
  genres: ["Progressive Rock"],
});

function previewOne(template: string, render: (engine: TemplateEngine) => string): TemplatePreviewItem {
  const engine = new TemplateEngine({ movieTemplate: template, tvTemplate: template, musicTemplate: template });
  const errors = [...engine.validateTemplate(template).errors];
  if (template.trim() === "") errors.push("The template is empty");
  if (errors.length > 0) return { errors };
  try {
    return { preview: render(engine), errors: [] };
  } catch (error) {
    if (error instanceof TemplateError) return { errors: [error.message] };
    throw error;
  }
}

export function previewTemplates(templates: TemplateSet): TemplatePreview {
  return {
    movie: previewOne(templates.movie, (e) => e.renderMovie(SAMPLE_MOVIE, ".mkv", MOVIE_EXTRA)),
    tv: previewOne(templates.tv, (e) => e.renderEpisode(SAMPLE_EPISODE, ".mkv", TV_EXTRA)),
    music: previewOne(templates.music, (e) => e.renderTrack(SAMPLE_TRACK, ".flac")),
  };
}
