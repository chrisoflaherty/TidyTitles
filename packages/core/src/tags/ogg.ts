/**
 * Ogg Vorbis and Ogg Opus: the comment header packet.
 *
 * An Ogg stream starts with a page holding the identification header,
 * followed by the header pages: the comment packet (and, for Vorbis, the
 * setup packet), which end their last page. Only those header pages are
 * rebuilt. The identification page and every audio packet are copied
 * verbatim. When the header packets still fit into the same number of
 * pages, which is the usual case, the audio pages are copied byte for byte;
 * otherwise each later page of the stream gets its sequence number shifted
 * and its checksum recomputed, with its packets unchanged.
 *
 * Refused (TagLayoutError): other codecs in Ogg (FLAC, Speex, Theora), a
 * stream multiplexed with another one in its header pages, and header pages
 * that do not end where the header packets end.
 */

import {
  TagLayoutError,
  type ByteSource,
  type FieldChanges,
  type ParsedTags,
  type RewritePlan,
} from "./types";
import {
  applyVorbisChanges,
  parseVorbisComments,
  serializeVorbisComments,
  vorbisRaw,
  vorbisValues,
} from "./vorbisComment";

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let j = 0; j < 8; j += 1) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

/** The Ogg page checksum (CRC-32, polynomial 0x04c11db7, not reflected). */
export function oggCrc(data: Buffer): number {
  let crc = 0;
  for (let i = 0; i < data.length; i += 1) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ data[i]!) & 0xff]!) >>> 0;
  }
  return crc >>> 0;
}

