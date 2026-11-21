/**
 * Rewriting a file safely.
 *
 * The new contents are written to a hidden temporary file next to the
 * original (`.…tidytitles-tmp`, the same naming as transfers), checked, and
 * only then put in place with one rename. On any failure the temporary
 * file is removed and the original was never touched, so a failure or a
 * crash leaves at most a temporary file, never a half-written file under
 * the real name.
 *
 * The temporary file starts as a copy of the original (a clone where the
 * filesystem supports it), so permissions and, on macOS, extended
 * attributes carry over, and ranges that stay at the same offset need no
 * writing at all.
 */

import { constants } from "node:fs";
import { copyFile, lstat, open, rename, unlink, utimes, type FileHandle } from "node:fs/promises";
import { temporaryNameFor, unchangedSince, type FileFingerprint } from "../transfer";
import { parsePage, sealPage } from "./ogg";
import { TagLayoutError, type ByteSource, type RewritePlan } from "./types";

const CHUNK = 1024 * 1024;

/** Hooks for tests: fail in the middle of a write, or change the file before it is replaced. */
export interface RewriteHooks {
  /** Called after each write to the temporary file with the bytes written so far. */
  onWrite?: (written: number) => void;
  /** Called after the temporary file is complete, just before the original is replaced. */
  beforeReplace?: (tempPath: string) => void | Promise<void>;
}

/** Why a rewrite was abandoned. */
export type RewriteFailure = "write_failed" | "changed_during_write" | "verify_failed";

export class RewriteError extends Error {
  readonly reason: RewriteFailure;
  constructor(reason: RewriteFailure, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RewriteError";
    this.reason = reason;
  }
}

/** A ByteSource on an open file. */
export function fileSource(handle: FileHandle, size: number): ByteSource {
  return {
    size,
    async read(position: number, length: number): Promise<Buffer> {
      const len = Math.max(0, Math.min(length, size - position));
      const buf = Buffer.alloc(len);
      let done = 0;
      while (done < len) {
        const { bytesRead } = await handle.read(buf, done, len - done, position + done);
        if (bytesRead === 0) break;
        done += bytesRead;
      }
      return done === len ? buf : buf.subarray(0, done);
    },
  };
}

export async function fingerprintFile(p: string): Promise<FileFingerprint> {
  const s = await lstat(p, { bigint: true });
  return { dev: String(s.dev), ino: String(s.ino), size: String(s.size), mtimeNs: String(s.mtimeNs) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Write `plan` to a temporary copy of `file`, run `verify` on it, and put it
 * in place. `source` must read the original (`file`), which must still be
 * exactly as it was when `before` was taken; otherwise nothing is replaced.
 * @throws RewriteError, TagLayoutError (from `verify` or an Ogg page copy)
 */
export async function rewriteFile(
  file: string,
  source: ByteSource,
  before: FileFingerprint,
  plan: RewritePlan,
  verify: (tempPath: string) => Promise<void>,
  hooks: RewriteHooks = {},
  /** Called once the original is no longer read (close it, so Windows lets it be replaced). */
  releaseSource?: () => Promise<void>,
): Promise<void> {
  const temp = temporaryNameFor(file);
  let created = false;
  try {
    try {
      await copyFile(file, temp, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      created = true;
    } catch (error) {
      throw new RewriteError("write_failed", `Could not create a temporary file: ${errorText(error)}`, { cause: error });
    }
    const out = await open(temp, "r+");
    let written = 0;
    try {
      const write = async (data: Buffer, position: number) => {
        let done = 0;
        while (done < data.length) {
          const { bytesWritten } = await out.write(data, done, data.length - done, position + done);
          done += bytesWritten;
        }
        written += data.length;
        hooks.onWrite?.(written);
      };
      let position = 0;
      for (const segment of plan.segments) {
        if (segment.kind === "bytes") {
          await write(segment.data, position);
          position += segment.data.length;
        } else if (segment.kind === "copy") {
          // The temporary file is a copy of the original: a range that stays
          // at its offset is already in place.
          if (segment.start !== position) {
            for (let at = segment.start; at < segment.end; at += CHUNK) {
              await write(await source.read(at, Math.min(CHUNK, segment.end - at)), position + (at - segment.start));
            }
          }
          position += segment.end - segment.start;
        } else {
          position = await copyOggPages(source, segment, position, write);
        }
      }
      if (position !== plan.size) throw new RewriteError("write_failed", "The rewritten file has an unexpected size");
      await out.truncate(plan.size);
      await out.sync();
    } catch (error) {
      if (error instanceof RewriteError || error instanceof TagLayoutError) throw error;
      throw new RewriteError("write_failed", `Could not write the file: ${errorText(error)}`, { cause: error });
    } finally {
      await out.close().catch(() => undefined);
    }
    await releaseSource?.();

    try {
      await verify(temp);
    } catch (error) {
      throw new RewriteError("verify_failed", `The rewritten file did not check out: ${errorText(error)}`, { cause: error });
    }
    await hooks.beforeReplace?.(temp);

    // Last check: nobody changed the original while it was being rewritten.
    const now = await fingerprintFile(file).catch(() => undefined);
    if (!now || !unchangedSince(now, before)) {
      throw new RewriteError("changed_during_write", "The file changed while its tags were being written");
    }
    try {
      await rename(temp, file);
      created = false;
    } catch (error) {
      throw new RewriteError("write_failed", `Could not replace the file: ${errorText(error)}`, { cause: error });
    }
  } finally {
    if (created) await unlink(temp).catch(() => undefined);
  }
}

/**
 * Copy Ogg pages, shifting the sequence numbers of the stream's pages (up to
 * and including its last page) and recomputing their checksums. Pages of a
 * chained stream that follows keep their numbers. Returns the new position.
 */
async function copyOggPages(
  source: ByteSource,
  segment: { start: number; end: number; serial: number; seqDelta: number },
  position: number,
  write: (data: Buffer, position: number) => Promise<void>,
): Promise<number> {
  let buf = Buffer.alloc(0);
  let bufStart = segment.start;
  let next = segment.start;
  let ended = false;
  for (;;) {
    let offset = 0;
    const out: Buffer[] = [];
    for (;;) {
      const page = parsePage(buf, offset, bufStart + offset);
      if (!page) break;
      const bytes = Buffer.from(buf.subarray(offset, offset + page.length));
      if (!ended && page.serial === segment.serial) {
        bytes.writeUInt32LE((page.seq + segment.seqDelta) >>> 0, 18);
        sealPage(bytes);
        if (page.headerType & 0x04) ended = true;
      }
      out.push(bytes);
      offset += page.length;
    }
    if (out.length > 0) {
      const data = Buffer.concat(out);
      await write(data, position);
      position += data.length;
    }
    buf = buf.subarray(offset);
    bufStart += offset;
    if (next >= segment.end) break;
    const chunk = await source.read(next, Math.min(CHUNK, segment.end - next));
    if (chunk.length === 0) break;
    next += chunk.length;
    buf = Buffer.concat([buf, chunk]);
  }
  if (buf.length > 0) throw new TagLayoutError("Unexpected data at the end of the Ogg stream");
  return position;
}

/** Set a file's modification (and access) time from nanoseconds. Best effort. */
export async function setMtimeNs(file: string, mtimeNs: string): Promise<void> {
  const seconds = Number(BigInt(mtimeNs) / 1000n) / 1e6;
  await utimes(file, seconds, seconds).catch(() => undefined);
}
