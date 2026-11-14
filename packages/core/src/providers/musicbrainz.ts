/**
 * MusicBrainz API client for music metadata.
 *
 * MusicBrainz is a free, open music database that requires no API key. It
 * requires an identifying User-Agent header and allows one request per second.
 */

import { ProviderError, RateLimitError } from "../errors";
import {
  createAlbum,
  createArtist,
  createTrack,
  type Album,
  type Artist,
  type Track,
} from "../models";
import type { FetchFn, MusicProvider } from "./base";
import {
  buildUrl,
  DEFAULT_TIMEOUT_MS,
  InflightRequests,
  isRecord,
  optionalArray,
  optionalNumber,
  optionalString,
  readJson,
  requestKey,
  requireObject,
  sendRequest,
  truthy,
  yearPrefix,
  type JsonObject,
  type QueryParams,
  type ResponseCache,
} from "./util";

const LABEL = "MusicBrainz";

export interface MusicBrainzClientOptions {
  /** Optional response cache. */
  cache?: ResponseCache;
  /** Minimum milliseconds between requests (default 1,000). */
  rateLimitDelayMs?: number;
  /** Fetch implementation (default `globalThis.fetch`). */
  fetch?: FetchFn;
  /** Per-request timeout in milliseconds (default 30,000). */
  timeoutMs?: number;
}

/** Client for the MusicBrainz web service (v2, JSON). */
export class MusicBrainzClient implements MusicProvider {
  static readonly BASE_URL = "https://musicbrainz.org/ws/2";
  static readonly PROVIDER_NAME = "musicbrainz";
  /** MusicBrainz requires an identifying User-Agent. */
  static readonly USER_AGENT = "TidyTitles/0.1.0 (https://github.com/user/tidytitles)";

  readonly rateLimitDelayMs: number;
  private readonly cache?: ResponseCache;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  /** Epoch ms when the last network response arrived (0 = never). */
  private lastRequestTime = 0;
  /** Serializes requests so the rate limit holds under concurrent calls. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Identical requests in flight at the same time share one queue slot. */
  private readonly inflight = new InflightRequests<JsonObject>();