/** Set a page's checksum (the page's bytes, with the checksum field zero while computing). */
export function sealPage(page: Buffer): Buffer {
  page.writeUInt32LE(0, 22);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

export interface OggPage {
  start: number;
  /** Total length: header, segment table, and data. */
  length: number;
  headerType: number;
  serial: number;
  seq: number;
  lacing: number[];
  data: Buffer;
}

/** Parse the page at `buf[offset]`; undefined when the buffer holds less than a page. */
export function parsePage(buf: Buffer, offset: number, filePosition: number): OggPage | undefined {
  if (offset + 27 > buf.length) return undefined;
  if (buf.toString("latin1", offset, offset + 4) !== "OggS") throw new TagLayoutError("Lost sync in the Ogg stream");
  if (buf[offset + 4] !== 0) throw new TagLayoutError("Unknown Ogg page version");
  const segments = buf[offset + 26]!;
  if (offset + 27 + segments > buf.length) return undefined;
  const lacing = [...buf.subarray(offset + 27, offset + 27 + segments)];
  const dataLength = lacing.reduce((n, v) => n + v, 0);
  const length = 27 + segments + dataLength;
  if (offset + length > buf.length) return undefined;
  return {
    start: filePosition,
    length,
    headerType: buf[offset + 5]!,
    serial: buf.readUInt32LE(offset + 14),
    seq: buf.readUInt32LE(offset + 18),
    lacing,
    data: buf.subarray(offset + 27 + segments, offset + length),
  };
}

async function readPage(src: ByteSource, position: number): Promise<OggPage> {
  const head = await src.read(position, 27);
  if (head.length < 27) throw new TagLayoutError("Truncated Ogg stream");
  const segments = head[26]!;
  const table = await src.read(position + 27, segments);
  const dataLength = [...table].reduce((n, v) => n + v, 0);
  const whole = await src.read(position, 27 + segments + dataLength);
  const page = parsePage(whole, 0, position);
  if (!page) throw new TagLayoutError("Truncated Ogg stream");
  return page;
}

// ---------------------------------------------------------------------------
// Header packets
// ---------------------------------------------------------------------------

const VORBIS_COMMENT_MAGIC = Buffer.from("\x03vorbis", "latin1");
const OPUS_TAGS_MAGIC = Buffer.from("OpusTags", "latin1");
const NO_GRANULE = 0xffffffffffffffffn;

/** Build header pages for `packets`, using exactly `pageCount` pages when given and possible. */
function paginate(
  packets: Buffer[],
  serial: number,
  firstSeq: number,
  pageCount: number,
): Buffer[] | undefined {
  // Lacing values for all packets, each tagged with whether it ends a packet.
  const segs: { size: number; ends: boolean; packet: number; offset: number }[] = [];
  packets.forEach((p, packet) => {
    let offset = 0;
    for (;;) {
      const size = Math.min(255, p.length - offset);
      segs.push({ size, ends: size < 255, packet, offset });
      offset += size;
      if (size < 255) break;
    }
  });
  if (segs.length < pageCount || segs.length > pageCount * 255) return undefined;

  const pages: Buffer[] = [];
  let i = 0;
  for (let n = 0; n < pageCount; n += 1) {
    const take = Math.min(255, segs.length - i - (pageCount - n - 1));
    const mine = segs.slice(i, i + take);
    const continued = i > 0 && !segs[i - 1]!.ends;
    i += take;
    const data = Buffer.concat(mine.map((s) => packets[s.packet]!.subarray(s.offset, s.offset + s.size)));
    const page = Buffer.alloc(27 + mine.length + data.length);
    page.write("OggS", 0, "latin1");
    page[4] = 0;
    page[5] = continued ? 0x01 : 0;
    page.writeBigUInt64LE(mine.some((s) => s.ends) ? 0n : NO_GRANULE, 6);
    page.writeUInt32LE(serial, 14);
    page.writeUInt32LE((firstSeq + n) >>> 0, 18);
    page[26] = mine.length;
    mine.forEach((s, k) => (page[27 + k] = s.size));
    data.copy(page, 27 + mine.length);
    pages.push(sealPage(page));
  }
  return pages;
}

export async function parseOgg(src: ByteSource): Promise<ParsedTags> {
  const first = await readPage(src, 0);
  if (!(first.headerType & 0x02)) throw new TagLayoutError("The Ogg stream does not start with a first page");
  if (first.lacing.length === 0 || first.lacing[first.lacing.length - 1] === 255 || first.lacing.slice(0, -1).some((v) => v < 255)) {
    throw new TagLayoutError("Unexpected first Ogg page");
  }
  let codec: "vorbis" | "opus";
  if (first.data.toString("latin1", 0, 7) === "\x01vorbis") codec = "vorbis";
  else if (first.data.toString("latin1", 0, 8) === "OpusHead") codec = "opus";
  else throw new TagLayoutError("Only Vorbis and Opus are supported in Ogg");
  const headerPackets = codec === "vorbis" ? 2 : 1;
  const serial = first.serial;

  // Collect the header packets from the pages after the first.
  const packets: Buffer[] = [];
  let current: Buffer[] = [];
  const headerStart = first.length;
  let pos = headerStart;
  let pageCount = 0;
  let firstSeq = 0;
  while (packets.length < headerPackets) {
    if (pos >= src.size) throw new TagLayoutError("Truncated Ogg headers");
    const page = await readPage(src, pos);
    if (page.serial !== serial) throw new TagLayoutError("Multiplexed Ogg streams are not supported");
    if (pageCount === 0) firstSeq = page.seq;
    pageCount += 1;
    let offset = 0;
    for (const size of page.lacing) {
      if (packets.length >= headerPackets) {
        throw new TagLayoutError("Audio data shares a page with the Ogg headers");
      }
      current.push(page.data.subarray(offset, offset + size));
      offset += size;
      if (size < 255) {
        packets.push(Buffer.concat(current));
        current = [];
      }
    }
    pos += page.length;
  }
  if (current.length > 0) throw new TagLayoutError("Unexpected Ogg header layout");
  const headerEnd = pos;

  const magic = codec === "vorbis" ? VORBIS_COMMENT_MAGIC : OPUS_TAGS_MAGIC;
  const commentPacket = packets[0]!;
  if (!commentPacket.subarray(0, magic.length).equals(magic)) throw new TagLayoutError("Missing Ogg comment header");
  const vc = parseVorbisComments(commentPacket, magic.length);
  if (codec === "vorbis" && (vc.trailer.length < 1 || !(vc.trailer[0]! & 1))) {
    throw new TagLayoutError("Malformed Vorbis comment header");
  }

  return {
    format: codec === "vorbis" ? "ogg_vorbis" : "ogg_opus",
    values: vorbisValues(vc),
    raw: vorbisRaw(vc),
    regionSize: headerEnd - headerStart,
    plan(changes: FieldChanges): RewritePlan {
      const newComment = Buffer.concat([magic, serializeVorbisComments(applyVorbisChanges(vc, changes))]);
      const newPackets = [newComment, ...packets.slice(1)];
      const segments = newPackets.reduce((n, p) => n + Math.floor(p.length / 255) + 1, 0);
      let pages = paginate(newPackets, serial, firstSeq, pageCount);
      let seqDelta = 0;
      if (!pages) {
        const needed = Math.ceil(segments / 255);
        pages = paginate(newPackets, serial, firstSeq, needed);
        if (!pages) throw new TagLayoutError("Could not lay out the Ogg headers");
        seqDelta = needed - pageCount;
      }
      const header = Buffer.concat(pages);
      return {
        segments: [
          { kind: "copy", start: 0, end: headerStart },
          { kind: "bytes", data: header },
          seqDelta === 0
            ? { kind: "copy", start: headerEnd, end: src.size }
            : { kind: "ogg_pages", start: headerEnd, end: src.size, serial, seqDelta },
        ],
        size: headerStart + header.length + (src.size - headerEnd),
      };
    },
  };
}
