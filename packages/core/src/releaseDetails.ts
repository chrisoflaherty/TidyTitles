/**
 * Release details beyond quality, source, and codec: edition, audio codec,
 * audio channels, and HDR format.
 *
 * The filename parser (`parser.ts`) decides which tokens are release tags;
 * this module only names the tags it is given, with guessit's normalized
 * names ("Director's Cut", "Dolby Digital Plus", "5.1", "HDR10"), so the
 * results agree with guessit 3.8.0. Agreement is measured by
 * `scripts/parser-parity.ts`.
 *
 * Deliberate gaps, where guessit reports nothing and so does this module:
 * "Final Cut", "Ultimate Cut", "Anniversary Edition", "DoVi", "HDR10Plus",
 * "HLG", and channel layouts other than 2.0, 5.1, and 7.1. guessit reads
 * "HDR10+" as HDR10. Like guessit, an .mp3, .flac, .opus, or .aac file
 * reports its format as the audio codec.
 */

/** A token of the filename, and whether the parser classified it as a release tag. */
export interface ReleaseToken {
  text: string;
  tag: boolean;
}

/** Release details found in a filename. Several values are joined with ", ". */
export interface ReleaseDetails {
  edition?: string;
  audioCodec?: string;
  audioChannels?: string;
  hdr?: string;
}

/** Separator between several values of one field ("Extended, Remastered"). */
export const MULTI_VALUE_SEPARATOR = ", ";

/** Single tags that name an edition. */
const EDITIONS: Record<string, string> = {
  extended: "Extended",
  remastered: "Remastered",
  unrated: "Unrated",
  uncut: "Uncut",
  theatrical: "Theatrical",
  criterion: "Criterion",
  limited: "Limited",
  imax: "IMAX",
  restored: "Restored",
};

/** Words that name an edition when followed by "Edition". */
const EDITION_WORDS: Record<string, string> = {
  special: "Special",
  collector: "Collector",
  collectors: "Collector",
  "collector's": "Collector",
};

const DIRECTORS = new Set(["director's", "directors", "director"]);

const AUDIO_CODECS: Record<string, string> = {
  dts: "DTS",
  "dts-hd": "DTS-HD",
  dtshd: "DTS-HD",
  "dts-hdma": "DTS-HD",
  hdma: "DTS-HD",
  "dts-x": "DTS:X",
  truehd: "Dolby TrueHD",
  atmos: "Dolby Atmos",
  ddp: "Dolby Digital Plus",
  "dd+": "Dolby Digital Plus",
  eac3: "Dolby Digital Plus",
  dd: "Dolby Digital",
  ac3: "Dolby Digital",
  aac: "AAC",
  flac: "FLAC",
  lpcm: "LPCM",
  pcm: "PCM",
  opus: "Opus",
  mp3: "MP3",
};

const HDR_FORMATS: Record<string, string> = {
  hdr: "HDR10",
  hdr10: "HDR10",
  "hdr10+": "HDR10",
  dv: "Dolby Vision",
};

/** "5.1", or a codec glued to its channels: "DDP5.1", "AAC2.0", "TrueHD7.1". */
const CHANNELS = /^(ddp|dd|aac|dts|e?ac3|truehd|flac|opus|l?pcm)?([2-9]\.[01])$/i;
/** The channel layouts guessit knows; it reads "6.1" or "2.1" as something else. */
const KNOWN_CHANNELS = new Set(["2.0", "5.1", "7.1"]);

/** Audio file extensions that guessit also reports as the audio codec. */
const EXTENSION_CODECS: Record<string, string> = {
  mp3: "MP3",
  flac: "FLAC",
  opus: "Opus",
  aac: "AAC",
};

function add(list: string[], value: string | undefined): void {
  if (value !== undefined && !list.includes(value)) list.push(value);
}

function join(list: string[]): string | undefined {
  return list.length ? list.join(MULTI_VALUE_SEPARATOR) : undefined;
}

/** Name the edition, audio, and HDR tags among the release tags of a filename. */
export function releaseDetails(tokens: readonly ReleaseToken[], filename = ""): ReleaseDetails {
  const editions: string[] = [];
  const audio: string[] = [];
  const hdr: string[] = [];
  let channels: string | undefined;

  tokens.forEach((token, i) => {
    const lower = token.text.toLowerCase();
    const next = tokens[i + 1]?.text.toLowerCase();
    const prev = tokens[i - 1]?.text.toLowerCase();

    // "DD+5.1" splits into "DD+5" and "1", which the parser leaves as words.
    const plus = /^dd\+([2-9])$/i.exec(token.text);
    if (plus && i > 0 && next !== undefined && /^[01]$/.test(next)) {
      add(audio, "Dolby Digital Plus");
      channels ??= `${plus[1]}.${next}`;
      return;
    }
    if (!token.tag) return;

    if (DIRECTORS.has(lower) && next === "cut") {
      add(editions, "Director's Cut");
      return;
    }
    if (lower === "edition" && prev !== undefined && Object.hasOwn(EDITION_WORDS, prev)) {
      add(editions, EDITION_WORDS[prev]);
      return;
    }
    if (Object.hasOwn(EDITIONS, lower)) {
      add(editions, EDITIONS[lower]);
      return;
    }

    const glued = CHANNELS.exec(token.text);
    if (glued) {
      if (glued[1]) add(audio, AUDIO_CODECS[glued[1].toLowerCase()]);
      if (KNOWN_CHANNELS.has(glued[2]!)) channels ??= glued[2];
      return;
    }
    if (Object.hasOwn(AUDIO_CODECS, lower)) {
      // "DD" is also a weak tag in names such as "DD.5.1"; it is a codec either way.
      add(audio, AUDIO_CODECS[lower]);
      return;
    }
    if (Object.hasOwn(HDR_FORMATS, lower)) {
      // "DV" is only a tag when written in capitals; the parser decides that.
      add(hdr, HDR_FORMATS[lower]);
    }
  });

  const extension = /\.([A-Za-z0-9]+)$/.exec(filename)?.[1]?.toLowerCase();
  if (extension && Object.hasOwn(EXTENSION_CODECS, extension)) add(audio, EXTENSION_CODECS[extension]);

  const details: ReleaseDetails = {};
  const edition = join(editions);
  const audioCodec = join(audio);
  const hdrFormat = join(hdr);
  if (edition) details.edition = edition;
  if (audioCodec) details.audioCodec = audioCodec;
  if (channels) details.audioChannels = channels;
  if (hdrFormat) details.hdr = hdrFormat;
  return details;
}
