/**
 * MP4 audio (.m4a): the iTunes-style item list `moov/udta/meta/ilst`.
 *
 * Only the item atoms of the fields being changed are replaced; every other
 * item (artwork `covr`, freeform `----` items, sort names) and every other
 * atom is copied byte for byte. The media data (`mdat`) is never touched.
 * When the item list changes size, a `free` atom next to it (inside `meta`,
 * or right after `moov`) absorbs the difference where it can. Otherwise, if
 * media data follows `moov`, the chunk offsets (`stco`/`co64`) of every
 * track are shifted by the difference, so they still point at the same
 * audio.
 *
 * Refused (TagLayoutError): fragmented files (`moof`), more than one `moov`,
 * and files that would need their offsets shifted but carry other absolute
 * offsets (`saio`).
 */

import {
  TagLayoutError,
  emptyRaw,
  parseYear,
  type ByteSource,
  type FieldChanges,
  type ParsedTags,
  type RewritePlan,
  type Segment,
  type TagField,
  type TagValues,
} from "./types";

/** Largest `moov` read into memory (artwork included). */
const MAX_MOOV = 128 * 1024 * 1024;

interface Atom {
  type: string;
  /** 8, or 16 for a 64-bit size. */
  headerSize: number;
  /** Raw bytes (header included) of a leaf, or of a container as read. */
  raw: Buffer;
  /** Bytes between the header and the children (the version and flags of `meta`). */
  prefix?: Buffer;
  children?: Atom[];
  /** Bytes after the last child that are not an atom (QuickTime `udta` ends with four zero bytes). */
  trailing?: Buffer;
}

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "udta", "meta", "ilst"]);

