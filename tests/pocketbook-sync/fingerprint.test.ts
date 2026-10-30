import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { Fingerprint, koreaderHash } from "../../src/pocketbook-sync/fingerprint.ts";

/** Straight port of KOReader's util.partialMD5 (seek + read on the whole file). */
function referencePartialMd5(data: Uint8Array): string {
    const hash = createHash("md5");
    for (let i = -1; i <= 10; i++) {
        const offset = i === -1 ? 0 : 1024 * 4 ** i;
        const sample = data.subarray(offset, offset + 1024);
        if (sample.length === 0) break;
        hash.update(sample);
    }
    return hash.digest("hex");
}

test.each([0, 1, 1023, 1024, 1025, 4096, 4097, 5000, 70_000, 300_000, 1_100_000, 4_300_000])(
    "matches KOReader for a %d byte file",
    (size) => {
        const data = randomBytes(size);
        expect(koreaderHash(data)).toBe(referencePartialMd5(data));
    },
);

test.each([1, 7, 1000, 1024, 4096, 65536])("chunks of %d bytes give the same result", (chunkSize) => {
    const data = randomBytes(300_000);
    const fingerprint = new Fingerprint();
    for (let i = 0; i < data.length; i += chunkSize) fingerprint.update(data.subarray(i, i + chunkSize));
    expect(fingerprint.koreaderHash).toBe(referencePartialMd5(data));
    expect(fingerprint.size).toBe(data.length);
});

test("known value: samples at 0, 1 KiB and 4 KiB of a 16 KiB file", () => {
    const data = new Uint8Array(16 * 1024).map((_, i) => i % 256);
    const expected = createHash("md5").update(data.subarray(0, 1024)).update(data.subarray(1024, 2048))
        .update(data.subarray(4096, 5120)).digest("hex");
    expect(koreaderHash(data)).toBe(expected);
});

test("full MD5 in PocketBook's base64 form, readable more than once", () => {
    const data = new TextEncoder().encode("hello world".repeat(1000));
    const fingerprint = new Fingerprint();
    fingerprint.update(data);
    const expected = createHash("md5").update(data).digest("base64");
    expect(fingerprint.md5Base64).toBe(expected);
    expect(fingerprint.md5Base64).toBe(expected);
});

test("buffers reused by the stream don't change the samples", () => {
    const data = randomBytes(10_000);
    const buffer = new Uint8Array(1000);
    const fingerprint = new Fingerprint();
    for (let i = 0; i < data.length; i += 1000) {
        buffer.set(data.subarray(i, i + 1000));
        fingerprint.update(buffer);
    }
    buffer.fill(0);
    expect(fingerprint.koreaderHash).toBe(referencePartialMd5(data));
});
