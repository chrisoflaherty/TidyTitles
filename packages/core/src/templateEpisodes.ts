/**
 * Episode placeholders for multi-episode files, absolute numbers, and air
 * dates (see `TemplateEngine.renderEpisode`).
 *
 * Plex names a file that holds several episodes with the first and last:
 * "ShowName - s02e18-e19 - Optional_Info"; Jellyfin uses the same range,
 * "Series Name S02E01-E02". So that the default template
 * "{title} - S{season2}E{episode2} - {episode_title}" gives
 * "Show - S01E01-E02 - First & Second" without being edited, {episode} and
 * {episode2} render all the numbers, repeating the letter written just
 * before the placeholder in the template:
 *
 *   S{season2}E{episode2}   S01E01-E02    (contiguous: first and last)
 *   s{season2}e{episode2}   s01e01-e03
 *   S{season2}E{episode2}   S01E01E03     (not contiguous: every number,
 *                                          which a range would misstate)
 *   {season}x{episode2}     1x01-02       (no letter before: just the numbers)
 *
 * A formatter applies to each number ("E{episode|pad:3}" gives
 * "E001-E002"). Single episodes render exactly as before.
 */

import type { Episode } from "./models";

/** Context values for the episode fields that need more than the base fields. */
export function episodeContext(episode: Episode): Record<string, unknown> {
  const context: Record<string, unknown> = {
    absolute: episode.absoluteNumber,
    air_date: episode.airDate,
  };
  const parts = episode.parts;
  if (parts && parts.length > 1) {
    const numbers = parts.map((part) => part.episode);
    context.episode = new EpisodeNumbers(numbers, 0);
    context.episode2 = new EpisodeNumbers(numbers, 2);
    context.episode_title = joinEpisodeTitles(parts.map((part) => part.title));
  }
  return context;
}

/** Titles of a multi-episode file: "First & Second"; repeats are left out, empty ones skipped. */
export function joinEpisodeTitles(titles: readonly string[]): string {
  const unique: string[] = [];
  for (const title of titles) {
    const trimmed = title.trim();
    if (trimmed && !unique.includes(trimmed)) unique.push(trimmed);
  }
  return unique.join(" & ");
}

/** The episode numbers of a multi-episode file, rendered by the template engine. */
export class EpisodeNumbers {
  constructor(
    readonly numbers: readonly number[],
    /** Zero-pad each number to this width (0: none). */
    readonly width: number,
  ) {}

  /** True when the numbers run up one at a time (1, 2, 3). */
  get contiguous(): boolean {
    return this.numbers.every((n, i) => i === 0 || n === this.numbers[i - 1]! + 1);
  }

  /**
   * Render the numbers. `before` is the template text before the
   * placeholder (its last character decides the letter); `format` applies
   * the placeholder's formatter to one number.
   */
  render(before: string, format: (number: string) => string): string {
    const letter = /[Ee]$/.exec(before)?.[0] ?? "";
    const text = this.numbers.map((n) => format(String(n).padStart(this.width, "0")));
    if (text.length === 1) return text[0]!;
    if (this.contiguous) return `${text[0]}-${letter}${text[text.length - 1]}`;
    return text.join(letter || "-");
  }

  /** Plain text (outside a template): "1-2". */
  toString(): string {
    return this.render("", (n) => n);
  }
}
