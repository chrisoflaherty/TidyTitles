/**
 * Which episode (or episodes) a parsed TV file names, and how to look it up.
 *
 * - "numbered": a season and one or more episodes ("S01E01", "S01E01-E02")
 * - "date": an air date and no episode number ("Show.2024.03.15")
 * - "absolute": episode numbers without a season ("[Group] Show - 123"),
 *   read as absolute numbers, as Sonarr and Plex do for anime
 *
 * Every kind ends as an ordinary `Episode` with season and episode numbers
 * (in the provider's episode order), so templates work the same for all.
 */

import type { Episode, EpisodePart, ParsedInfo } from "./models";
import type { TVProvider } from "./providers/base";

export type EpisodeTarget =
  | { kind: "numbered"; season: number; episodes: number[] }
  | { kind: "date"; airDate: string }
  | { kind: "absolute"; episodes: number[] };

/** What to look up for a parsed file, or `undefined` when it names no episode. */
export function episodeTarget(parsed: ParsedInfo): EpisodeTarget | undefined {
  const episodes = parsed.episodes && parsed.episodes.length > 0
    ? parsed.episodes
    : parsed.episode != null
      ? [parsed.episode]
      : [];
  if (parsed.season != null && episodes.length > 0) {
    return { kind: "numbered", season: parsed.season, episodes };
  }
  if (parsed.airDate && episodes.length === 0) return { kind: "date", airDate: parsed.airDate };
  if (parsed.season == null && episodes.length > 0) return { kind: "absolute", episodes };
  return undefined;
}

/**
 * Look up the target's episodes. A multi-episode file matches only when
 * every one of its episodes is found, in one season; the result is the
 * first episode with `parts` listing them all. Returns `undefined` when the
 * provider cannot look up this kind (no air date or absolute support) or
 * finds nothing. Provider errors propagate.
 */
export async function lookupEpisode(
  provider: TVProvider,
  showId: number,
  target: EpisodeTarget,
): Promise<Episode | undefined> {
  let found: Array<Episode | undefined>;
  switch (target.kind) {
    case "numbered":
      found = await Promise.all(
        target.episodes.map((n) => provider.getEpisode(showId, target.season, n)),
      );
      break;
    case "date":
      return provider.getEpisodeByAirDate ? provider.getEpisodeByAirDate(showId, target.airDate) : undefined;
    case "absolute": {
      const byAbsolute = provider.getEpisodeByAbsoluteNumber?.bind(provider);
      if (!byAbsolute) return undefined;
      found = await Promise.all(target.episodes.map((n) => byAbsolute(showId, n)));
      break;
    }
  }
  return combineEpisodes(found);
}

/** One Episode for the episodes of a file, or `undefined` if any is missing or seasons differ. */
export function combineEpisodes(found: ReadonlyArray<Episode | undefined>): Episode | undefined {
  if (found.length === 0 || found.some((e) => e === undefined)) return undefined;
  const episodes = found as Episode[];
  const first = episodes[0]!;
  if (episodes.length === 1) return first;
  if (episodes.some((e) => e.season !== first.season)) return undefined;
  const parts: EpisodePart[] = episodes.map((e) => {
    const part: EpisodePart = { episode: e.episode, title: e.title };
    if (e.airDate !== undefined) part.airDate = e.airDate;
    if (e.overview !== undefined) part.overview = e.overview;
    if (e.absoluteNumber !== undefined) part.absoluteNumber = e.absoluteNumber;
    return part;
  });
  return { ...first, parts };
}
