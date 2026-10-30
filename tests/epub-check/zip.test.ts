import { expect, test } from "bun:test";
import { listEntries, readEntry, replaceEntry, ZipError } from "../../src/epub-check/zip.ts";
import { epub2, validEpub, zip } from "./epub.ts";
import { validateEpub } from "../../src/epub-check/validator.ts";

const entries = (bytes: Uint8Array) => listEntries(bytes).map((e) => e.name);

/** Every entry's raw local record (header, data, descriptor) except one, to compare byte for byte */
function rawRecords(bytes: Uint8Array, except: string): Record<string, string> {
    const sorted = listEntries(bytes).sort((a, b) => a.localOffset - b.localOffset);
    const end = Buffer.from(bytes).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    return Object.fromEntries(sorted.filter((e) => e.name !== except).map((e, i, all) => {
        const next = sorted[sorted.indexOf(e) + 1]?.localOffset ?? end;
        return [e.name, Buffer.from(bytes.subarray(e.localOffset, next)).toString("base64")];
    }));
}

for (const [layout, options] of [["stored", {}], ["deflated", { deflate: true }], ["deflated with data descriptors", { deflate: true, descriptors: true }]] as const) {
    test(`replacing one entry keeps every other byte (${layout})`, () => {
        const book = epub2(undefined, options);
        const replaced = replaceEntry(book, "OEBPS/content.opf", new TextEncoder().encode("<package/>"));

        expect(readEntry(replaced, "OEBPS/content.opf")?.toString()).toBe("<package/>");
        expect(entries(replaced)).toEqual(entries(book));
        expect(rawRecords(replaced, "OEBPS/content.opf")).toEqual(rawRecords(book, "OEBPS/content.opf"));
        // The mimetype stays first and stored
        const first = listEntries(replaced).sort((a, b) => a.localOffset - b.localOffset)[0]!;
        expect([first.name, first.method, first.localOffset]).toEqual(["mimetype", 0, 0]);
    });
}

test("a rewritten EPUB is still a valid EPUB", () => {
    const book = validEpub();
    const opf = readEntry(book, "OEBPS/content.opf")!;
    const replaced = replaceEntry(book, "OEBPS/content.opf", opf);
    expect(validateEpub(replaced).counts).toEqual({ fatal: 0, error: 0, warning: 0 });
});

test("reading entries", () => {
    const book = zip([["mimetype", "application/epub+zip"], ["a.txt", "Call me Ishmael."]], { deflate: true });
    expect(readEntry(book, "a.txt")?.toString()).toBe("Call me Ishmael.");
    expect(readEntry(book, "missing.txt")).toBeNull();
});

test("what is not a ZIP is an error", () => {
    expect(() => listEntries(new TextEncoder().encode("Call me Ishmael."))).toThrow(ZipError);
    expect(() => replaceEntry(validEpub(), "missing.txt", new Uint8Array())).toThrow(ZipError);
});
