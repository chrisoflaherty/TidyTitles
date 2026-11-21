/**
 * Episode orders: the `[tv] episode_order` setting.
 *
 * The order says which numbering the season and episode numbers in file
 * names follow, and the numbering the new names use:
 * - "aired": the order episodes were broadcast (TVDB "official", TMDB's
 *   seasons)
 * - "dvd": the order of the DVD releases (TVDB "dvd", a TMDB episode group
 *   of type DVD)
 * - "absolute": one running number across the whole show, as anime is often
 *   numbered (TVDB "absolute"; on TMDB an episode group of type Absolute,
 *   otherwise the aired episodes counted in order). New names put every
 *   episode in season 1 with its absolute number; specials stay in season 0.
 *
 * Files without a season ("[Group] Show - 123") always carry an absolute
 * number, whatever the order; it is mapped to the chosen order. Date-based
 * files ("Show.2024.03.15") are found by air date and named in aired order.
 */

/** Episode numbering. */
export type EpisodeOrder = "aired" | "dvd" | "absolute";

export const EPISODE_ORDERS: readonly EpisodeOrder[] = ["aired", "dvd", "absolute"];

export const DEFAULT_EPISODE_ORDER: EpisodeOrder = "aired";

export function isEpisodeOrder(value: unknown): value is EpisodeOrder {
  return typeof value === "string" && (EPISODE_ORDERS as readonly string[]).includes(value);
}

/** Display names, for front ends. */
export const EPISODE_ORDER_LABELS: Readonly<Record<EpisodeOrder, string>> = {
  aired: "Aired",
  dvd: "DVD",
  absolute: "Absolute",
};

/**
 * How well a TV provider delivers an order:
 * - "full": for every show
 * - "partial": only for shows that have the data (see `note`); other shows
 *   are left unmatched with lookup error kind "order_unavailable"
 */
export type EpisodeOrderSupport = "full" | "partial";

export interface EpisodeOrderCapability {
  support: EpisodeOrderSupport;
  /** One sentence for front ends to show next to the choice; undefined when "full". */
  note?: string;
}

/** What a TV provider ("tvdb" or "tmdb") can do with an order. */
export function episodeOrderCapability(
  provider: string,
  order: EpisodeOrder,
): EpisodeOrderCapability {
  if (provider !== "tmdb" || order === "aired") return { support: "full" };
  if (order === "dvd") {
    return {
      support: "partial",
      note: "TMDB has DVD order only for shows with a DVD episode group; files of other shows are left unmatched.",
    };
  }
  return {
    support: "full",
    note: "TMDB counts the show's aired episodes in order; specials do not count.",
  };
}
