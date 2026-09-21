// Pure-JS archive reader/writer for the packaging pipeline.
//
// Why not the system `tar`: Git Bash on Windows ships GNU tar, which
// silently writes a plain tar file when asked for a ".zip" target (only
// bsdtar understands `-a` into zip), and unix permission bits inside
// archives created on Windows depend on host mount heuristics. The writers
// here emit explicit unix modes; the readers parse both formats without
// external tools, which also lets tests assert archive contents as plain JS.
import { deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from "node:zlib";

export interface ArchiveEntry {
  name: string;
  data: Buffer;
  /** Unix mode bits, e.g. 0o755. */
  mode: number;
}

export interface ArchiveEntryInfo {
  name: string;
  size: number;
  mode: number;
}

// ---------------------------------------------------------------------------
// CRC32 (zip requires it; not exposed by node:zlib in the current runtime)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Build a zip archive (deflate when smaller, else store) with unix modes. */
export function writeZip(entries: ArchiveEntry[]): Buffer {
  const { time, date } = dosDateTime(new Date());
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data, mode } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const deflated = deflateRawSync(data);
    const method = deflated.length < data.length ? 8 : 0;
    const payload = method === 8 ? deflated : data;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 6); // flags
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    local.push(lh, nameBuf, payload);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // central directory header signature
    ch.writeUInt16LE((3 << 8) | 20, 4); // made by: unix, zip 2.0
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0, 8); // flags
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(payload.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE((mode & 0xffff) << 16, 38); // external attrs: unix mode
    ch.writeUInt32LE(offset, 42); // local header offset
    central.push(ch, nameBuf);

    offset += 30 + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuf, eocd]);
}

function findEOCD(zip: Buffer): number {
  const maxScan = Math.min(zip.length - 22, 0xffff + 22);
  for (let i = zip.length - 22; i >= zip.length - 22 - maxScan; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("zip: end of central directory not found");
}

function readCentralEntries(zip: Buffer): { name: string; size: number; csize: number; mode: number; method: number; localOff: number }[] {
  const eocd = findEOCD(zip);
  const count = zip.readUInt16LE(eocd + 10);
  const cdSize = zip.readUInt32LE(eocd + 12);
  let off = zip.readUInt32LE(eocd + 16);
  if (off === 0xffffffff || count === 0xffff) throw new Error("zip: zip64 archives are not supported");
  const end = off + cdSize;
  const out = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(off) !== 0x02014b50) throw new Error(`zip: bad central directory entry at ${off}`);
    const nameLen = zip.readUInt16LE(off + 28);
    const extraLen = zip.readUInt16LE(off + 30);
    const commentLen = zip.readUInt16LE(off + 32);
    out.push({
      name: zip.toString("utf8", off + 46, off + 46 + nameLen),
      method: zip.readUInt16LE(off + 10),
      csize: zip.readUInt32LE(off + 20),
      size: zip.readUInt32LE(off + 24),
      mode: zip.readUInt32LE(off + 38) >>> 16,
      localOff: zip.readUInt32LE(off + 42),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (off !== end) throw new Error("zip: central directory length mismatch");
  return out;
}

/** List the members of a zip archive (from the central directory). */
export function readZipEntries(zip: Buffer): ArchiveEntryInfo[] {
  return readCentralEntries(zip).map(({ name, size, mode }) => ({ name, size, mode }));
}

/** Extract one member's decompressed content from a zip archive. */
export function extractZipEntry(zip: Buffer, name: string): Buffer {
  const entry = readCentralEntries(zip).find((e) => e.name === name);
  if (!entry) throw new Error(`zip: member not found: ${name}`);
  const lh = entry.localOff;
  if (zip.readUInt32LE(lh) !== 0x04034b50) throw new Error(`zip: bad local header for ${name}`);
  const nameLen = zip.readUInt16LE(lh + 26);
  const extraLen = zip.readUInt16LE(lh + 28);
  const start = lh + 30 + nameLen + extraLen;
  const raw = zip.subarray(start, start + entry.csize);
  return entry.method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
}

// ---------------------------------------------------------------------------
// tar + gzip
// ---------------------------------------------------------------------------

function tarString(block: Buffer, offset: number, length: number): string {
  let end = offset;
  const limit = offset + length;
  while (end < limit && block[end] !== 0) end++;
  return block.toString("utf8", offset, end);
}

function parsePaxPath(data: Buffer): string | null {
  const m = data.toString("utf8").match(/\d+ path=([^\n]*)\n/);
  return m ? m[1] : null;
}

interface RawTarEntry {
  name: string;
  size: number;
  mode: number;
  type: string;
}

function readTarBlocks(tar: Buffer): RawTarEntry[] {
  const out: RawTarEntry[] = [];
  let off = 0;
  let paxPath: string | null = null;
  while (off + 512 <= tar.length) {
    const block = tar.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break;
    let name = tarString(block, 0, 100);
    const prefix = tarString(block, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(tarString(block, 124, 12).replace(/[^0-7]/g, ""), 8) || 0;
    const mode = parseInt(tarString(block, 100, 8).replace(/[^0-7]/g, ""), 8) || 0;
    const type = String.fromCharCode(block[156] === 0 ? 0x30 : block[156]);
    off += 512;
    if (type === "x" || type === "g") {
      // pax extended header: applies the "path" override to the next entry
      const data = tar.subarray(off, off + size);
      if (type === "x") paxPath = parsePaxPath(data) ?? paxPath;
    } else if (type === "0" || type === "\0") {
      out.push({ name: paxPath ?? name, size, mode, type });
      paxPath = null;
    }
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

/** List the members of a .tar.gz archive. */
export function readTarGzEntries(gz: Buffer): ArchiveEntryInfo[] {
  return readTarBlocks(gunzipSync(gz)).map(({ name, size, mode }) => ({ name, size, mode }));
}

function tarBlock(name: string, data: Buffer, mode: number): Buffer[] {
  if (Buffer.byteLength(name, "utf8") > 100) throw new Error(`tar: name too long: ${name}`);
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write(mode.toString(8).padStart(7, "0"), 100);
  header.write("0000000", 108); // uid
  header.write("0000000", 116); // gid
  header.write(data.length.toString(8).padStart(11, "0"), 124);
  header.write("00000000000", 136); // mtime 0 (deterministic)
  header.write("        ", 148); // checksum placeholder
  header.writeUInt8(0x30, 156); // typeflag '0' (regular file)
  header.write("ustar", 257);
  header.write("00", 263);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return [header, data, pad];
}

/** Build a deterministic .tar.gz with explicit unix modes (mtime 0). */
export function writeTarGz(entries: ArchiveEntry[]): Buffer {
  const parts = entries.flatMap((e) => tarBlock(e.name, e.data, e.mode));
  parts.push(Buffer.alloc(1024)); // end-of-archive marker
  return gzipSync(Buffer.concat(parts));
}