function parseAtoms(buf: Buffer, start: number, end: number, depth: number): { atoms: Atom[]; trailing: Buffer } {
  const atoms: Atom[] = [];
  let pos = start;
  while (pos < end) {
    if (end - pos < 8) break;
    let size = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    let headerSize = 8;
    if (size === 1) {
      if (end - pos < 16) break;
      const big = buf.readBigUInt64BE(pos + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new TagLayoutError("MP4 atom too large");
      size = Number(big);
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < headerSize || pos + size > end) {
      // Not an atom: keep as trailing bytes only when it is a short zero run.
      break;
    }
    const raw = buf.subarray(pos, pos + size);
    const atom: Atom = { type, headerSize, raw };
    if (CONTAINERS.has(type) && depth < 8) {
      let childStart = pos + headerSize;
      if (type === "meta") {
        // ISO/iTunes `meta` is a full box (4 bytes of version and flags);
        // QuickTime's is not. Its first child is `hdlr` either way.
        if (buf.toString("latin1", childStart + 8, childStart + 12) === "hdlr") {
          atom.prefix = buf.subarray(childStart, childStart + 4);
          childStart += 4;
        } else if (buf.toString("latin1", childStart + 4, childStart + 8) !== "hdlr") {
          throw new TagLayoutError("Unexpected MP4 meta atom");
        }
      }
      const inner = parseAtoms(buf, childStart, pos + size, depth + 1);
      atom.children = inner.atoms;
      atom.trailing = inner.trailing;
    }
    atoms.push(atom);
    pos += size;
  }
  const trailing = buf.subarray(pos, end);
  if (trailing.some((b) => b !== 0)) throw new TagLayoutError("Malformed MP4 atoms");
  return { atoms, trailing };
}

function header(type: string, size: number, headerSize: number): Buffer {
  if (headerSize === 16) {
    const h = Buffer.alloc(16);
    h.writeUInt32BE(1, 0);
    h.write(type, 4, "latin1");
    h.writeBigUInt64BE(BigInt(size), 8);
    return h;
  }
  if (size > 0xffffffff) throw new TagLayoutError("MP4 atom too large");
  const h = Buffer.alloc(8);
  h.writeUInt32BE(size, 0);
  h.write(type, 4, "latin1");
  return h;
}

function serialize(atom: Atom): Buffer {
  if (!atom.children) return atom.raw;
  const body = Buffer.concat([atom.prefix ?? Buffer.alloc(0), ...atom.children.map(serialize), atom.trailing ?? Buffer.alloc(0)]);
  return Buffer.concat([header(atom.type, atom.headerSize + body.length, atom.headerSize), body]);
}

function leaf(type: string, body: Buffer): Atom {
  const raw = Buffer.concat([header(type, 8 + body.length, 8), body]);
  return { type, headerSize: 8, raw };
}

function container(type: string, children: Atom[], prefix?: Buffer): Atom {
  const atom: Atom = { type, headerSize: 8, raw: Buffer.alloc(0), children, trailing: Buffer.alloc(0) };
  if (prefix) atom.prefix = prefix;
  return atom;
}

function child(atom: Atom | undefined, type: string): Atom | undefined {
  return atom?.children?.find((c) => c.type === type);
}

/** Item types per field; the first is written. */
const ITEMS: Record<TagField, string[]> = {
  title: ["©nam"],
  artist: ["©ART"],
  album: ["©alb"],
  albumArtist: ["aART"],
  track: ["trkn"],
  disc: ["disk"],
  year: ["©day"],
  genre: ["©gen", "gnre"],
};
const FIELDS = Object.keys(ITEMS) as TagField[];

function fieldOf(type: string): TagField | undefined {
  return FIELDS.find((f) => ITEMS[f].includes(type));
}

/** The first `data` atom of an item: its type indicator and value bytes. */
function itemData(item: Atom): { typeCode: number; value: Buffer } | undefined {
  const body = item.raw.subarray(item.headerSize);
  const { atoms } = (() => {
    try {
      return parseAtoms(body, 0, body.length, 8);
    } catch {
      return { atoms: [] as Atom[] };
    }
  })();
  const data = atoms.find((a) => a.type === "data");
  if (!data || data.raw.length < data.headerSize + 8) return undefined;
  const typeCode = data.raw.readUInt32BE(data.headerSize) & 0xffffff;
  return { typeCode, value: data.raw.subarray(data.headerSize + 8) };
}

function itemText(item: Atom | undefined): string | undefined {
  if (!item) return undefined;
  const d = itemData(item);
  if (!d) return undefined;
  if (d.typeCode === 1) return d.value.toString("utf8");
  if (d.typeCode === 2) {
    const b = Buffer.from(d.value.subarray(0, d.value.length - (d.value.length % 2)));
    b.swap16();
    return b.toString("utf16le");
  }
  return undefined;
}

function itemPair(item: Atom | undefined): { no: number; of?: number } | undefined {
  if (!item) return undefined;
  const d = itemData(item);
  if (!d || (d.typeCode !== 0 && d.typeCode !== 21) || d.value.length < 6) return undefined;
  const no = d.value.readUInt16BE(2);
  const of = d.value.readUInt16BE(4);
  if (no === 0) return undefined;
  return of > 0 ? { no, of } : { no };
}

function dataAtom(typeCode: number, value: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(typeCode, 0);
  return leaf("data", Buffer.concat([head, value])).raw;
}

function itemsFor(field: TagField, values: TagValues): Buffer[] {
  const type = ITEMS[field][0]!;
  switch (field) {
    case "track":
    case "disc": {
      const pair = values[field];
      if (!pair) return [];
      if (pair.no > 0xffff || (pair.of ?? 0) > 0xffff) throw new TagLayoutError("Track or disc number too large for MP4");
      const v = Buffer.alloc(field === "track" ? 8 : 6);
      v.writeUInt16BE(pair.no, 2);
      v.writeUInt16BE(pair.of ?? 0, 4);
      return [leaf(type, dataAtom(0, v)).raw];
    }
    case "year":
      return values.year !== undefined ? [leaf(type, dataAtom(1, Buffer.from(String(values.year), "utf8"))).raw] : [];
    default: {
      const text = values[field];
      return text ? [leaf(type, dataAtom(1, Buffer.from(text, "utf8"))).raw] : [];
    }
  }
}

/** The atom for raw item bytes saved earlier. */
function atomFromRaw(raw: Buffer): Atom {
  const parsed = parseAtoms(raw, 0, raw.length, 8);
  if (parsed.atoms.length !== 1) throw new TagLayoutError("Malformed saved MP4 item");
  const atom = parsed.atoms[0]!;
  // Items are leaves here; keep their bytes exactly.
  return { type: atom.type, headerSize: atom.headerSize, raw: atom.raw };
}

/** An iTunes metadata handler (`hdlr` with `mdir`/`appl`). */
function itunesHandler(): Atom {
  const body = Buffer.alloc(25);
  body.write("mdir", 8, "latin1");
  body.write("appl", 12, "latin1");
  return leaf("hdlr", body);
}

interface TopAtom {
  type: string;
  start: number;
  size: number;
}

/** Shift chunk offsets at or after `from` by `delta`, in every track of `moov`. */
function shiftChunkOffsets(moov: Atom, from: number, delta: number): void {
  for (const trak of moov.children ?? []) {
    if (trak.type !== "trak") continue;
    const stbl = child(child(child(trak, "mdia"), "minf"), "stbl");
    if (!stbl?.children) throw new TagLayoutError("MP4 track without a sample table");
    if (stbl.children.some((a) => a.type === "saio")) throw new TagLayoutError("MP4 files with auxiliary offsets are not supported");
    for (const table of stbl.children) {
      if (table.type !== "stco" && table.type !== "co64") continue;
      const raw = Buffer.from(table.raw);
      const h = table.headerSize;
      const count = raw.readUInt32BE(h + 4);
      const width = table.type === "stco" ? 4 : 8;
      if (h + 8 + count * width > raw.length) throw new TagLayoutError("Malformed MP4 chunk offsets");
      for (let i = 0; i < count; i += 1) {
        const at = h + 8 + i * width;
        if (width === 4) {
          const v = raw.readUInt32BE(at);
          if (v < from) continue;
          const next = v + delta;
          if (next < 0 || next > 0xffffffff) throw new TagLayoutError("MP4 chunk offset out of range");
          raw.writeUInt32BE(next, at);
        } else {
          const v = raw.readBigUInt64BE(at);
          if (v < BigInt(from)) continue;
          raw.writeBigUInt64BE(v + BigInt(delta), at);
        }
      }
      table.raw = raw;
    }
  }
}

export async function parseMp4(src: ByteSource): Promise<ParsedTags> {
  const top: TopAtom[] = [];
  let pos = 0;
  while (pos < src.size) {
    const h = await src.read(pos, Math.min(16, src.size - pos));
    if (h.length < 8) {
      if (h.some((b) => b !== 0)) throw new TagLayoutError("Malformed MP4 file");
      break;
    }
    let size = h.readUInt32BE(0);
    const type = h.toString("latin1", 4, 8);
    if (size === 1) {
      if (h.length < 16) throw new TagLayoutError("Malformed MP4 file");
      size = Number(h.readBigUInt64BE(8));
    } else if (size === 0) {
      size = src.size - pos;
    }
    if (size < 8 || pos + size > src.size) throw new TagLayoutError("Malformed MP4 file");
    top.push({ type, start: pos, size });
    pos += size;
  }
  if (top[0]?.type !== "ftyp") throw new TagLayoutError("Not an MP4 file");
  if (top.some((a) => a.type === "moof" || a.type === "mfra")) throw new TagLayoutError("Fragmented MP4 files are not supported");
  const moovs = top.filter((a) => a.type === "moov");
  if (moovs.length !== 1) throw new TagLayoutError("Expected exactly one moov atom");
  const moovInfo = moovs[0]!;
  if (moovInfo.size > MAX_MOOV) throw new TagLayoutError("The MP4 metadata is too large");
  const moovIndex = top.indexOf(moovInfo);
  const moovEnd = moovInfo.start + moovInfo.size;
  const moovBuf = await src.read(moovInfo.start, moovInfo.size);
  const parsed = parseAtoms(moovBuf, 0, moovBuf.length, 0);
  if (parsed.atoms.length !== 1 || parsed.atoms[0]!.type !== "moov") throw new TagLayoutError("Malformed moov atom");
  const moovTemplate = parsed.atoms[0]!;

  const ilst = child(child(child(moovTemplate, "udta"), "meta"), "ilst");
  const items = ilst?.children ?? [];
  const raw = emptyRaw();
  for (const item of items) {
    const field = fieldOf(item.type);
    if (field) raw[field].push(Buffer.from(item.raw));
  }
  const values: TagValues = {};
  const firstItem = (field: TagField) => items.find((i) => ITEMS[field].includes(i.type));
  for (const field of ["title", "artist", "album", "albumArtist"] as const) {
    const t = itemText(firstItem(field));
    if (t !== undefined && t.trim() !== "") values[field] = t;
  }
  const genreItem = firstItem("genre");
  const genre = genreItem?.type === "©gen" ? itemText(genreItem) : undefined;
  if (genre !== undefined && genre.trim() !== "") values.genre = genre;
  const track = itemPair(firstItem("track"));
  if (track) values.track = track;
  const disc = itemPair(firstItem("disc"));
  if (disc) values.disc = disc;
  const year = parseYear(itemText(firstItem("year")));
  if (year !== undefined) values.year = year;

  const afterMoov = top[moovIndex + 1];
  const afterFree =
    afterMoov && (afterMoov.type === "free" || afterMoov.type === "skip") && afterMoov.size <= 0xffffffff ? afterMoov : undefined;

  return {
    format: "mp4",
    values,
    raw,
    regionSize: moovInfo.size + (afterFree?.size ?? 0),
    plan(changes: FieldChanges, options = {}): RewritePlan {
      // Work on a fresh copy of the tree.
      const moov = parseAtoms(moovBuf, 0, moovBuf.length, 0).atoms[0]!;
      let udta = child(moov, "udta");
      if (!udta) {
        udta = container("udta", []);
        moov.children!.push(udta);
      }
      let meta = child(udta, "meta");
      if (!meta) {
        meta = container("meta", [itunesHandler()], Buffer.alloc(4));
        udta.children!.push(meta);
      }
      let list = child(meta, "ilst");
      if (!list) {
        list = container("ilst", []);
        meta.children!.push(list);
      }

      const replacement = (field: TagField): Atom[] => {
        const change = changes[field]!;
        const buffers = change.kind === "raw" ? change.entries : itemsFor(field, change.values);
        return buffers.map(atomFromRaw);
      };
      const done = new Set<TagField>();
      const out: Atom[] = [];
      for (const item of list.children ?? []) {
        const field = fieldOf(item.type);
        if (!field || !changes[field]) {
          out.push(item);
          continue;
        }
        if (!done.has(field)) {
          out.push(...replacement(field));
          done.add(field);
        }
      }
      for (const field of FIELDS) if (changes[field] && !done.has(field)) out.push(...replacement(field));
      list.children = out;

      let delta = serialize(moov).length - moovInfo.size;
      let afterSegment: Segment[] = [{ kind: "copy", start: moovEnd, end: src.size }];

      if (delta !== 0) {
        // A free atom inside meta, then one right after moov, absorbs the change.
        const metaFree = meta.children!.find((a) => a.type === "free");
        if (metaFree) {
          const next = metaFree.raw.length - delta;
          if (next >= 8 || next === 0) {
            if (next === 0) meta.children = meta.children!.filter((a) => a !== metaFree);
            else Object.assign(metaFree, leaf("free", Buffer.alloc(next - 8)));
            delta = 0;
          }
        }
      }
      // Then a free atom right after moov: its new size (undefined: as it is).
      const restoring = options.targetRegionSize !== undefined;
      const moovSize = moovInfo.size + delta;
      const restStart = afterFree ? afterFree.start + afterFree.size : moovEnd;
      let newFree: number | undefined;
      if (restoring) {
        // Putting old tags back: give moov and the free atom after it their
        // old combined size, so the audio returns to where it was.
        const want = options.targetRegionSize! - moovSize;
        if (want === 0 || want >= 8) newFree = want;
      } else if (delta !== 0 && afterFree) {
        const next = afterFree.size - delta;
        if (next === 0 || next >= 8) newFree = next;
      } else if (delta < -7 && !afterFree && restStart < src.size) {
        // Smaller, with data after it: fill the gap rather than move the audio.
        newFree = -delta;
      }
      let shift = delta;
      if (newFree !== undefined) {
        afterSegment = [
          ...(newFree > 0 ? [{ kind: "bytes" as const, data: leaf(afterFree?.type ?? "free", Buffer.alloc(newFree - 8)).raw }] : []),
          { kind: "copy", start: restStart, end: src.size },
        ];
        shift = moovSize + newFree - (moovInfo.size + (afterFree?.size ?? 0));
      }
      if (shift !== 0 && restStart < src.size) shiftChunkOffsets(moov, moovEnd, shift);

      const newMoov = serialize(moov);
      const segments: Segment[] = [
        { kind: "copy", start: 0, end: moovInfo.start },
        { kind: "bytes", data: newMoov },
        ...afterSegment,
      ];
      const size = segments.reduce(
        (n, s) => n + (s.kind === "bytes" ? s.data.length : s.end - s.start),
        0,
      );
      return { segments, size };
    },
  };
}
