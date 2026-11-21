/**
 * FLAC files: the VORBIS_COMMENT metadata block.
 *
 * Every other metadata block (STREAMINFO, SEEKTABLE, PICTURE artwork,
 * APPLICATION, CUESHEET) is copied byte for byte and keeps its order; only
 * the "last block" flag in a block header can change. The audio frames are
 * copied verbatim. A PADDING block absorbs the change in size where it
 * can, so the audio stays where it was. An ID3v2 tag in front of "fLaC"
 * (written by some taggers) is kept as it is.
 */

import {
  TagLayoutError,
  type ByteSource,
  type FieldChanges,
  type ParsedTags,
  type RewritePlan,
  type Segment,
} from "./types";
import {
  applyVorbisChanges,
  parseVorbisComments,
  serializeVorbisComments,
  vorbisRaw,
  vorbisValues,
  type VorbisComments,
} from "./vorbisComment";

const STREAMINFO = 0;
const PADDING = 1;
const VORBIS_COMMENT = 4;
const MAX_BLOCK = 0xffffff;
/** Padding added when the metadata has to grow and the file had a padding block. */
export const FLAC_GROWTH_PADDING = 1024;

interface Block {
  type: number;
  /** Offset of the 4-byte block header. */
  start: number;
  length: number;
}

function syncsafe(buf: Buffer, offset: number): number {
  return ((buf[offset]! & 0x7f) << 21) | ((buf[offset + 1]! & 0x7f) << 14) | ((buf[offset + 2]! & 0x7f) << 7) | (buf[offset + 3]! & 0x7f);
}

function blockHeader(type: number, length: number, last: boolean): Buffer {
  if (length > MAX_BLOCK) throw new TagLayoutError("A FLAC metadata block would be too large");
  return Buffer.from([(last ? 0x80 : 0) | type, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
}

export async function parseFlac(src: ByteSource): Promise<ParsedTags> {
  let prefix = 0;
  const first = await src.read(0, Math.min(10, src.size));
  if (first.length >= 10 && first.toString("latin1", 0, 3) === "ID3") {
    prefix = 10 + syncsafe(first, 6) + (first[5]! & 0x10 ? 10 : 0);
  }
  const magic = await src.read(prefix, 4);
  if (magic.toString("latin1") !== "fLaC") throw new TagLayoutError("Not a FLAC stream");

  const blocks: Block[] = [];
  let pos = prefix + 4;
  for (;;) {
    const header = await src.read(pos, 4);
    if (header.length < 4) throw new TagLayoutError("Truncated FLAC metadata");
    const type = header[0]! & 0x7f;
    const last = (header[0]! & 0x80) !== 0;
    const length = (header[1]! << 16) | (header[2]! << 8) | header[3]!;
    if (type === 127) throw new TagLayoutError("Invalid FLAC metadata block");
    if (pos + 4 + length > src.size) throw new TagLayoutError("Truncated FLAC metadata");
    blocks.push({ type, start: pos, length });
    pos += 4 + length;
    if (last) break;
  }
  const audioStart = pos;
  if (blocks[0]?.type !== STREAMINFO) throw new TagLayoutError("FLAC metadata does not start with STREAMINFO");
  const commentBlocks = blocks.filter((b) => b.type === VORBIS_COMMENT);
  if (commentBlocks.length > 1) throw new TagLayoutError("More than one FLAC comment block");

  let vc: VorbisComments;
  if (commentBlocks[0]) {
    const data = await src.read(commentBlocks[0].start + 4, commentBlocks[0].length);
    vc = parseVorbisComments(data);
    // FLAC comment blocks have no framing bit; anything after the list is unexpected.
    if (vc.trailer.length > 0) throw new TagLayoutError("Unexpected data after the FLAC comments");
  } else {
    vc = { vendor: Buffer.from("TidyTitles", "utf8"), comments: [], trailer: Buffer.alloc(0) };
  }
  const padding = blocks.find((b) => b.type === PADDING);

  return {
    format: "flac",
    values: vorbisValues(vc),
    raw: vorbisRaw(vc),
    regionSize: audioStart,
    plan(changes: FieldChanges, options = {}): RewritePlan {
      const target = options.targetRegionSize ?? audioStart;
      const commentBody = serializeVorbisComments(applyVorbisChanges(vc, changes));
      // The blocks in order; a missing comment block goes right after STREAMINFO.
      type Out = { type: number; body: Buffer | { start: number; end: number }; padding?: true };
      const out: Out[] = [];
      for (const block of blocks) {
        if (block.type === VORBIS_COMMENT) out.push({ type: VORBIS_COMMENT, body: commentBody });
        else if (block === padding) out.push({ type: PADDING, body: Buffer.alloc(0), padding: true });
        else out.push({ type: block.type, body: { start: block.start + 4, end: block.start + 4 + block.length } });
        if (block.type === STREAMINFO && commentBlocks.length === 0) out.push({ type: VORBIS_COMMENT, body: commentBody });
      }
      const bodyLength = (o: Out) => (Buffer.isBuffer(o.body) ? o.body.length : o.body.end - o.body.start);
      const base = prefix + 4 + out.filter((o) => !o.padding).reduce((n, o) => n + 4 + bodyLength(o), 0);

      // Keep the metadata at its size where padding allows.
      const room = target - base - 4;
      const padIndex = out.findIndex((o) => o.padding);
      if (padIndex >= 0) {
        if (room >= 0) out[padIndex]!.body = Buffer.alloc(room);
        else if (target === base) out.splice(padIndex, 1);
        else out[padIndex]!.body = Buffer.alloc(FLAC_GROWTH_PADDING);
      } else if (room >= 0) {
        out.push({ type: PADDING, body: Buffer.alloc(room), padding: true });
      }

      const segments: Segment[] = [];
      if (prefix > 0) segments.push({ kind: "copy", start: 0, end: prefix });
      segments.push({ kind: "bytes", data: Buffer.from("fLaC", "latin1") });
      let size = prefix + 4;
      out.forEach((o, i) => {
        const length = bodyLength(o);
        segments.push({ kind: "bytes", data: blockHeader(o.type, length, i === out.length - 1) });
        segments.push(Buffer.isBuffer(o.body) ? { kind: "bytes", data: o.body } : { kind: "copy", ...o.body });
        size += 4 + length;
      });
      segments.push({ kind: "copy", start: audioStart, end: src.size });
      size += src.size - audioStart;
      return { segments, size };
    },
  };
}
