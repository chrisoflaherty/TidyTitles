/** The rename service passes the new release details and tag details to templates. */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findPreset } from "../src/presets";
import { NullMusicProvider, RenameService } from "../src/renameService";
import { TemplateEngine } from "../src/template";
import { FakeMovieProvider, FakeMusicParser, completeTags, matrix, touch } from "./fakes";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-templates-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("template details in planned names", () => {
  it("fills edition, audio, and HDR from the file name", async () => {
    const file = await touch(dir, "The.Matrix.1999.Directors.Cut.2160p.UHD.BluRay.TrueHD.7.1.Atmos.DV.HDR.x265-GRP.mkv");
    const svc = new RenameService({
      musicParser: new FakeMusicParser(),
      movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }),
      templateEngine: new TemplateEngine({
        movieTemplate: "{title} ({year})< {edition-{edition}}> [{quality} {hdr} {audio_codec} {audio_channels}]",
      }),
    });
    const [op] = await svc.processFiles([file]);
    expect(path.basename(op!.destination)).toBe(
      "The Matrix (1999) {edition-Director's Cut} [2160p Dolby Vision, HDR10 Dolby TrueHD, Dolby Atmos 7.1].mkv",
    );
  });

  it("applies a preset's folders under the destination folder", async () => {
    const file = await touch(dir, "The.Matrix.1999.1080p.BluRay.x264-GRP.mkv");
    const plex = findPreset("plex")!.templates;
    const svc = new RenameService({
      musicParser: new FakeMusicParser(),
      movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }),
      templateEngine: new TemplateEngine({ movieTemplate: plex.movie }),
    });
    const [op] = await svc.processFiles([file]);
    expect(op!.destination).toBe(path.join(dir, "The Matrix (1999) {tmdb-603}", "The Matrix (1999).mkv"));
  });

  it("fills album artist and disc totals from tags for a track matched from tags", async () => {
    const file = await touch(dir, "song.mp3");
    const svc = new RenameService({
      musicParser: new FakeMusicParser({
        "song.mp3": { ...completeTags, albumArtist: "Various Artists", discNumber: 2, totalDiscs: 2 },
      }),
      musicProvider: new NullMusicProvider(),
      templateEngine: new TemplateEngine({ musicTemplate: findPreset("kodi")!.templates.music }),
    });
    const [op] = await svc.processFiles([file]);
    expect(path.relative(dir, op!.destination)).toBe(
      path.join("Various Artists", "A Night at the Opera", "Disc 2", "11 - Bohemian Rhapsody.mp3"),
    );
  });
});
