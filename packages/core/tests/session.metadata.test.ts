import { describe, expect, it } from "vitest";
import { createDefaultSettings, type Settings } from "../src/config";
import { episodeOrderCapability, isEpisodeOrder } from "../src/episodeOrder";
import {
  isMetadataLanguageCode,
  METADATA_LANGUAGES,
  metadataLanguageName,
  normalizeMetadataLanguage,
  tvdbLanguageCode,
} from "../src/languages";
import { applySessionOverrides, buildProviders, RenameSession } from "../src/session";
import { mockFetch, queryOf } from "./providers/mock-fetch";

function settings(fields: Partial<Settings> = {}): Settings {
  const s = createDefaultSettings();
  s.api.tmdbApiKey = "tmdb-key";
  s.api.tvdbApiKey = "tvdb-key";
  return { ...s, ...fields };
}

describe("episode order and language reach the providers", () => {
  it("passes [tv] and [metadata] to both clients", async () => {
    const s = settings({ tv: { episodeOrder: "dvd" }, metadata: { language: "pt-BR" } });
    const { fetch, requests } = mockFetch([{ path: "/3/search/movie", reply: { json: { results: [] } } }]);
    const set = buildProviders(s, { fetch });
    expect(set.clients.tvdb?.episodeOrder).toBe("dvd");
    expect(set.clients.tvdb?.language).toBe("pt");
    expect(set.clients.tmdb?.episodeOrder).toBe("dvd");
    await set.clients.tmdb!.searchMovie("x");
    expect(queryOf(requests[0]!).language).toBe("pt-BR");
  });

  it("a session option overrides the setting for one run", () => {
    const session = new RenameSession(settings(), { episodeOrder: "absolute", language: "ja-JP", cache: false });
    expect(session.settings.tv.episodeOrder).toBe("absolute");
    expect(session.settings.metadata.language).toBe("ja-JP");
    expect(session.providers.clients.tvdb?.language).toBe("jpn");
    const base = settings();
    expect(applySessionOverrides(base, {})).toBe(base);
  });
});

describe("languages", () => {
  it("lists common languages with English names and unique codes", () => {
    expect(METADATA_LANGUAGES[0]).toEqual({ code: "en-US", name: "English", tvdb: "eng" });
    const codes = METADATA_LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every(isMetadataLanguageCode)).toBe(true);
    expect(METADATA_LANGUAGES.every((l) => /^[a-z]{2,4}$/.test(l.tvdb))).toBe(true);
  });

  it("maps codes to TVDB's", () => {
    expect(tvdbLanguageCode("de-DE")).toBe("deu");
    expect(tvdbLanguageCode("de")).toBe("deu");
    expect(tvdbLanguageCode("de-AT")).toBe("deu");
    expect(tvdbLanguageCode("pt-BR")).toBe("pt");
    expect(tvdbLanguageCode("pt-PT")).toBe("por");
    expect(tvdbLanguageCode("zh-HK")).toBe("zhtw");
    expect(tvdbLanguageCode("en-GB")).toBe("eng");
    expect(tvdbLanguageCode("xx")).toBe("eng");
  });

  it("normalizes input and names codes", () => {
    expect(normalizeMetadataLanguage(" pt_br ")).toBe("pt-BR");
    expect(normalizeMetadataLanguage("DE")).toBe("de");
    expect(normalizeMetadataLanguage("German")).toBeUndefined();
    expect(metadataLanguageName("es-MX")).toBe("Spanish (Latin America)");
    expect(metadataLanguageName("de-AT")).toBe("de-AT");
  });
});

describe("episode orders", () => {
  it("says what each provider can deliver", () => {
    expect(episodeOrderCapability("tvdb", "dvd")).toEqual({ support: "full" });
    expect(episodeOrderCapability("tmdb", "aired")).toEqual({ support: "full" });
    expect(episodeOrderCapability("tmdb", "dvd")).toMatchObject({ support: "partial" });
    expect(episodeOrderCapability("tmdb", "dvd").note).toMatch(/DVD episode group/);
    expect(episodeOrderCapability("tmdb", "absolute")).toMatchObject({ support: "full" });
    expect(isEpisodeOrder("dvd")).toBe(true);
    expect(isEpisodeOrder("production")).toBe(false);
  });
});
