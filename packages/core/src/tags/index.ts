/**
 * Reading and rewriting tags in music files, for the formats TidyTitles can
 * write: MP3 (ID3v2.3/2.4), FLAC, MP4 audio (.m4a), Ogg Vorbis, and Ogg
 * Opus. See the handler of each format for what it keeps and what it
 * refuses.
 */

import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { parseFlac } from "./flac";
import { parseMp3 } from "./id3";
import { parseMp4 } from "./mp4";
import { parseOgg } from "./ogg";
import { fileSource, fingerprintFile, rewriteFile, type RewriteHooks } from "./rewrite";
import type { FileFingerprint } from "../transfer";
import { TAG_FIELDS, type FieldChanges, type ParsedTags, type TagField } from "./types";

export * from "./types";
export { RewriteError, setMtimeNs, type RewriteFailure, type RewriteHooks } from "./rewrite";

/** File extensions whose tags can be written. */
export const TAG_WRITE_EXTENSIONS: ReadonlySet<string> = new Set([".mp3", ".flac", ".m4a", ".ogg", ".oga", ".opus"]);

export function canWriteTags(filePath: string): boolean {
  return TAG_WRITE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function parserFor(filePath: string) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".mp3":
      return parseMp3;
    case ".flac":
      return parseFlac;
    case ".m4a":
      return parseMp4;
    case ".ogg":
    case ".oga":
    case ".opus":
      return parseOgg;
    default:
      return undefined;
  }
}

/**
 * Read the writable tags of a file, as the format of its extension (or of
 * `formatOf`, a path whose extension names the format).
 * @throws TagLayoutError, or a filesystem error.
 */
export async function readTags(filePath: string, formatOf: string = filePath): Promise<ParsedTags> {
  const parse = parserFor(formatOf);
  if (!parse) throw new Error(`Tags of ${path.extname(formatOf)} files cannot be written`);
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    return await parse(fileSource(handle, size));
  } finally {
    await handle.close();
  }
}

export interface ApplyTagChangesResult {
  /** The tags as they were before. */
  before: ParsedTags;
  /** The file after the rewrite. */
  fingerprint: FileFingerprint;
}

/**
 * Rewrite `filePath` with `changes` (safely: see rewrite.ts). Every field
 * not in `changes` keeps its exact entries; afterward the rewritten file is
 * parsed again and must show `expect` (the changed fields' entries, or the
 * values written) before it replaces the original.
 * @throws TagLayoutError, RewriteError, or a filesystem error; the file is
 *   then unchanged.
 */
export async function applyTagChanges(
  filePath: string,
  changes: (current: ParsedTags) => FieldChanges,
  options: { targetRegionSize?: number; hooks?: RewriteHooks } = {},
): Promise<ApplyTagChangesResult> {
  const parse = parserFor(filePath);
  if (!parse) throw new Error(`Tags of ${path.extname(filePath)} files cannot be written`);
  const before = await fingerprintFile(filePath);
  const handle = await open(filePath, "r");
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await handle.close();
    }
  };
  let current: ParsedTags;
  try {
    const { size } = await handle.stat();
    const source = fileSource(handle, size);
    current = await parse(source);
    const wanted = changes(current);
    const plan = current.plan(wanted, options.targetRegionSize !== undefined ? { targetRegionSize: options.targetRegionSize } : {});
    await rewriteFile(
      filePath,
      source,
      before,
      plan,
      async (temp) => {
        const after = await readTags(temp, filePath);
        checkResult(current, after, wanted);
      },
      options.hooks,
      close,
    );
  } finally {
    await close();
  }
  const s = await lstat(filePath, { bigint: true });
  return {
    before: current,
    fingerprint: { dev: String(s.dev), ino: String(s.ino), size: String(s.size), mtimeNs: String(s.mtimeNs) },
  };
}

function sameEntries(a: readonly Buffer[], b: readonly Buffer[]): boolean {
  return a.length === b.length && a.every((x, i) => x.equals(b[i]!));
}

/** The rewritten file must hold the changes, and every other field exactly as before. */
function checkResult(before: ParsedTags, after: ParsedTags, changes: FieldChanges): void {
  if (after.format !== before.format) throw new Error("the format changed");
  for (const field of TAG_FIELDS as TagField[]) {
    const change = changes[field];
    if (!change) {
      if (!sameEntries(before.raw[field], after.raw[field])) throw new Error(`${field} changed unexpectedly`);
    } else if (change.kind === "raw") {
      if (!sameEntries(change.entries, after.raw[field])) throw new Error(`${field} was not restored`);
    } else {
      const want = JSON.stringify(change.values[field] ?? null);
      const got = JSON.stringify(after.values[field] ?? null);
      if (want !== got) throw new Error(`${field} reads back as ${got}, not ${want}`);
    }
  }
}
