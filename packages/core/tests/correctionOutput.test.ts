/** Corrections (a changed match, a typed name) with output folders and transfer checks. */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigService, createDefaultSettings } from "../src/config";
import { PlanCorrector } from "../src/matchCorrection";
import type { PlannedOperation } from "../src/renameService";
import { createSession } from "../src/session";
import { FakeMovieProvider, FakeMusicParser, FakeTVProvider, breakingBad, matrix, pilot, touch } from "./fakes";

let dir: string;
let media: string;
let movies: string;
let shows: string;
let config: ConfigService;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-correction-output-"));
  media = path.join(dir, "media");
  movies = path.join(dir, "Movies");
  shows = path.join(dir, "Shows");
  await Promise.all([mkdir(media), mkdir(movies), mkdir(shows)]);
  config = new ConfigService({ configDir: path.join(dir, "config"), cacheDir: path.join(dir, "cache"), env: {} });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function session() {
  const settings = createDefaultSettings();
  settings.api.tmdbApiKey = "key";
  settings.api.tvdbApiKey = "key";
  settings.output = { movie: movies, tv: shows, music: "", transferMode: "move" };
  await config.save(settings);
  return createSession(config, {
    cache: false,
    musicParser: new FakeMusicParser(),
    providers: {
      movieProvider: new FakeMovieProvider({ "The Matrix": [matrix] }),
      tvProvider: new FakeTVProvider({ "Breaking Bad": [breakingBad] }, { 1396: pilot() }),
    },
  });
}

describe("corrections with output folders", () => {
  it("moves a file to the other kind's output folder when its match changes kind", async () => {
    const source = await touch(media, "The.Matrix.1999.mkv");
    const s = await session();
    const planned = await s.plan([source]);
    expect(path.dirname(planned[0]!.destination)).toBe(movies);

    const corrector = s.corrector(planned);
    const result = await corrector.chooseMatch(
      0,
      { mediaType: "tv_episode", title: "Breaking Bad", season: 1, episode: 1 },
      breakingBad,
    );
    expect(result.kind).toBe("applied");
    const [op] = corrector.operations;
    expect(op!.status).toBe("pending");
    expect(op!.mediaFile.matchedMetadata?.kind).toBe("episode");
    expect(path.dirname(op!.destination)).toBe(shows);
    expect(s.outputDirFor(op!)).toBe(shows);
  });

  it("keeps a typed name inside the output folder", async () => {
    const source = await touch(media, "The.Matrix.1999.mkv");
    const s = await session();
    const corrector = s.corrector(await s.plan([source]));

    const editable = await corrector.editableName(0);
    expect(editable).toMatchObject({ extension: ".mkv", folder: "" });
    expect((await corrector.setName(0, "My Matrix")).kind).toBe("applied");
    expect(corrector.operations[0]!.destination).toBe(path.join(movies, "My Matrix.mkv"));
  });

  it("uses one folder for every kind when the plan was made with an override", async () => {
    const source = await touch(media, "The.Matrix.1999.mkv");
    const override = path.join(dir, "Override");
    await mkdir(override);
    const s = await session();
    const corrector = s.corrector(await s.plan([source], { destinationDir: override }), {
      destinationDir: override,
    });
    await corrector.chooseMatch(
      0,
      { mediaType: "tv_episode", title: "Breaking Bad", season: 1, episode: 1 },
      breakingBad,
    );
    expect(path.dirname(corrector.operations[0]!.destination)).toBe(override);
  });

  it("applies the session's transfer checks to every new plan", async () => {
    const source = await touch(media, "The.Matrix.1999.mkv");
    const s = await session();
    const planned = await s.plan([source]);
    const seen: PlannedOperation[][] = [];
    const corrector = new PlanCorrector(s.service, planned, {
      afterPlan: (operations) => {
        seen.push(operations);
        return operations;
      },
    });
    await corrector.clearMatch(0);
    expect(seen).toHaveLength(1);
    expect(corrector.operations).toBe(seen[0]);
    expect(corrector.operations[0]!.skipReason).toBe("match_cleared");
  });
});
