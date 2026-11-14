/**
 * Benchmark for metadata lookups (parse + fetch) against simulated APIs.
 *
 * Uses the real TMDB, TVDB, and MusicBrainz clients and the real file cache,
 * with a fake `fetch` that answers every request after an artificial delay.
 * Nothing touches the network or the real config directory.
 *
 *   npx --no-install tsx scripts/bench-lookups.ts            # run inside packages/core
 *   npx --no-install tsx scripts/bench-lookups.ts --latency 150 --mb-delay 1000
 *
 * Scenarios: 100 movies; 3 seasons x 24 episodes of one show (TMDB and
 * TVDB); one 12-track album with complete tags (MusicBrainz, 1 request/s).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createParsedMusicInfo, type ParsedMusicInfo } from "../src/models";
import type { MusicParser } from "../src/musicParser";
import { APICache } from "../src/providers/cache";
import { MusicBrainzClient } from "../src/providers/musicbrainz";
import { TMDBClient } from "../src/providers/tmdb";
import { TVDBClient } from "../src/providers/tvdb";
import { RenameService } from "../src/renameService";

function argValue(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  return index >= 0 ? Number(process.argv[index + 1]) : fallback;
}

const LATENCY_MS = argValue("--latency", 150);
const MB_DELAY_MS = argValue("--mb-delay", 1000);

const SHOW_ID = 1396;
const RELEASE_ID = "release-1";
const ALBUM = "Night Drive";
const ARTIST = "The Example Band";
const TRACKS = Array.from({ length: 12 }, (_, i) => `Song Number ${i + 1}`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const credit = [{ name: ARTIST, artist: { id: "artist-1", name: ARTIST, "sort-name": ARTIST } }];

function tmdbEpisode(season: number, episode: number) {
  return {
    season_number: season,
    episode_number: episode,
    name: `Episode ${season}x${episode}`,
    air_date: "2008-01-20",
    overview: "",
  };
}

/** Answers every API the clients use; counts requests. */
function createFakeFetch() {
  let requests = 0;
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    requests += 1;
    await sleep(LATENCY_MS);
    const url = new URL(String(input));
    const p = url.pathname;
    const q = url.searchParams;

    // TMDB
    if (p === "/3/search/movie") {
      const title = q.get("query") ?? "";
      const id = Number(title.replace(/\D/g, "")) || 1;
      return json({ results: [{ id, title, release_date: "2001-05-04" }] });
    }
    if (p === "/3/search/tv") {
      return json({ results: [{ id: SHOW_ID, name: "Breaking Bad", first_air_date: "2008-01-20" }] });
    }
    if (p === `/3/tv/${SHOW_ID}`) {
      return json({ id: SHOW_ID, name: "Breaking Bad", first_air_date: "2008-01-20", genres: [] });
    }
    let m = /^\/3\/tv\/\d+\/season\/(\d+)\/episode\/(\d+)$/.exec(p);
    if (m) return json(tmdbEpisode(Number(m[1]), Number(m[2])));
    m = /^\/3\/tv\/\d+\/season\/(\d+)$/.exec(p);
    if (m) {
      const season = Number(m[1]);
      return json({
        season_number: season,
        episodes: Array.from({ length: 24 }, (_, i) => tmdbEpisode(season, i + 1)),
      });
    }

    // TVDB
    if (p === "/v4/login") return json({ data: { token: "token" } });
    if (p === "/v4/search") {
      return json({ data: [{ tvdb_id: String(SHOW_ID), name: "Breaking Bad", year: "2008" }] });
    }
    if (p === `/v4/series/${SHOW_ID}`) {
      return json({ data: { id: SHOW_ID, name: "Breaking Bad", year: "2008" } });
    }
    if (p === `/v4/series/${SHOW_ID}/episodes/default`) {
      const season = Number(q.get("season"));
      return json({
        data: {
          episodes: Array.from({ length: 24 }, (_, i) => ({
            seasonNumber: season,
            number: i + 1,
            name: `Episode ${season}x${i + 1}`,
            aired: "2008-01-20",
          })),
        },
      });
    }

    // MusicBrainz
    const release = {
      id: RELEASE_ID,
      title: ALBUM,
      date: "2020-01-01",
      "artist-credit": credit,
      "track-count": TRACKS.length,
    };
    if (p === "/ws/2/recording") {
      const title = /recording:"([^"]*)"/.exec(q.get("query") ?? "")?.[1] ?? "";
      return json({
        recordings: [{ id: `rec-${title}`, title, "artist-credit": credit, releases: [release] }],
      });
    }
    if (p === "/ws/2/release") return json({ releases: [release] });
    if (p === `/ws/2/release/${RELEASE_ID}`) {
      return json({
        ...release,
        media: [
          {
            position: 1,
            "track-count": TRACKS.length,
            tracks: TRACKS.map((title, i) => ({
              id: `track-${i + 1}`,
              position: i + 1,
              number: String(i + 1),
              title,
              "artist-credit": credit,
              recording: { id: `rec-${title}`, title, "artist-credit": credit },
            })),
          },
        ],
      });
    }
    return json({ error: "not found" }, 404);
  };
  return { fetch: fetchFn as typeof globalThis.fetch, count: () => requests };
}

