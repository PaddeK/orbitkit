import { createHash, type Hash } from "node:crypto";

const SAMPLE_SIZE = 1024;
// KOReader's util.partialMD5 reads 1 KiB at 1024 << 2i for i = -1..10. In LuaJIT 1024 << -2 wraps
// around to 0, so the samples start at 0, 1 KiB, 4 KiB, 16 KiB, ... up to 1 GiB.
export const SAMPLE_OFFSETS = [0, ...Array.from({ length: 11 }, (_, i) => 1024 * 4 ** i)];

/** Book fingerprints computed while a file is streamed: feed it front to back, then read the hashes. */
export class Fingerprint {
    private position = 0;
    private readonly samples = SAMPLE_OFFSETS.map(() => [] as Uint8Array[]);
    private readonly md5: Hash = createHash("md5");

    update(chunk: Uint8Array): void {
        const start = this.position;
        const end = start + chunk.length;
        SAMPLE_OFFSETS.forEach((offset, i) => {
            const lo = Math.max(start, offset);
            const hi = Math.min(end, offset + SAMPLE_SIZE);
            // slice copies: the stream may reuse its buffers
            if (lo < hi) this.samples[i]!.push(chunk.slice(lo - start, hi - start));
        });
        this.md5.update(chunk);
        this.position = end;
    }

    get size(): number {
        return this.position;
    }

    /** KOReader's partial MD5: the document ID used by KOReader sync and BookOrbit. */
    get koreaderHash(): string {
        const hash = createHash("md5");
        for (const parts of this.samples) {
            if (parts.length === 0) break; // first offset past the end of the file
            for (const part of parts) hash.update(part);
        }
        return hash.digest("hex");
    }

    /** Full-file MD5 in the base64 form PocketBook Cloud reports as md5_hash. Read it after the last update(). */
    get md5Base64(): string {
        return this.md5.copy().digest("base64");
    }
}

export function koreaderHash(data: Uint8Array): string {
    const fingerprint = new Fingerprint();
    fingerprint.update(data);
    return fingerprint.koreaderHash;
}
