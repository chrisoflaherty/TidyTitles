/**
 * Filename parsing to extract media information.
 *
 * Port of `file_renamer/core/parser.py`. The Python app delegates to the
 * `guessit` library; there is no JavaScript guessit, so `GuessItParser` here
 * is a hand-written, guessit-compatible parser. Its rules were derived from
 * guessit 3.8.0 output and are checked against it by
 * `scripts/parser-parity.ts` over `scripts/parser-corpus.txt`.
 *
 * `RegexParser` is a straight port of the Python regex fallback.
 */

import { createParsedInfo } from "./models";
import type { MediaType, ParsedInfo } from "./models";
import { releaseDetails } from "./releaseDetails";

/** A filename parser. */
export interface FilenameParser {
  /** Parse a filename (no directory) and extract media information. */
  parse(filename: string): ParsedInfo;
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** File extensions guessit recognizes as containers (stripped before parsing). */
const CONTAINER_EXTENSIONS = new Set([
  // video
  "3g2", "3gp", "3gp2", "asf", "avi", "divx", "flv", "iso", "m4v", "mk2",
  "mk3d", "mka", "mkv", "mov", "mp4", "mp4a", "mpeg", "mpg", "ogg", "ogm",
  "ogv", "qt", "ra", "ram", "rm", "ts", "m2ts", "vob", "wav", "webm", "wma",
  "wmv",
  // audio
  "mp3", "flac", "m4a", "opus", "aiff", "aac", "ape", "wv", "alac",
  // subtitles and sidecars
  "srt", "idx", "sub", "ssa", "ass", "nfo", "torrent", "nzb",
]);

/** Valid release years, as guessit defines them. */
const MIN_YEAR = 1920;
const MAX_YEAR = 2029;

/** Source tokens that are unambiguous wherever they appear. */
const STRONG_SOURCES: Record<string, string> = {
  bluray: "Blu-ray",
  "blu-ray": "Blu-ray",
  bdrip: "Blu-ray",
  brrip: "Blu-ray",
  bdmv: "Blu-ray",
  bd25: "Blu-ray",
  bd50: "Blu-ray",
  "web-dl": "Web",
  webdl: "Web",
  webrip: "Web",
  "web-rip": "Web",
  "web-hd": "Web",
  webhd: "Web",
  webdlrip: "Web",
  hdtv: "HDTV",
  pdtv: "Digital TV",
  sdtv: "TV",
  dvdrip: "DVD",
  dvdr: "DVD",
  dvd5: "DVD",
  dvd9: "DVD",
  dvdscr: "DVD",
  dvdscreener: "DVD",
  hddvd: "HD-DVD",
  hdcam: "HD Camera",
  camrip: "Camera",
  telesync: "Telesync",
  hdts: "Telesync",
  telecine: "Telecine",
  vhsrip: "VHS",
};

/**
 * Source tokens that are also ordinary words ("Charlotte's Web"). They only
 * count once the title has clearly ended, when written in capitals, or when
 * another release tag follows.
 */
const WEAK_SOURCES: Record<string, string> = {
  web: "Web",
  dvd: "DVD",
  bd: "Blu-ray",
  cam: "Camera",
  ts: "Telesync",
  tc: "Telecine",
  vhs: "VHS",
};

const CODECS: Record<string, string> = {
  x264: "H.264",
  h264: "H.264",
  "h.264": "H.264",
  avc: "H.264",
  x265: "H.265",
  h265: "H.265",
  "h.265": "H.265",
  hevc: "H.265",
  xvid: "Xvid",
  divx: "DivX",
  vp9: "VP9",
  mpeg2: "MPEG-2",
};

/** Release tags that end the title but feed no ParsedInfo field. */
const STRONG_TAGS = new Set([
  // audio
  "aac", "ac3", "eac3", "dts", "dts-hd", "dtshd", "dts-hdma", "dts-x", "hdma",
  "truehd", "atmos", "ddp", "dd+", "flac", "lpcm", "pcm",
  // video
  "remux", "hdr", "hdr10", "hdr10+", "dovi", "hi10p", "hdrip", "rip", "uhd",
  "4k", "60fps", "imax", "bdremux",
  // release flags
  "repack", "rerip", "nfofix", "readnfo", "hc", "hardsub", "multisubs",
  "vostfr", "dual-audio", "r5",
]);

/** Release tags that are also ordinary words; resolved like WEAK_SOURCES. */
const WEAK_TAGS = new Set([
  "extended", "remastered", "unrated", "uncut", "limited", "theatrical",
  "criterion", "proper", "internal", "complete", "dubbed", "subbed", "multi",
  "hq", "dd", "ma", "dv", "ws", "fs", "3d", "sbs", "anniversary", "edition",
  "dl", "opus", "mp3", "md",
  "restored",
]);

/** Words that, followed by "Cut", form an edition tag. */
const CUT_PREFIXES = new Set([
  "director's", "directors", "director", "theatrical", "final", "extended",
  "ultimate", "special",
]);

/** Language names; only recognized in capitals (scene style). */
const LANGUAGES = new Set([
  "ENGLISH", "FRENCH", "TRUEFRENCH", "GERMAN", "SPANISH", "ITALIAN", "KOREAN",
  "JAPANESE", "CHINESE", "MANDARIN", "CANTONESE", "RUSSIAN", "HINDI",
  "PORTUGUESE", "SWEDISH", "DANISH", "NORWEGIAN", "FINNISH", "DUTCH",
  "POLISH", "TURKISH", "ARABIC", "HEBREW", "THAI", "CZECH", "HUNGARIAN",
  "GREEK", "MULTi",
]);

/** Streaming service tags; only recognized in capitals. */
const STREAMING = new Set([
  "NF", "AMZN", "HMAX", "ATVP", "HULU", "DSNP", "PCOK", "PMTP", "STAN", "CRAV",
  "iT", "iP", "RED",
]);

const COUNTRIES = new Set(["US", "UK", "GB", "AU", "CA", "NZ"]);

/** Container names that sometimes appear mid-name (lowercase only). */
const MID_CONTAINERS = new Set(["mkv", "mp4", "avi", "mov"]);

const ROMAN = /^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x)$/i;
const NUMBER_WORDS = new Set([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
]);

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

