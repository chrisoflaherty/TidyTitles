/** Tests for the placeholders added for media libraries, and the placeholder reference. */

import { describe, expect, it } from "vitest";

import {
  createAlbum,
  createArtist,
  createEpisode,
  createMovie,
  createParsedMusicInfo,
  createTrack,
  createTVShow,
} from "../src/models";
import { TemplateEngine } from "../src/template";
import { getTemplateFieldDocs } from "../src/templateFields";
import { withTagDetails } from "../src/trackDetails";

const movie = createMovie({ id: 603, title: "The Matrix", originalTitle: "Matrix", year: 1999, provider: "tmdb" });
const tvdbShow = createTVShow({ id: 81189, title: "Breaking Bad", originalTitle: "Breaking Bad", year: 2008, provider: "tvdb" });
const tmdbShow = { ...tvdbShow, id: 1396, provider: "tmdb" };
const episode = createEpisode({ show: tvdbShow, season: 1, episode: 1, title: "Pilot", airDate: "2008-01-20" });
const floyd = createArtist({ id: "a", name: "Pink Floyd" });
const wall = createAlbum({ id: "r", title: "The Wall", artist: floyd, year: 1979, totalTracks: 26, totalDiscs: 2 });
const track = createTrack({ id: "t", title: "Comfortably Numb", artist: floyd, album: wall, trackNumber: 6, discNumber: 2, genres: ["Progressive Rock"] });

const one = (template: string) => new TemplateEngine({ movieTemplate: template, tvTemplate: template, musicTemplate: template });

describe("release placeholders", () => {
  const extra = {
    quality: "2160p",
    source: "Ultra HD Blu-ray",
    codec: "H.265",
    group: "GRP",
    edition: "Director's Cut",
    audio_codec: "Dolby TrueHD, Dolby Atmos",
    audio_channels: "7.1",
    hdr: "Dolby Vision, HDR10",
  };

  it.each([
    ["{quality}", "2160p"],
    ["{source}", "Ultra HD Blu-ray"],
    ["{codec}", "H.265"],
    ["{group}", "GRP"],
    ["{edition}", "Director's Cut"],
    ["{audio_codec}", "Dolby TrueHD, Dolby Atmos"],
    ["{audio_channels}", "7.1"],
    ["{hdr}", "Dolby Vision, HDR10"],
  ])("%s", (template, expected) => {
    expect(one(template).renderMovie(movie, "", extra)).toBe(expected);
    expect(one(template).renderEpisode(episode, "", extra)).toBe(expected);
  });

  it("drops a bracketed group of release details that are all missing", () => {
    const t = "{title} ({year})< [{quality} {source} {hdr}]>";
    expect(one(t).renderMovie(movie, ".mkv", { quality: "1080p", source: "Web" })).toBe("The Matrix (1999) [1080p Web].mkv");
    expect(one(t).renderMovie(movie, ".mkv", { hdr: "HDR10" })).toBe("The Matrix (1999) [HDR10].mkv");
    expect(one(t).renderMovie(movie, ".mkv", {})).toBe("The Matrix (1999).mkv");
  });
});

describe("metadata placeholders", () => {
  it("movie: original title and TMDB ID", () => {
    expect(one("{original_title}").renderMovie(movie)).toBe("Matrix");
    expect(one("{tmdb_id}").renderMovie(movie)).toBe("603");
    expect(one("{title}< {tmdb-{tmdb_id}}>").renderMovie({ ...movie, provider: "other" })).toBe("The Matrix");
  });

  it("TV: show year, air date, air year, and the provider's ID", () => {
    expect(one("{year}").renderEpisode(episode)).toBe("2008");
    expect(one("{air_date}").renderEpisode(episode)).toBe("2008-01-20");
    expect(one("{air_year}").renderEpisode(episode)).toBe("2008");
    expect(one("{tvdb_id}|{tmdb_id}").renderEpisode(episode)).toBe("81189");
    expect(one("{tvdb_id}x{tmdb_id}").renderEpisode({ ...episode, show: tmdbShow })).toBe("x1396");
    expect(one("{title}< ({air_date})>").renderEpisode({ ...episode, airDate: undefined })).toBe("Breaking Bad");
  });

  it("music: album artist, genre, track and disc totals, and the multi-disc number", () => {
    expect(one("{album_artist}").renderTrack(track)).toBe("Pink Floyd");
    expect(one("{genre}").renderTrack(track)).toBe("Progressive Rock");
    expect(one("{track_total}").renderTrack(track)).toBe("26");
    expect(one("{disc_total}").renderTrack(track)).toBe("2");
    expect(one("{disc_multi}{track2}").renderTrack(track)).toBe("206");
    const single = { ...track, album: { ...wall, totalDiscs: 1 }, discNumber: 1 };
    expect(one("{disc_multi}{track2}").renderTrack(single)).toBe("06");
    const unknown = { ...track, album: { ...wall, totalDiscs: undefined, totalTracks: undefined } };
    expect(one("<{disc_multi}->{track2}< of {track_total}>").renderTrack(unknown)).toBe("06");
  });

  it("strips a slash from every new value", () => {
    const slashy = {
      edition: "Cut/Uncut",
      audio_codec: "A/B",
      audio_channels: "5/1",
      hdr: "HDR/DV",
      group: "G/H",
      source: "Web/DL",
    };
    expect(one("{edition} {audio_codec} {audio_channels} {hdr} {group} {source}").renderMovie(movie, "", slashy)).toBe(
      "CutUncut AB 51 HDRDV GH WebDL",
    );
    expect(one("{air_date}").renderEpisode({ ...episode, airDate: "2008/01/20" })).toBe("20080120");
  });
});

describe("tags fill what the provider lacks", () => {
  it("takes album artist, genre, and totals from tags for an album built from tags", () => {
    const local = createArtist({ id: "local", name: "Queen", provider: "local" });
    const t = createTrack({
      id: "local",
      title: "Song",
      artist: local,
      album: createAlbum({ id: "local", title: "Hits", artist: local, provider: "local" }),
      trackNumber: 3,
    });
    const tags = createParsedMusicInfo({ albumArtist: "Various Artists", genre: "Rock", totalTracks: 18, totalDiscs: 2 });
    const filled = withTagDetails(t, tags);
    expect(filled.album?.artist.name).toBe("Various Artists");
    expect(filled.genres).toEqual(["Rock"]);
    expect(filled.album?.totalTracks).toBe(18);
    expect(filled.album?.totalDiscs).toBe(2);
  });

  it("never replaces provider values", () => {
    const tags = createParsedMusicInfo({ albumArtist: "Someone Else", genre: "Pop", totalTracks: 1, totalDiscs: 1 });
    const filled = withTagDetails(track, tags);
    expect(filled).toEqual(track);
  });
});

describe("placeholder reference", () => {
  it("lists every valid field, each with a description and an example", () => {
    const docs = getTemplateFieldDocs();
    expect(new Set(docs.map((d) => d.field))).toEqual(new Set(TemplateEngine.VALID_FIELDS));
    for (const doc of docs) {
      expect(doc.description, doc.field).not.toBe("");
      expect(doc.example, doc.field).not.toBe("");
    }
  });
});
