/**
 * Metadata languages: the `[metadata] language` setting.
 *
 * The setting stores a TMDB language code: an ISO 639-1 language, usually
 * with an ISO 3166-1 region ("en-US", "pt-BR"), which is what TMDB's
 * `language` parameter takes. TVDB names languages with three-letter codes
 * ("eng", "por"); `tvdbLanguageCode` converts.
 */

/** Default metadata language: English (United States), TMDB's old fixed value. */
export const DEFAULT_METADATA_LANGUAGE = "en-US";

/** A language offered in the settings, with its name in English. */
export interface MetadataLanguage {
  /** Stored code, as TMDB takes it. */
  code: string;
  /** Name shown in the settings, in English. */
  name: string;
  /** TVDB's three-letter code for the same language. */
  tvdb: string;
}

/** Common languages, in the order the settings list them (English first, then by name). */
export const METADATA_LANGUAGES: readonly MetadataLanguage[] = [
  { code: "en-US", name: "English", tvdb: "eng" },
  { code: "ar-SA", name: "Arabic", tvdb: "ara" },
  { code: "zh-CN", name: "Chinese (Simplified)", tvdb: "zho" },
  { code: "zh-TW", name: "Chinese (Traditional)", tvdb: "zhtw" },
  { code: "cs-CZ", name: "Czech", tvdb: "ces" },
  { code: "da-DK", name: "Danish", tvdb: "dan" },
  { code: "nl-NL", name: "Dutch", tvdb: "nld" },
  { code: "fi-FI", name: "Finnish", tvdb: "fin" },
  { code: "fr-FR", name: "French", tvdb: "fra" },
  { code: "fr-CA", name: "French (Canada)", tvdb: "fra" },
  { code: "de-DE", name: "German", tvdb: "deu" },
  { code: "el-GR", name: "Greek", tvdb: "ell" },
  { code: "he-IL", name: "Hebrew", tvdb: "heb" },
  { code: "hi-IN", name: "Hindi", tvdb: "hin" },
  { code: "hu-HU", name: "Hungarian", tvdb: "hun" },
  { code: "id-ID", name: "Indonesian", tvdb: "ind" },
  { code: "it-IT", name: "Italian", tvdb: "ita" },
  { code: "ja-JP", name: "Japanese", tvdb: "jpn" },
  { code: "ko-KR", name: "Korean", tvdb: "kor" },
  { code: "no-NO", name: "Norwegian", tvdb: "nor" },
  { code: "pl-PL", name: "Polish", tvdb: "pol" },
  { code: "pt-BR", name: "Portuguese (Brazil)", tvdb: "pt" },
  { code: "pt-PT", name: "Portuguese (Portugal)", tvdb: "por" },
  { code: "ru-RU", name: "Russian", tvdb: "rus" },
  { code: "es-ES", name: "Spanish (Spain)", tvdb: "spa" },
  { code: "es-MX", name: "Spanish (Latin America)", tvdb: "spa" },
  { code: "sv-SE", name: "Swedish", tvdb: "swe" },
  { code: "th-TH", name: "Thai", tvdb: "tha" },
  { code: "tr-TR", name: "Turkish", tvdb: "tur" },
  { code: "uk-UA", name: "Ukrainian", tvdb: "ukr" },
  { code: "vi-VN", name: "Vietnamese", tvdb: "vie" },
];

/** TVDB code by ISO 639-1 language, for codes not in the list ("de", "de-AT"). */
const TVDB_BY_LANGUAGE: Record<string, string> = Object.fromEntries(
  METADATA_LANGUAGES.filter((l) => !["zh-TW", "pt-BR"].includes(l.code)).map((l) => [
    l.code.slice(0, 2),
    l.tvdb,
  ]),
);

/** "en", "en-US", "pt-BR": an ISO 639-1 language with an optional region. */
const LANGUAGE_CODE = /^[a-z]{2}(?:-[A-Z]{2})?$/;

/** True for a code the setting accepts ("de", "de-DE"). */
export function isMetadataLanguageCode(code: string): boolean {
  return LANGUAGE_CODE.test(code);
}

/**
 * Normalize user input ("DE-de", " pt_br ") to the stored form ("de-DE",
 * "pt-BR"), or `undefined` when it is not a language code.
 */
export function normalizeMetadataLanguage(input: string): string | undefined {
  const m = /^([A-Za-z]{2})(?:[-_]([A-Za-z]{2}))?$/.exec(input.trim());
  if (!m) return undefined;
  return m[2] ? `${m[1]!.toLowerCase()}-${m[2].toUpperCase()}` : m[1]!.toLowerCase();
}

/** The list entry for a code, if it is one of the common languages. */
export function findMetadataLanguage(code: string): MetadataLanguage | undefined {
  return METADATA_LANGUAGES.find((l) => l.code === code);
}

/** The English name for a code ("German"), or the code itself when it is not listed. */
export function metadataLanguageName(code: string): string {
  return findMetadataLanguage(code)?.name ?? code;
}

/** TVDB's three-letter language code for a stored code ("pt-BR" -> "pt", "de" -> "deu"). */
export function tvdbLanguageCode(code: string): string {
  const listed = findMetadataLanguage(code);
  if (listed) return listed.tvdb;
  if (/^zh-(?:TW|HK|MO)$/.test(code)) return "zhtw";
  if (code === "pt-BR") return "pt";
  return TVDB_BY_LANGUAGE[code.slice(0, 2)] ?? "eng";
}

/** True when the code is English (any region). */
export function isEnglish(code: string): boolean {
  return code.slice(0, 2) === "en";
}
