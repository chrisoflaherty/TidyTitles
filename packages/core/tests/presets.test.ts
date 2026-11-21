/** Tests for the naming presets: each preset's names for a sample movie, episode, and track. */

import { describe, expect, it } from "vitest";

import { createDefaultSettings } from "../src/config";
import {
  createAlbum,
  createArtist,
  createEpisode,
  createMovie,
  createTrack,
  createTVShow,
} from "../src/models";
import { CUSTOM_PRESET_NAME, NAMING_PRESETS, findPreset, matchPreset, type NamingPreset } from "../src/presets";
import { TemplateEngine } from "../src/template";

const movie = createMovie({ id: 78, title: "Blade Runner", originalTitle: "Blade Runner", year: 1982, provider: "tmdb" });
const show = createTVShow({ id: 81189, title: "Breaking Bad", originalTitle: "Breaking Bad", year: 2008, provider: "tvdb" });
const episode = createEpisode({ show, season: 1, episode: 1, title: "Pilot" });
const floyd = createArtist({ id: "a", name: "Pink Floyd" });
const wall = createAlbum({ id: "r", title: "The Wall", artist: floyd, year: 1979, totalDiscs: 2 });
const track = createTrack({ id: "t", title: "Comfortably Numb", artist: floyd, album: wall, trackNumber: 6, discNumber: 2 });
const single = createTrack({
  id: "t2",
  title: "Money",
  artist: floyd,
  album: createAlbum({ id: "r2", title: "The Dark Side of the Moon", artist: floyd, year: 1973, totalDiscs: 1 }),
  trackNumber: 6,
  discNumber: 1,
});
const cut = { edition: "Director's Cut", quality: "1080p" };

const engineFor = (preset: NamingPreset) =>
  new TemplateEngine({
    movieTemplate: preset.templates.movie,
    tvTemplate: preset.templates.tv,
    musicTemplate: preset.templates.music,
  });

const preset = (id: string) => findPreset(id)!;

describe("naming presets", () => {
  it("every preset's templates are valid", () => {
    const engine = new TemplateEngine();
    for (const p of NAMING_PRESETS) {
      for (const t of Object.values(p.templates)) {
        expect(engine.validateTemplate(t), `${p.id}: ${t}`).toEqual({ isValid: true, errors: [] });
      }
    }
  });

  it("the TidyTitles preset is today's defaults", () => {
    const d = createDefaultSettings().templates;
    expect(preset("default").templates).toEqual({ movie: d.movie, tv: d.tv, music: d.music });
    expect(matchPreset(d)?.id).toBe("default");
  });

  it("TidyTitles", () => {
    const e = engineFor(preset("default"));
    expect(e.renderMovie(movie, ".mkv", cut)).toBe("Blade Runner (1982).mkv");
    expect(e.renderEpisode(episode, ".mkv")).toBe("Breaking Bad - S01E01 - Pilot.mkv");
    expect(e.renderTrack(track, ".flac")).toBe("Pink Floyd/The Wall (1979)/06 - Comfortably Numb.flac");
  });

  it("Plex", () => {
    const e = engineFor(preset("plex"));
    expect(e.renderMovie(movie, ".mkv")).toBe("Blade Runner (1982) {tmdb-78}/Blade Runner (1982).mkv");
    expect(e.renderMovie(movie, ".mkv", cut)).toBe(
      "Blade Runner (1982) {tmdb-78} {edition-Director's Cut}/Blade Runner (1982) {edition-Director's Cut}.mkv",
    );
    expect(e.renderEpisode(episode, ".mkv")).toBe(
      "Breaking Bad (2008) {tvdb-81189}/Season 01/Breaking Bad (2008) - s01e01 - Pilot.mkv",
    );
    expect(e.renderEpisode({ ...episode, title: "" }, ".mkv")).toBe(
      "Breaking Bad (2008) {tvdb-81189}/Season 01/Breaking Bad (2008) - s01e01.mkv",
    );
    expect(e.renderTrack(track, ".flac")).toBe("Pink Floyd/The Wall/206 - Comfortably Numb.flac");
    expect(e.renderTrack(single, ".flac")).toBe("Pink Floyd/The Dark Side of the Moon/06 - Money.flac");
  });

  it("Jellyfin", () => {
    const e = engineFor(preset("jellyfin"));
    expect(e.renderMovie(movie, ".mkv")).toBe("Blade Runner (1982) [tmdbid-78]/Blade Runner (1982) [tmdbid-78].mkv");
    expect(e.renderMovie(movie, ".mkv", cut)).toBe(
      "Blade Runner (1982) [tmdbid-78]/Blade Runner (1982) [tmdbid-78] - Director's Cut.mkv",
    );
    expect(e.renderEpisode(episode, ".mkv")).toBe(
      "Breaking Bad (2008) [tvdbid-81189]/Season 01/Breaking Bad S01E01 - Pilot.mkv",
    );
    expect(e.renderTrack(track, ".flac")).toBe("Pink Floyd/The Wall/2-06 - Comfortably Numb.flac");
    expect(e.renderTrack(single, ".flac")).toBe("Pink Floyd/The Dark Side of the Moon/06 - Money.flac");
  });

  it("Kodi", () => {
    const e = engineFor(preset("kodi"));
    expect(e.renderMovie(movie, ".mkv", cut)).toBe("Blade Runner (1982)/Blade Runner (1982).mkv");
    expect(e.renderEpisode(episode, ".mkv")).toBe("Breaking Bad (2008)/Season 01/Breaking Bad S01E01 - Pilot.mkv");
    expect(e.renderTrack(track, ".flac")).toBe("Pink Floyd/The Wall/Disc 2/06 - Comfortably Numb.flac");
    expect(e.renderTrack(single, ".flac")).toBe("Pink Floyd/The Dark Side of the Moon/06 - Money.flac");
  });

  it("uses the TMDB ID for a show matched on TMDB", () => {
    const tmdbEpisode = { ...episode, show: { ...show, id: 1396, provider: "tmdb" } };
    expect(engineFor(preset("plex")).renderEpisode(tmdbEpisode, ".mkv")).toBe(
      "Breaking Bad (2008) {tmdb-1396}/Season 01/Breaking Bad (2008) - s01e01 - Pilot.mkv",
    );
  });

  it("finds presets by id, case-insensitively", () => {
    expect(findPreset(" PLEX ")?.name).toBe("Plex");
    expect(findPreset("emby")).toBeUndefined();
    expect(new Set(NAMING_PRESETS.map((p) => p.id)).size).toBe(NAMING_PRESETS.length);
  });

  it("matches a preset only when all three templates are equal", () => {
    const plex = preset("plex").templates;
    expect(matchPreset({ ...plex })?.id).toBe("plex");
    expect(matchPreset({ ...plex, music: "{title}" })).toBeUndefined();
    expect(CUSTOM_PRESET_NAME).toBe("Custom");
  });
});