  constructor(options: MusicBrainzClientOptions = {}) {
    this.cache = options.cache;
    this.rateLimitDelayMs = options.rateLimitDelayMs ?? 1000;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Make a rate-limited API request (one at a time). There is deliberately
   * no retry here: a 503 means we are over the limit, and retrying would
   * only keep us there.
   */
  private request(endpoint: string, params: QueryParams): Promise<JsonObject> {
    return this.inflight.run(requestKey(endpoint, params), () => this.enqueue(endpoint, params));
  }

  private enqueue(endpoint: string, params: QueryParams): Promise<JsonObject> {
    const run = this.queue.then(
      () => this.requestNow(endpoint, params),
      () => this.requestNow(endpoint, params),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async requestNow(endpoint: string, params: QueryParams): Promise<JsonObject> {
    // Enforce rate limiting (before the cache check, as in the Python client).
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < this.rateLimitDelayMs) {
      await sleep(this.rateLimitDelayMs - elapsed);
    }

    const query: QueryParams = { ...params, fmt: "json" };

    const cached = this.cache?.get(MusicBrainzClient.PROVIDER_NAME, endpoint, query);
    if (cached !== undefined && cached !== null) {
      return requireObject(cached, LABEL, "cached response");
    }

    let response: Response;
    try {
      response = await sendRequest(
        this.fetchFn,
        buildUrl(MusicBrainzClient.BASE_URL, endpoint, query),
        {
          method: "GET",
          headers: {
            "User-Agent": MusicBrainzClient.USER_AGENT,
            Accept: "application/json",
          },
        },
        LABEL,
        this.timeoutMs,
      );
    } finally {
      // Python only recorded the time after a response; also record it after
      // a network failure so a retry loop cannot hammer the server.
      this.lastRequestTime = Date.now();
    }

    if (response.status === 503) {
      throw new RateLimitError("MusicBrainz rate limit exceeded. Please wait.");
    }
    if (response.status >= 400) {
      throw new ProviderError(`MusicBrainz API error: ${response.status}`);
    }

    const data = requireObject(await readJson(response, LABEL), LABEL, "response");
    this.cache?.set(MusicBrainzClient.PROVIDER_NAME, endpoint, query, data);
    return data;
  }

  /** Search for recordings (tracks) by title, optionally narrowed by artist and album. */
  async searchRecording(title: string, artist?: string, album?: string): Promise<Track[]> {
    const parts = [`recording:"${title}"`];
    if (artist) parts.push(`artist:"${artist}"`);
    if (album) parts.push(`release:"${album}"`);

    const data = await this.request("/recording", {
      query: parts.join(" AND "),
      limit: "10",
    });
    return optionalArray(data.recordings, LABEL, "recordings").map((r) =>
      parseRecording(requireObject(r, LABEL, "recording")),
    );
  }

  /** Search for releases (albums) by title, optionally narrowed by artist. */
  async searchRelease(album: string, artist?: string): Promise<Album[]> {
    const parts = [`release:"${album}"`];
    if (artist) parts.push(`artist:"${artist}"`);

    const data = await this.request("/release", {
      query: parts.join(" AND "),
      limit: "10",
    });
    return optionalArray(data.releases, LABEL, "releases").map((r) =>
      parseRelease(requireObject(r, LABEL, "release")),
    );
  }

  /** Get recording details by MusicBrainz ID, or `undefined` on any provider error. */
  async getRecording(recordingId: string): Promise<Track | undefined> {
    try {
      const data = await this.request(`/recording/${recordingId}`, {
        inc: "artist-credits+releases",
      });
      return parseRecording(data);
    } catch (error) {
      if (error instanceof ProviderError) return undefined;
      throw error;
    }
  }

  /**
   * The tracks of a release, in order, as `Track` objects (title and artist
   * from each track's recording, as `searchRecording` returns them). Uses
   * the same request as `getRelease`, so the two share the cache. Unlike
   * `getRelease`, provider errors are thrown.
   */
  async getReleaseTracks(releaseId: string): Promise<Track[]> {
    const data = await this.request(`/release/${releaseId}`, {
      inc: "artist-credits+recordings",
    });
    return parseReleaseTracks(data);
  }

  /** Get release details by MusicBrainz ID, or `undefined` on any provider error. */
  async getRelease(releaseId: string): Promise<Album | undefined> {
    try {
      const data = await this.request(`/release/${releaseId}`, {
        inc: "artist-credits+recordings",
      });
      return parseRelease(data);
    } catch (error) {
      if (error instanceof ProviderError) return undefined;
      throw error;
    }
  }
}

/**
 * Parse a MusicBrainz recording into a Track. The artist is the first
 * artist credit; the album is the first release, and the track number is
 * the position of this recording within that release's media.
 */
export function parseRecording(data: JsonObject): Track {
  const artist = firstCreditedArtist(data, true);

  let album: Album | undefined;
  let trackNumber: number | undefined;
  const releases = optionalArray(data.releases, LABEL, "releases");
  if (releases.length > 0) {
    const release = requireObject(releases[0], LABEL, "release");
    album = parseRelease(release);
    const recordingId = data.id;
    for (const rawMedium of optionalArray(release.media, LABEL, "media")) {
      const medium = asObject(rawMedium);
      for (const rawTrack of optionalArray(medium.tracks, LABEL, "tracks")) {
        const track = asObject(rawTrack);
        if (asObject(track.recording).id === recordingId) {
          trackNumber = optionalNumber(track.position);
          break;
        }
      }
      if (trackNumber) break;
    }
  }

  return createTrack({
    id: optionalString(data.id) ?? "",
    title: optionalString(data.title) ?? "",
    artist,
    album,
    trackNumber,
    durationMs: optionalNumber(data.length),
  });
}

/**
 * Parse the media of a release lookup (`inc=artist-credits+recordings`)
 * into tracks. Each track takes the title and first artist credit of its
 * recording, falling back to the track's own, then the release's credit.
 */
export function parseReleaseTracks(data: JsonObject): Track[] {
  const album = parseRelease(data);
  const tracks: Track[] = [];
  for (const rawMedium of optionalArray(data.media, LABEL, "media")) {
    const medium = asObject(rawMedium);
    for (const rawTrack of optionalArray(medium.tracks, LABEL, "tracks")) {
      const track = asObject(rawTrack);
      const recording = asObject(track.recording);
      const creditSource = truthy(recording["artist-credit"])
        ? recording
        : truthy(track["artist-credit"])
          ? track
          : data;
      tracks.push(
        createTrack({
          id: optionalString(recording.id) ?? optionalString(track.id) ?? "",
          title: optionalString(recording.title) ?? optionalString(track.title) ?? "",
          artist: firstCreditedArtist(creditSource, true),
          album,
          trackNumber: optionalNumber(track.position),
          discNumber: optionalNumber(medium.position),
          durationMs: optionalNumber(recording.length) ?? optionalNumber(track.length),
        }),
      );
    }
  }
  return tracks;
}

/**
 * Parse a MusicBrainz release into an Album. The year is the first four
 * characters of `date`; the track total is `track-count`, or else the sum of
 * the media track counts.
 */
export function parseRelease(data: JsonObject): Album {
  const artist = firstCreditedArtist(data, false);

  let year: number | undefined;
  if (truthy(data.date)) year = yearPrefix(data.date);

  let totalTracks: number | undefined = optionalNumber(data["track-count"]);
  if (!totalTracks) {
    for (const rawMedium of optionalArray(data.media, LABEL, "media")) {
      const count = optionalNumber(asObject(rawMedium)["track-count"]);
      if (count) totalTracks = (totalTracks || 0) + count;
    }
  }

  return createAlbum({
    id: optionalString(data.id) ?? "",
    title: optionalString(data.title) ?? "",
    artist,
    year,
    totalTracks,
  });
}

/** The first credited artist, or "Unknown Artist" when there is no credit. */
function firstCreditedArtist(data: JsonObject, withDisambiguation: boolean): Artist {
  const credits = optionalArray(data["artist-credit"], LABEL, "artist-credit");
  if (credits.length === 0) return createArtist({ id: "", name: "Unknown Artist" });

  const first = asObject(asObject(credits[0]).artist);
  return createArtist({
    id: optionalString(first.id) ?? "",
    name: optionalString(first.name) ?? "Unknown Artist",
    sortName: optionalString(first["sort-name"]),
    disambiguation: withDisambiguation ? optionalString(first.disambiguation) : undefined,
  });
}

/** An object value, with absent or non-object values treated as empty. */
function asObject(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
