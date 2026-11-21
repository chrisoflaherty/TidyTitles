/** `rename --order` and `--language`, with the real TMDB client on a scripted fetch. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandbox, runIn, strip, touch, writeKeys, type Sandbox } from "./helpers";

let sb: Sandbox;
const requests: URL[] = [];

beforeEach(async () => {
  sb = await createSandbox();
  requests.length = 0;
  await writeKeys(sb.configDir, { tmdb: "tmdb-secret-key", tvdb: "" });
});

afterEach(async () => {
  await sb.cleanup();
});

/** TMDB with one show (two seasons) and no episode groups. */
const fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  requests.push(url);
  const lang = url.searchParams.get("language");
  const body = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
  switch (url.pathname) {
    case "/3/search/tv":
      return body({ results: [{ id: 5, name: "Show", first_air_date: "2010-01-01" }] });
    case "/3/tv/5":
      return body({ id: 5, name: "Show", seasons: [{ season_number: 1, episode_count: 3 }] });
    case "/3/tv/5/episode_groups":
      return body({ id: 5, results: [] });
    case "/3/tv/5/season/1":
      return body({
        episodes: [1, 2, 3].map((n) => ({ episode_number: n, name: lang === "de-DE" ? `Folge Titel ${n}` : `Title ${n}` })),
      });
    default:
      return new Response("{}", { status: 404 });
  }
}) as typeof globalThis.fetch;

const rename = (args: string[]) =>
  runIn(["rename", sb.media, "--config-dir", sb.configDir, "-t", "tv", "-n", ...args], { session: { fetch, cache: false } });

describe("rename --language", () => {
  it("gets titles in the language and names multi-episode files", async () => {
    await touch(sb.media, "Show.S01E01E02.mkv");
    const r = await rename(["--language", "de_de", "--json"]);
    expect(r.code).toBe(0);
    const [op] = JSON.parse(r.stdout).operations;
    expect(op.destination).toMatch(/Show - S01E01-E02 - Folge Titel 1 & Folge Titel 2\.mkv$/);
    expect(op.match).toMatchObject({ episodes: [1, 2], episodeTitles: ["Folge Titel 1", "Folge Titel 2"] });
    expect(requests.every((u) => u.searchParams.get("language") === "de-DE")).toBe(true);
  });

  it("rejects something that is not a language code", async () => {
    const r = await rename(["--language", "German"]);
    expect(r.code).toBe(2);
    expect(strip(r.stderr)).toMatch(/language code/);
  });
});

describe("rename --order", () => {
  it("names absolute-numbered files in absolute order", async () => {
    await touch(sb.media, "[Group] Show - 03 [1080p].mkv");
    const r = await rename(["--order", "absolute", "--json"]);
    const [op] = JSON.parse(r.stdout).operations;
    expect(op.destination).toMatch(/Show - S01E03 - Title 3\.mkv$/);
    expect(op.match).toMatchObject({ absoluteNumber: 3 });
  });

  it("says up front that TMDB has DVD order only for some shows, and why a file was left", async () => {
    await touch(sb.media, "Show.S01E01.mkv");
    const r = await rename(["--order", "dvd", "--json"]);
    expect(strip(r.stderr)).toMatch(/TMDB has DVD order only for shows with a DVD episode group/);
    expect(strip(r.stderr)).toMatch(/Try --order aired, or TVDB/);
    const [op] = JSON.parse(r.stdout).operations;
    expect(op.lookupError).toMatchObject({ kind: "order_unavailable" });
    expect(r.code).toBe(1);
  });

  it("rejects an unknown order", async () => {
    const r = await rename(["--order", "production"]);
    expect(r.code).toBe(2);
  });
});

describe("config show", () => {
  it("shows the episode order and language", async () => {
    const r = await runIn(["config", "show", "--config-dir", sb.configDir]);
    expect(strip(r.stdout)).toMatch(/Episode order: aired/);
    expect(strip(r.stdout)).toMatch(/Language:\s+en-US \(English\)/);
    const json = await runIn(["config", "show", "--config-dir", sb.configDir, "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ tv: { episodeOrder: "aired" }, metadata: { language: "en-US" } });
  });
});