/** Complete tags for the album tracks, by filename. */
class BenchMusicParser implements MusicParser {
  canRead(): boolean {
    return true;
  }
  async parse(filePath: string): Promise<ParsedMusicInfo> {
    const name = path.basename(filePath);
    const n = Number(/^(\d+)/.exec(name)?.[1] ?? "1");
    return createParsedMusicInfo({
      rawFilename: name,
      source: "tags",
      title: TRACKS[n - 1],
      artist: ARTIST,
      album: ALBUM,
      year: 2020,
      trackNumber: n,
    });
  }
}

interface Scenario {
  name: string;
  files: string[];
  service: (fetchFn: typeof globalThis.fetch, cache: APICache) => RenameService;
}

const movieNames = Array.from({ length: 100 }, (_, i) => `Movie Title ${i + 1} (2001).mkv`);
const episodeNames = [1, 2, 3].flatMap((s) =>
  Array.from({ length: 24 }, (_, i) => `Breaking.Bad.S0${s}E${String(i + 1).padStart(2, "0")}.mkv`),
);
const trackNames = TRACKS.map((title, i) => `${String(i + 1).padStart(2, "0")} - ${title}.mp3`);

const scenarios: Scenario[] = [
  {
    name: "100 movies (TMDB)",
    files: movieNames,
    service: (fetchFn, cache) =>
      new RenameService({ movieProvider: new TMDBClient({ apiKey: "key", cache, fetch: fetchFn }) }),
  },
  {
    name: "3 x 24 episodes (TMDB)",
    files: episodeNames,
    service: (fetchFn, cache) =>
      new RenameService({ tvProvider: new TMDBClient({ apiKey: "key", cache, fetch: fetchFn }) }),
  },
  {
    name: "3 x 24 episodes (TVDB)",
    files: episodeNames,
    service: (fetchFn, cache) =>
      new RenameService({ tvProvider: new TVDBClient({ apiKey: "key", cache, fetch: fetchFn }) }),
  },
  {
    name: "12-track album, complete tags (MusicBrainz)",
    files: trackNames,
    service: (fetchFn, cache) =>
      new RenameService({
        musicParser: new BenchMusicParser(),
        musicProvider: new MusicBrainzClient({ cache, fetch: fetchFn, rateLimitDelayMs: MB_DELAY_MS }),
      }),
  },
];

const ms = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

async function main(): Promise<void> {
  console.log(`Latency ${ms.format(LATENCY_MS)} ms per request, MusicBrainz spacing ${ms.format(MB_DELAY_MS)} ms\n`);
  for (const scenario of scenarios) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tidytitles-bench-"));
    try {
      const mediaDir = path.join(dir, "media");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(mediaDir);
      const files = await Promise.all(
        scenario.files.map(async (name) => {
          const file = path.join(mediaDir, name);
          await writeFile(file, "");
          return file;
        }),
      );
      const cache = new APICache({ cacheDir: path.join(dir, "cache") });
      const fake = createFakeFetch();
      const service = scenario.service(fake.fetch, cache);

      const start = performance.now();
      const parsed = await service.parseFiles(files);
      await service.fetchMetadata(parsed);
      const elapsed = performance.now() - start;

      const matched = parsed.filter((f) => f.matchedMetadata).length;
      const statuses = new Map<string, number>();
      for (const f of parsed) {
        const status = f.matchedMetadata?.verificationStatus ?? "none";
        statuses.set(status, (statuses.get(status) ?? 0) + 1);
      }
      console.log(
        `${scenario.name.padEnd(44)} ${ms.format(elapsed).padStart(7)} ms  ` +
          `${String(fake.count()).padStart(3)} requests  ${matched}/${files.length} matched  ` +
          [...statuses].map(([k, v]) => `${k}: ${v}`).join(", "),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

await main();
