import { deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * Just enough ZIP to change one file inside an EPUB: entries are read from the central directory, and a rewrite
 * copies every other entry byte for byte (local header, data, data descriptor), so nothing but that file changes.
 */

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const STORED = 0;
const DEFLATED = 8;
/** General purpose flag: sizes and CRC follow the data in a descriptor */
const DATA_DESCRIPTOR = 0x08;

export class ZipError extends Error {}

export interface ZipEntry {
    name: string;
    method: number;
    flags: number;
    compressedSize: number;
    localOffset: number;
    /** The entry's central directory record, as found */
    central: Buffer;
}

interface Directory {
    entries: ZipEntry[];
    offset: number;
    /** The end of central directory record, with its comment */
    end: Buffer;
}

function readDirectory(zip: Buffer): Directory {
    // The end record is the last thing in the file, followed only by a comment of up to 64 KiB
    let endAt = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
        if (zip.readUInt32LE(i) === END) {
            endAt = i;
            break;
        }
    }
    if (endAt < 0) throw new ZipError("not a ZIP file");
    const count = zip.readUInt16LE(endAt + 10);
    const offset = zip.readUInt32LE(endAt + 16);
    if (count === 0xffff || offset === 0xffffffff) throw new ZipError("ZIP64 is not supported");

    const entries: ZipEntry[] = [];
    let at = offset;
    for (let i = 0; i < count; i++) {
        if (at + 46 > zip.length || zip.readUInt32LE(at) !== CENTRAL) throw new ZipError("damaged central directory");
        const nameLength = zip.readUInt16LE(at + 28);
        const length = 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
        entries.push({
            name: zip.subarray(at + 46, at + 46 + nameLength).toString("utf8"),
            flags: zip.readUInt16LE(at + 8),
            method: zip.readUInt16LE(at + 10),
            compressedSize: zip.readUInt32LE(at + 20),
            localOffset: zip.readUInt32LE(at + 42),
            central: zip.subarray(at, at + length),
        });
        at += length;
    }
    return { entries, offset, end: zip.subarray(endAt) };
}

function dataStart(zip: Buffer, entry: ZipEntry): number {
    const at = entry.localOffset;
    if (zip.readUInt32LE(at) !== LOCAL) throw new ZipError(`damaged local header for ${entry.name}`);
    return at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
}

export function listEntries(bytes: Uint8Array): ZipEntry[] {
    return readDirectory(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).entries;
}

/** The uncompressed contents of one entry, or null if there is none by that name. */
export function readEntry(bytes: Uint8Array, name: string): Buffer | null {
    const zip = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entry = readDirectory(zip).entries.find((e) => e.name === name);
    if (!entry) return null;
    const start = dataStart(zip, entry);
    const data = zip.subarray(start, start + entry.compressedSize);
    if (entry.method === STORED) return Buffer.from(data);
    if (entry.method === DEFLATED) return inflateRawSync(data);
    throw new ZipError(`${name} uses unsupported compression method ${entry.method}`);
}

/** A copy of the ZIP with one entry's contents replaced, compressed as before; every other byte stays. */
export function replaceEntry(bytes: Uint8Array, name: string, contents: Uint8Array): Uint8Array {
    return replaceEntries(bytes, new Map([[name, contents]]));
}

/** A copy of the ZIP with the contents of some entries replaced, each compressed as before; every other byte stays. */
export function replaceEntries(bytes: Uint8Array, replacements: Map<string, Uint8Array>): Uint8Array {
    const zip = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const directory = readDirectory(zip);
    const targets = new Map<ZipEntry, Uint8Array>();
    for (const [name, contents] of replacements) {
        const entry = directory.entries.find((e) => e.name === name);
        if (!entry) throw new ZipError(`${name} is not in the ZIP`);
        targets.set(entry, contents);
    }

    // Local records in file order; each one runs to the next (data descriptors included) or to the central directory
    const byOffset = [...directory.entries].sort((a, b) => a.localOffset - b.localOffset);
    const parts: Buffer[] = [zip.subarray(0, byOffset[0]?.localOffset ?? directory.offset)];
    const newOffsets = new Map<ZipEntry, number>();
    const newHeaders = new Map<ZipEntry, Buffer>();
    let written = parts[0]!.length;

    for (const [i, entry] of byOffset.entries()) {
        newOffsets.set(entry, written);
        const end = byOffset[i + 1]?.localOffset ?? directory.offset;
        const contents = targets.get(entry);
        let record: Buffer;
        if (!contents) {
            record = zip.subarray(entry.localOffset, end);
        } else {
            const method = entry.method === STORED ? STORED : DEFLATED;
            const data = method === STORED ? Buffer.from(contents) : deflateRawSync(contents);
            const nameBytes = zip.subarray(entry.localOffset + 30, entry.localOffset + 30 + zip.readUInt16LE(entry.localOffset + 26));
            const header = Buffer.alloc(30);
            zip.copy(header, 0, entry.localOffset, entry.localOffset + 30);
            // Sizes now stand in the header, so no data descriptor follows; the extra field is dropped
            header.writeUInt16LE(entry.flags & ~DATA_DESCRIPTOR, 6);
            header.writeUInt16LE(method, 8);
            header.writeUInt32LE(Bun.hash.crc32(contents), 14);
            header.writeUInt32LE(data.length, 18);
            header.writeUInt32LE(contents.length, 22);
            header.writeUInt16LE(0, 28);
            newHeaders.set(entry, header);
            record = Buffer.concat([header, nameBytes, data]);
        }
        parts.push(record);
        written += record.length;
    }

    const centralOffset = written;
    for (const entry of directory.entries) {
        const central = Buffer.from(entry.central);
        const header = newHeaders.get(entry);
        if (header) {
            central.writeUInt16LE(header.readUInt16LE(6), 8);
            central.writeUInt16LE(header.readUInt16LE(8), 10);
            central.writeUInt32LE(header.readUInt32LE(14), 16);
            central.writeUInt32LE(header.readUInt32LE(18), 20);
            central.writeUInt32LE(header.readUInt32LE(22), 24);
        }
        central.writeUInt32LE(newOffsets.get(entry)!, 42);
        parts.push(central);
        written += central.length;
    }

    const end = Buffer.from(directory.end);
    end.writeUInt32LE(written - centralOffset, 12);
    end.writeUInt32LE(centralOffset, 16);
    parts.push(end);
    return new Uint8Array(Buffer.concat(parts));
}