interface Token {
  text: string;
  start: number;
  end: number;
  /** A standalone dash separates this token from the previous one. */
  dashBefore: boolean;
  /** Index of the enclosing bracket group, or -1. */
  bracket: number;
}

interface BracketGroup {
  start: number;
  end: number; // index of the closing bracket (or string length)
}

const TOKEN_PATTERN = new RegExp(
  [
    // Dotted codec names
    String.raw`H\.26[45]`,
    // Audio channel tags such as 5.1, DDP5.1, AAC2.0
    String.raw`(?<![0-9])(?:DDP|DD|AAC|DTS|E?AC3|TrueHD|FLAC|Opus|L?PCM)?[2-9]\.[01](?![0-9])`,
    // Acronyms of three or more letters keep their dots (S.W.A.T.)
    String.raw`(?<![A-Za-z0-9])(?:[A-Za-z]\.){3,}`,
    // Ordinary words; may contain inner dashes but not start or end with one
    String.raw`[^\s._\[\](){}\-](?:[^\s._\[\](){}]*[^\s._\[\](){}\-])?`,
  ].join("|"),
  "gi",
);

function findBrackets(text: string): BracketGroup[] {
  const groups: BracketGroup[] = [];
  const closers: Record<string, string> = { "[": "]", "(": ")", "{": "}" };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const closer = closers[ch];
    if (closer) {
      const close = text.indexOf(closer, i + 1);
      const end = close === -1 ? text.length : close;
      groups.push({ start: i, end });
      i = end + 1;
    } else {
      i++;
    }
  }
  return groups;
}

function tokenize(text: string, brackets: BracketGroup[]): Token[] {
  const tokens: Token[] = [];
  let prevEnd = 0;
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const start = match.index;
    const end = start + match[0].length;
    const gap = text.slice(prevEnd, start);
    const bracket = brackets.findIndex((b) => start > b.start && start < b.end);
    tokens.push({
      text: match[0],
      start,
      end,
      dashBefore: tokens.length > 0 && gap.includes("-"),
      bracket,
    });
    prevEnd = end;
  }
  return splitMarkerSuffixes(tokens);
}

/**
 * Split "S01E01-GRP" into "S01E01" and "GRP" (guessit reads the suffix as
 * the episode title). "S01E01-E02" and "1x01-02" stay whole.
 */
function splitMarkerSuffixes(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (const t of tokens) {
    const m =
      /^(s\d{1,4}e\d{1,4}(?:(?:-?e|[-+x]e?)\d{1,4}|-s\d{1,4}e\d{1,4})*|\d{1,2}x\d{1,3}(?:-\d{1,2}x\d{1,3}|[-x]\d{1,3})*)-(?!(?:s\d+)?e?\d+(?:x\d+)?(?:[-+xe]|$))(.+)$/i.exec(
        t.text,
      );
    if (m) {
      const cut = t.start + m[1]!.length;
      out.push({ ...t, text: m[1]!, end: cut });
      out.push({ text: m[2]!, start: cut + 1, end: t.end, dashBefore: true, bracket: t.bracket });
    } else {
      out.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Token classification
// ---------------------------------------------------------------------------

type Kind =
  | "word"
  | "episode" // SxxExx, NxNN, Exx, "Episode N"
  | "season" // Sxx, "Season N"
  | "markerWord" // the "Season"/"Episode" word itself
  | "date"
  | "year"
  | "tech"
  | "weak"
  | "part";

interface Classified {
  kind: Kind;
  season?: number;
  episode?: number;
  /** Every episode number of a multi-episode marker ("S01E01E02"); the first is `episode`. */
  episodes?: number[];
  quality?: string;
  source?: string;
  codec?: string;
  /** For "TAG-GROUP" tokens: offset in the token where the group starts. */
  groupOffset?: number;
  /** Tags such as countries, which never precede a release group. */
  noGroup?: boolean;
}

function isValidYear(text: string): boolean {
  if (!/^\d{4}$/.test(text)) return false;
  const year = Number(text);
  return year >= MIN_YEAR && year <= MAX_YEAR;
}

function isUpper(text: string): boolean {
  return /[A-Z]/.test(text) && text === text.toUpperCase();
}

function qualityOf(lower: string): string | undefined {
  let m = /^(\d{3,4})([pi])$/.exec(lower);
  if (m) return `${m[1]}${m[2]}`;
  if (lower === "4k") return "2160p";
  m = /^\d{3,4}x(\d{3,4})$/.exec(lower);
  if (m) return `${m[1]}p`;
  return undefined;
}

/** Classify a token on its own (multi-token patterns are handled later). */
function classifyTech(text: string, allLower: boolean, index: number): Classified | undefined {
  const lower = text.toLowerCase();

  const quality = qualityOf(lower);
  if (quality) return { kind: "tech", quality };
  const source = STRONG_SOURCES[lower];
  if (source) return { kind: "tech", source };
  const codec = CODECS[lower];
  if (codec) return { kind: "tech", codec };
  if (STRONG_TAGS.has(lower)) return { kind: "tech" };
  if (/^(?:ddp|dd|aac|dts|e?ac3|truehd|flac|opus|l?pcm)?[2-9]\.[01]$/i.test(text)) {
    return { kind: "tech" };
  }
  if (/^(?:ddp|dd|aac|ac3)\d$/i.test(text)) return { kind: "tech" };
  if (/^\d{1,2}bit$/i.test(text)) return { kind: "tech" };
  if (index > 0 && LANGUAGES.has(text)) return { kind: "tech" };
  if (index > 0 && STREAMING.has(text)) return { kind: "tech" };
  if (
    index > 0 &&
    (COUNTRIES.has(text) || (allLower && COUNTRIES.has(text.toUpperCase())))
  ) {
    return { kind: "tech", noGroup: true };
  }
  if (index > 0 && MID_CONTAINERS.has(text)) return { kind: "tech" };
  if (/^cd\d$/i.test(text)) return { kind: "part" };
  if (/^part\d{1,2}$/i.test(text)) return { kind: "part" };

  const weakSource = WEAK_SOURCES[lower];
  if (weakSource) return { kind: "weak", source: weakSource };
  if (WEAK_TAGS.has(lower)) return { kind: "weak" };
  return undefined;
}

/** Classify "TAG-GROUP" style tokens such as "x264-SPARKS". */
function classifyDashed(text: string, allLower: boolean, index: number): Classified | undefined {
  // Try the longest prefix first so "WEB-DL-GRP" splits after "WEB-DL".
  const dashes: number[] = [];
  for (let i = text.indexOf("-"); i !== -1; i = text.indexOf("-", i + 1)) dashes.push(i);
  for (let d = dashes.length - 1; d >= 0; d--) {
    const cut = dashes[d]!;
    const prefix = text.slice(0, cut);
    const rest = text.slice(cut + 1);
    if (!rest) continue;
    const c = classifyTech(prefix, allLower, index);
    if (c && c.kind === "tech") {
      // "Bluray-1080p", "WEBDL-2160p": a compound tag, not tag plus group.
      const r = classifyTech(rest, allLower, index) ?? classifyDashed(rest, allLower, index);
      if (r && (r.kind === "tech" || r.kind === "weak") && r.groupOffset === undefined) {
        return {
          kind: "tech",
          quality: c.quality ?? r.quality,
          source: c.source ?? r.source,
          codec: c.codec ?? r.codec,
        };
      }
      return { ...c, groupOffset: cut + 1 };
    }
  }
  return undefined;
}

/** Ranges longer than this are not expanded ("E01-E9999" is two episodes). */
const MAX_EPISODE_RANGE = 1000;

/**
 * Add `next` to an episode list. A range ("E01-E03") adds every number
 * after the previous one up to `next`, as guessit does; a descending range
 * ("E05-E03") adds just `next`.
 */
function addEpisode(list: number[], next: number, range: boolean): void {
  const previous = list[list.length - 1]!;
  if (range && next > previous && next - previous <= MAX_EPISODE_RANGE) {
    for (let n = previous + 1; n <= next; n++) list.push(n);
  } else if (!list.includes(next)) {
    list.push(next);
  }
}

/**
 * Episode numbers from the tail of a marker. Each part is a separator and a
 * number; `isRange(separator)` says whether it continues a range.
 */
function episodeList(first: number, tail: string, part: RegExp, isRange: (sep: string) => boolean): number[] {
  const list = [first];
  for (const m of tail.matchAll(part)) addEpisode(list, Number(m[2]), isRange(m[1]!.toLowerCase()));
  return list;
}

/** A single-token episode marker, with `episodes` set when it names more than one. */
function episodeClass(season: number | undefined, episodes: number[]): Classified {
  const c: Classified = { kind: "episode", episode: episodes[0]! };
  if (season !== undefined) c.season = season;
  if (episodes.length > 1) c.episodes = episodes;
  return c;
}

function episodeMarker(text: string): Classified | undefined {
  // S01E01, S01E01E02, S01E01-E03, S01E01-03, S01E01+E02, S01E01xE02, S01E01-S01E03
  let m = /^s(\d{1,4})[ ._-]?e(\d{1,4})((?:(?:-?e|[-+x]e?)\d{1,4}|-s\d{1,4}e\d{1,4})*)$/i.exec(text);
  if (m) {
    const episodes = episodeList(Number(m[2]), m[3]!, /(-s\d+e|-?e|[-+x]e?)(\d+)/gi, (sep) => sep.startsWith("-"));
    return episodeClass(Number(m[1]), episodes);
  }
  // 1x01, 1x01-03 (a range), 1x01x02 and 1x01-1x02 (lists)
  m = /^(\d{1,2})x(\d{1,3})((?:-\d{1,2}x\d{1,3}|[-x]\d{1,3})*)$/i.exec(text);
  if (m) {
    const episodes = episodeList(Number(m[2]), m[3]!, /(-\d+x|[-x])(\d+)/gi, (sep) => sep === "-");
    return episodeClass(Number(m[1]), episodes);
  }
  // E01, Ep01, E01E02, E01-E02, Ep01-02
  m = /^(?:e|ep)(\d{1,4})((?:-?e\d{1,4}|-\d{1,4})*)$/i.exec(text);
  if (m) {
    const episodes = episodeList(Number(m[1]), m[2]!, /(-?e|-)(\d+)/gi, (sep) => sep.startsWith("-"));
    return episodeClass(undefined, episodes);
  }
  m = /^s(\d{1,2})$/i.exec(text);
  if (m) return { kind: "season", season: Number(m[1]) };
  return undefined;
}

function isMonthDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** "YYYY-MM-DD" for a real calendar date, else undefined (no February 30). */
function isoDate(year: string, month: string, day: string): string | undefined {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!isMonthDay(m, d)) return undefined;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return undefined;
  return `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/**
 * Anime-style episode tokens after " - ": "12v2" is episode 12, "01-03" is
 * episodes 1 to 3, and "01~03" is episodes 1 and 3 (as guessit reads them).
 * Undefined for anything else (including plain numbers and descending ranges).
 */
function animeEpisodes(text: string): number[] | undefined {
  if (/^\d{1,4}v\d$/i.test(text)) return [Number(/^\d+/.exec(text)![0])];
  const m = /^(\d{1,4})([-~])(\d{1,4})$/.exec(text);
  if (!m) return undefined;
  const list = [Number(m[1])];
  const last = Number(m[3]);
  if (last <= list[0]!) return undefined;
  addEpisode(list, last, m[2] === "-");
  return list;
}

/** Split a 3- or 4-digit number into season and episode (guessit style). */
function splitSeasonEpisode(digits: string): { season?: number; episode: number } {
  if (digits.length === 3) {
    return { season: Number(digits[0]), episode: Number(digits.slice(1)) };
  }
  if (digits.length === 4) {
    return { season: Number(digits.slice(0, 2)), episode: Number(digits.slice(2)) };
  }
  return { episode: Number(digits) };
}

// ---------------------------------------------------------------------------
// GuessItParser
// ---------------------------------------------------------------------------

/**
 * Guessit-compatible parser.
 *
 * Produces the same `ParsedInfo` the Python `GuessItParser` builds from
 * guessit's output, including guessit's normalized names for source
 * ("Blu-ray", "Web", "HDTV", "DVD", ...) and codec ("H.264", "H.265",
 * "Xvid", ...). Known, deliberate differences from guessit are listed in the
 * parity report produced by `scripts/parser-parity.ts`.
 */
export class GuessItParser implements FilenameParser {
  parse(filename: string): ParsedInfo {
    return parseGuessit(filename);
  }
}

function stripExtension(filename: string): string {
  const m = /\.([A-Za-z0-9]{2,7})$/.exec(filename);
  if (m && CONTAINER_EXTENSIONS.has(m[1]!.toLowerCase())) {
    return filename.slice(0, m.index);
  }
  return filename;
}

function blank(text: string, start: number, end: number): string {
  return text.slice(0, start) + " ".repeat(end - start) + text.slice(end);
}

function cleanGroup(raw: string): string | undefined {
  let value = raw.replace(/^[\s._\-[({]+/, "").replace(/[\s._-]+$/, "");
  const pairs: Array<[string, string]> = [["[", "]"], ["(", ")"], ["{", "}"]];
  for (const [open, close] of pairs) {
    if (value.endsWith(close) && !value.includes(open)) {
      value = value.slice(0, -1).replace(/[\s._-]+$/, "");
    }
  }
  return value || undefined;
}

/** Build ParsedInfo without keys whose value is undefined. */
function compact(fields: Parameters<typeof createParsedInfo>[0]): ParsedInfo {
  const info = createParsedInfo(fields) as unknown as Record<string, unknown>;
  for (const key of Object.keys(info)) {
    if (info[key] === undefined) delete info[key];
  }
  return info as unknown as ParsedInfo;
}

function joinTokens(tokens: Token[]): string {
  return tokens.map((t) => t.text).join(" ").trim();
}

/** Cut a token run at the first standalone dash (after its first token). */
function cutAtDash(tokens: Token[]): Token[] {
  const i = tokens.findIndex((t, idx) => idx > 0 && t.dashBefore);
  return i === -1 ? tokens : tokens.slice(0, i);
}

function parseGuessit(filename: string): ParsedInfo {
  let name = stripExtension(filename);
  let group: string | undefined;

  // Leading "[Group]" (anime fansub style).
  const lead = /^\s*\[([^\]]+)\]/.exec(name);
  if (lead) {
    group = lead[1]!.trim();
    name = blank(name, 0, lead[0].length);
  }
  // CRC32 checksums such as [ABCD1234].
  for (const m of name.matchAll(/[[(][0-9A-Fa-f]{8}[\])]/g)) {
    name = blank(name, m.index, m.index + m[0].length);
  }

  const brackets = findBrackets(name);
  const tokens = tokenize(name, brackets);
  const n = tokens.length;
  const letters = name.replace(/[^A-Za-z]/g, "");
  const allLower = letters.length > 0 && letters === letters.toLowerCase();

  const cls: Classified[] = tokens.map(() => ({ kind: "word" }));

  // Pass 1: single-token episode markers and release tags.
  tokens.forEach((t, i) => {
    const marker = episodeMarker(t.text);
    if (marker) {
      cls[i] = marker;
      return;
    }
    const tech = classifyTech(t.text, allLower, i);
    if (tech) {
      cls[i] = tech;
      return;
    }
    if (t.text.includes("-")) {
      const dashed = classifyDashed(t.text, allLower, i);
      if (dashed) cls[i] = dashed;
    }
  });

  // Pass 2: multi-token patterns.
  let dateStart = -1;
  let dateEnd = -1;
  let airDate: string | undefined;
  for (let i = 0; i < n; i++) {
    const t = tokens[i]!.text;
    const lower = t.toLowerCase();
    const next = tokens[i + 1];

    // "Season 2", "Episode 5"
    if ((lower === "season" || lower === "episode") && next && /^\d{1,4}$/.test(next.text)) {
      cls[i] = { kind: "markerWord" };
      cls[i + 1] =
        lower === "season"
          ? { kind: "season", season: Number(next.text) }
          : { kind: "episode", episode: Number(next.text) };
      i++;
      continue;
    }

    // "Part 2", "Part II", "Part One"
    if (
      lower === "part" &&
      i > 0 &&
      next &&
      (/^\d{1,2}$/.test(next.text) || ROMAN.test(next.text) || NUMBER_WORDS.has(next.text.toLowerCase()))
    ) {
      cls[i] = { kind: "part" };
      cls[i + 1] = { kind: "part" };
      i++;
      continue;
    }

    // "Director's Cut", "Final Cut", ...
    if (CUT_PREFIXES.has(lower) && next && next.text.toLowerCase() === "cut") {
      cls[i] = { kind: "weak" };
      cls[i + 1] = { kind: "weak" };
      i++;
      continue;
    }

    // "Complete Series" / "Complete Season"
    if (lower === "complete" && next && /^(?:series|season|collection)$/i.test(next.text)) {
      cls[i] = { kind: "tech" };
      continue;
    }

    // Dates: 2023-05-12 and 20230512 (one token), 2023.05.12, 12.05.2023,
    // and 05.13.2023 (month first only when day first is impossible, as in guessit)
    if (dateStart === -1) {
      const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(t);
      if (m && isValidYear(m[1]!) && isoDate(m[1]!, m[2]!, m[3]!)) {
        dateStart = i;
        dateEnd = i;
        airDate = isoDate(m[1]!, m[2]!, m[3]!);
        cls[i] = { kind: "date" };
        continue;
      }
      const a = tokens[i + 1]?.text;
      const b = tokens[i + 2]?.text;
      if (a && b && /^\d{2}$/.test(a)) {
        if (isValidYear(t) && /^\d{2}$/.test(b) && isMonthDay(Number(a), Number(b))) {
          dateStart = i;
          dateEnd = i + 2;
          airDate = isoDate(t, a, b);
        } else if (/^\d{2}$/.test(t) && isValidYear(b) && isMonthDay(Number(a), Number(t))) {
          dateStart = i;
          dateEnd = i + 2;
          airDate = isoDate(b, a, t);
        } else if (/^\d{2}$/.test(t) && isValidYear(b) && isMonthDay(Number(t), Number(a))) {
          dateStart = i;
          dateEnd = i + 2;
          airDate = isoDate(b, t, a);
        }
        if (dateStart === i) {
          for (let k = i; k <= i + 2; k++) cls[k] = { kind: "date" };
          i += 2;
          continue;
        }
      }
    }
  }

  // Year: the first valid year after the first token; a run of consecutive
  // years ("Blade.Runner.2049.2017", "1917.2019") keeps the earlier ones in
  // the title.
  let yearIdx = -1;
  for (let i = 1; i < n; i++) {
    if (cls[i]!.kind === "word" && isValidYear(tokens[i]!.text)) {
      yearIdx = i;
      while (
        yearIdx + 1 < n &&
        cls[yearIdx + 1]!.kind === "word" &&
        isValidYear(tokens[yearIdx + 1]!.text)
      ) {
        yearIdx++;
      }
      break;
    }
  }
  if (yearIdx !== -1) cls[yearIdx] = { kind: "year" };

  // Anchor: the first position where the title has certainly ended. Weak
  // tags (ordinary words such as "Web" or "Extended") only count after it.
  const strongKinds: Kind[] = ["episode", "season", "markerWord", "date", "year", "tech", "part"];
  let anchor = cls.findIndex((c) => strongKinds.includes(c.kind));
  if (anchor === -1) anchor = n;

  // Resolve weak tags right to left so chains of tags all resolve.
  for (let i = n - 1; i >= 0; i--) {
    const c = cls[i]!;
    if (c.kind !== "weak") continue;
    const nextKind = cls[i + 1]?.kind;
    const text = tokens[i]!.text;
    const isTag =
      i > anchor ||
      (i > 0 && isUpper(text) && text.length >= 2) ||
      (i > 0 && (nextKind === "tech" || nextKind === "part"));
    cls[i] = isTag ? { ...c, kind: "tech" } : { kind: "word" };
  }
  const firstTech = cls.findIndex((c) => c.kind === "tech" || c.kind === "part");

  // Trailing bracket group with no release tags becomes the release group.
  let trailingGroupStart = n;
  if (n > 0) {
    const lastBracket = tokens[n - 1]!.bracket;
    if (lastBracket !== -1) {
      const first = tokens.findIndex((t) => t.bracket === lastBracket);
      const inside = cls.slice(first);
      if (first > 0 && inside.every((c) => c.kind === "word")) {
        trailingGroupStart = first;
      }
    }
  }

  // Release tags: first quality/source/codec wins.
  let quality: string | undefined;
  let source: string | undefined;
  let codec: string | undefined;
  let lastTech = -1;
  cls.forEach((c, i) => {
    if (c.kind !== "tech") return;
    quality ??= c.quality;
    source ??= c.source;
    codec ??= c.codec;
    lastTech = i;
  });
  // Text after the last tag is a group only if nothing after it is classified.
  const groupAfter =
    lastTech !== -1 &&
    !cls[lastTech]!.noGroup &&
    cls.slice(lastTech + 1).every((c) => c.kind === "word");
  const ultra = tokens.some((t) => t.text.toLowerCase() === "uhd") || quality === "2160p";
  if (source === "Blu-ray" && ultra) source = "Ultra HD Blu-ray";

  // Release group: text after the last release tag.
  if (group === undefined && groupAfter) {
    const c = cls[lastTech]!;
    const t = tokens[lastTech]!;
    if (c.groupOffset !== undefined) {
      group = cleanGroup(name.slice(t.start + c.groupOffset));
    } else if (lastTech + 1 < n) {
      group = cleanGroup(name.slice(tokens[lastTech + 1]!.start));
    }
  }
  // Radarr-style "{imdb-tt0133093}" tags read as the group when nothing else is.
  if (group === undefined) {
    const brace = brackets.findIndex((b, bi) => {
      if (name[b.start] !== "{") return false;
      const inside = tokens.map((t, i) => [t, i] as const).filter(([t]) => t.bracket === bi);
      return inside.length > 0 && inside.every(([, i]) => cls[i]!.kind === "word");
    });
    if (brace !== -1) {
      const b = brackets[brace]!;
      group = cleanGroup(name.slice(b.start + 1, b.end));
      // Keep the brace text out of titles.
      tokens.forEach((t, i) => {
        if (t.bracket === brace) cls[i] = { kind: "tech", noGroup: true };
      });
    }
  }
  if (group === undefined && trailingGroupStart < n && lastTech === -1) {
    const b = brackets[tokens[trailingGroupStart]!.bracket]!;
    group = cleanGroup(name.slice(b.start + 1, b.end));
  }

  // Generic stop: where any title or episode-title run ends.
  const isStop = (i: number): boolean =>
    i >= trailingGroupStart || cls[i]!.kind !== "word";

  const runFrom = (from: number): Token[] => {
    // Runs never continue into bracketed text ("Title (US)", "- 64 [FuniDub]").
    const run: Token[] = [];
    for (let i = from; i < n && !isStop(i); i++) {
      if (i > 0 && tokens[i]!.bracket !== -1) break;
      run.push(tokens[i]!);
    }
    return run;
  };

  let season: number | undefined;
  let episode: number | undefined;
  let episodeTitle: string | undefined;
  let isEpisode = false;
  let titleTokens: Token[];
  // Every episode number, in filename order (multi-episode files).
  const episodeNumbers: number[] = [];
  const collectEpisodes = (c: Classified): void => {
    for (const number of c.episodes ?? (c.episode !== undefined ? [c.episode] : [])) {
      if (!episodeNumbers.includes(number)) episodeNumbers.push(number);
    }
  };

  const firstMarker = cls.findIndex(
    (c) => c.kind === "episode" || c.kind === "season" || c.kind === "markerWord",
  );

  if (firstMarker !== -1 || dateStart !== -1) {
    isEpisode = true;
    const markerIdx =
      firstMarker === -1 ? dateStart : dateStart === -1 ? firstMarker : Math.min(firstMarker, dateStart);
    // Collect season/episode from all markers; the first of each wins.
    let lastMarker = markerIdx;
    for (let i = markerIdx; i < n; i++) {
      const c = cls[i]!;
      if (c.kind === "episode" || c.kind === "season" || c.kind === "markerWord" || c.kind === "date") {
        if (c.kind === "date" && i > dateEnd) break;
        // "S01E01.S02E01": a second season ends the episode list (guessit
        // reports two seasons; ParsedInfo keeps the first).
        const otherSeason = season !== undefined && c.season !== undefined && c.season !== season;
        season ??= c.season;
        episode ??= c.episode;
        if (c.kind === "episode" && !otherSeason) collectEpisodes(c);
        lastMarker = i;
      } else {
        break;
      }
    }
    // Later markers of the same season ("S01E01.1080p.E02", "S01E01.and.E02").
    for (let i = lastMarker + 1; i < n; i++) {
      const c = cls[i]!;
      if (c.kind === "episode" && cls[i - 1]!.kind !== "markerWord" && (c.season === undefined || c.season === season)) {
        collectEpisodes(c);
      }
    }
    titleTokens = cutAtDash(runFrom(0));
    const after = cutAtDash(runFrom(lastMarker + 1));
    episodeTitle = after.length ? joinTokens(after) : undefined;
  } else {
    // No explicit marker. Look for guessit's number-based episode patterns,
    // which only apply when there is no year.
    titleTokens = cutAtDash(runFrom(0));
    const stopAt = firstTech === -1 ? n : firstTech;

    if (yearIdx === -1) {
      // (a) "Title - 05", "Artist - Album - 06 - Track"
      let dashNum = -1;
      for (let i = 1; i < Math.min(stopAt, trailingGroupStart); i++) {
        const t = tokens[i]!;
        const following = i + 1 < n ? tokens[i + 1]! : undefined;
        if (
          t.dashBefore &&
          t.bracket === -1 &&
          (/^\d{1,4}$/.test(t.text) || animeEpisodes(t.text) !== undefined) &&
          (!following || following.dashBefore || following.bracket !== -1 || isStop(i + 1))
        ) {
          dashNum = i;
          break;
        }
      }
      const leadNum = n > 1 && tokens[0]!.bracket === -1 && /^\d{2,3}$/.test(tokens[0]!.text);

      if (dashNum !== -1) {
        isEpisode = true;
        const digits = tokens[dashNum]!.text;
        // "- 12v2" (a second version) and "- 01-02" / "- 01~02" (a range).
        const anime = animeEpisodes(digits);
        if (anime) {
          episode = anime[0];
          if (anime.length > 1) episodeNumbers.push(...anime);
        } else if (lead) {
          episode = Number(digits);
        } else {
          ({ season, episode } = splitSeasonEpisode(digits));
        }
        titleTokens = cutAtDash(runFrom(0));
        let after = cutAtDash(runFrom(dashNum + 1));
        // "- 01 - 03": guessit reads two episodes (a list, not a range).
        if (
          season === undefined &&
          after.length === 1 &&
          after[0]!.dashBefore &&
          /^\d{1,4}(?:v\d)?$/.test(after[0]!.text)
        ) {
          const second = Number(/^\d+/.exec(after[0]!.text)![0]);
          if (episodeNumbers.length === 0) episodeNumbers.push(episode!);
          if (!episodeNumbers.includes(second)) episodeNumbers.push(second);
          after = [];
        }
        episodeTitle = after.length ? joinTokens(after) : undefined;
      } else if (leadNum) {
        // (b) "01 - Title", "12 Angry Men", "101 Dalmatians"
        isEpisode = true;
        ({ season, episode } = splitSeasonEpisode(tokens[0]!.text));
        // cutAtDash ignores a dash before the first token of a run.
        titleTokens = cutAtDash(runFrom(1));
        const next = 1 + titleTokens.length;
        if (next < n && tokens[next]!.dashBefore) {
          const tail = cutAtDash(runFrom(next));
          episodeTitle = tail.length ? joinTokens(tail) : undefined;
        }
      } else if (titleTokens.length >= 2) {
        // (c) "Apollo 13", "Show.105", "Track 01"
        const last = titleTokens[titleTokens.length - 1]!;
        if (last.bracket === -1 && /^\d{2,4}$/.test(last.text)) {
          isEpisode = true;
          ({ season, episode } = splitSeasonEpisode(last.text));
          titleTokens = titleTokens.slice(0, -1);
        }
      }
    }
  }

  let year = yearIdx !== -1 ? Number(tokens[yearIdx]!.text) : undefined;
  // guessit reports a year-like season number ("S2023E05") as the year too.
  if (year === undefined && season !== undefined && isValidYear(String(season))) {
    year = season;
  }

  const mediaType: MediaType = isEpisode ? "tv_episode" : "movie";

  return compact({
    title: joinTokens(titleTokens),
    year,
    season,
    episode,
    episodes: isEpisode && episodeNumbers.length > 1 ? episodeNumbers : undefined,
    airDate: isEpisode ? airDate : undefined,
    episodeTitle: isEpisode ? episodeTitle : undefined,
    mediaType,
    quality,
    source,
    codec,
    group,
    ...releaseDetails(
      tokens.map((t, i) => {
        // "DTS-FGT": only the part before the release group is a tag.
        const offset = cls[i]!.groupOffset;
        return { text: offset === undefined ? t.text : t.text.slice(0, offset - 1), tag: cls[i]!.kind === "tech" };
      }),
      filename,
    ),
    rawFilename: filename,
  });
}

// ---------------------------------------------------------------------------
// RegexParser (port of the Python fallback)
// ---------------------------------------------------------------------------

/** Fallback regex-based parser for simple cases. */
export class RegexParser implements FilenameParser {
  static readonly TV_PATTERNS: readonly RegExp[] = [
    // S01E02 format
    /^(?<title>.+?)[.\s_-]+S(?<season>\d{1,2})E(?<episode>\d{1,2})/i,
    // 1x02 format
    /^(?<title>.+?)[.\s_-]+(?<season>\d{1,2})x(?<episode>\d{1,2})/i,
  ];

  static readonly MOVIE_PATTERNS: readonly RegExp[] = [
    // Title (Year) format
    /^(?<title>.+?)\s*\((?<year>(?:19|20)\d{2})\)/,
    // Title.Year format
    /^(?<title>.+?)[.\s_-]+(?<year>(?:19|20)\d{2})[.\s_-]/,
  ];

  static readonly QUALITY_PATTERN = /(2160p|1080p|720p|480p)/i;
  static readonly SOURCE_PATTERN = /(BluRay|Blu-Ray|BDRip|BRRip|WEB-DL|WEBRip|HDTV|DVDRip)/i;
  static readonly CODEC_PATTERN = /(x264|x265|H\.?264|H\.?265|HEVC|XviD)/i;
  static readonly GROUP_PATTERN = /-([A-Za-z0-9]+)(?:\.[^.]+)?$/;

  parse(filename: string): ParsedInfo {
    // Remove extension for parsing
    const nameWithoutExt = filename.replace(/\.[^.]+$/, "");

    // Try TV patterns first
    for (const pattern of RegexParser.TV_PATTERNS) {
      const match = pattern.exec(nameWithoutExt);
      if (match?.groups) {
        return this.buildParsedInfo({
          filename,
          title: this.cleanTitle(match.groups.title!),
          season: Number.parseInt(match.groups.season!, 10),
          episode: Number.parseInt(match.groups.episode!, 10),
          mediaType: "tv_episode",
          remaining: nameWithoutExt.slice(match[0].length),
        });
      }
    }

    // Try movie patterns
    for (const pattern of RegexParser.MOVIE_PATTERNS) {
      const match = pattern.exec(nameWithoutExt);
      if (match?.groups) {
        return this.buildParsedInfo({
          filename,
          title: this.cleanTitle(match.groups.title!),
          year: Number.parseInt(match.groups.year!, 10),
          mediaType: "movie",
          remaining: nameWithoutExt.slice(match[0].length),
        });
      }
    }

    // Unable to parse, return with just the title
    return compact({
      title: this.cleanTitle(nameWithoutExt),
      mediaType: "unknown",
      rawFilename: filename,
    });
  }

  /** Clean up a title by replacing separators with spaces. */
  private cleanTitle(title: string): string {
    return title.replace(/[._]/g, " ").replace(/\s+/g, " ").trim();
  }

  /** Build ParsedInfo with additional metadata from the remaining text. */
  private buildParsedInfo(args: {
    filename: string;
    title: string;
    remaining: string;
    mediaType: MediaType;
    year?: number;
    season?: number;
    episode?: number;
  }): ParsedInfo {
    const { filename, remaining } = args;
    const quality = RegexParser.QUALITY_PATTERN.exec(remaining)?.[1];
    const source = RegexParser.SOURCE_PATTERN.exec(remaining)?.[1];
    const codec = RegexParser.CODEC_PATTERN.exec(remaining)?.[1];
    const group = RegexParser.GROUP_PATTERN.exec(filename)?.[1];

    return compact({
      title: args.title,
      year: args.year,
      season: args.season,
      episode: args.episode,
      mediaType: args.mediaType,
      quality,
      source,
      codec,
      group,
      rawFilename: filename,
    });
  }
}

/**
 * Create a filename parser instance.
 *
 * @param useGuessit If true, use the guessit-compatible parser. If false,
 *   use the regex fallback.
 */
export function createParser(useGuessit = true): FilenameParser {
  return useGuessit ? new GuessItParser() : new RegexParser();
}
