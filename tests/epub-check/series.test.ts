import { expect, test } from "bun:test";
import { applySeriesFix, planSeriesFix } from "../../src/epub-check/series.ts";
import { validateEpub } from "../../src/epub-check/validator.ts";
import { readEntry } from "../../src/epub-check/zip.ts";
import { BOOKORBIT_SERIES, CALIBRE_SERIES, epub2, opf2, validEpub } from "./epub.ts";

const opfOf = (book: Uint8Array) => readEntry(book, "OEBPS/content.opf")!.toString("utf8");

test("BookOrbit's EPUB 3 series metas make an EPUB 2 invalid", () => {
    expect(validateEpub(epub2()).counts.error).toBeGreaterThan(0);
    expect(validateEpub(epub2(CALIBRE_SERIES)).counts).toEqual({ fatal: 0, error: 0, warning: 0 });
});

test("with the same series in calibre metas, removing the EPUB 3 ones is safe", () => {
    const plan = planSeriesFix(epub2())!;
    expect(plan.safe).toBe(true);
    expect(plan.title).toContain('"The Whale & Co" #1 stays as calibre:series');
    expect(plan.opfPath).toBe("OEBPS/content.opf");

    const fixed = applySeriesFix(epub2())!;
    // Exactly the book without them: nothing else in the OPF moved, not even a blank line
    expect(opfOf(fixed)).toBe(opf2(CALIBRE_SERIES));
    expect(validateEpub(fixed).counts).toEqual({ fatal: 0, error: 0, warning: 0 });
});

test("a series position written differently still matches", () => {
    const plan = planSeriesFix(epub2(CALIBRE_SERIES.replace('content="1"', 'content="1.0"') + BOOKORBIT_SERIES))!;
    expect(plan.safe).toBe(true);
});

test("without calibre metas, the series moves there: to confirm", () => {
    const book = epub2(BOOKORBIT_SERIES);
    const plan = planSeriesFix(book)!;
    expect(plan.safe).toBe(false);
    expect(plan.title).toBe('Move the series "The Whale & Co" #1 from BookOrbit\'s EPUB 3 metas to calibre:series');

    const fixed = applySeriesFix(book)!;
    expect(opfOf(fixed)).toBe(opf2(CALIBRE_SERIES));
    expect(validateEpub(fixed).counts).toEqual({ fatal: 0, error: 0, warning: 0 });
});

test("a different calibre series is kept, dropping BookOrbit's: to confirm", () => {
    const other = CALIBRE_SERIES.replace("The Whale &amp; Co", "Pequod");
    const plan = planSeriesFix(epub2(other + BOOKORBIT_SERIES))!;
    expect(plan.safe).toBe(false);
    expect(plan.title).toContain('the calibre series "Pequod" #1 stays');
    expect(plan.rationale).toContain("Check which one is right");
    expect(opfOf(applySeriesFix(epub2(other + BOOKORBIT_SERIES))!)).toBe(opf2(other));
});

test("prefixed meta elements are handled", () => {
    const prefixed = (CALIBRE_SERIES + BOOKORBIT_SERIES).replaceAll("<meta ", "<opf:meta ").replaceAll("</meta>", "</opf:meta>");
    const fixed = applySeriesFix(epub2(prefixed))!;
    expect(opfOf(fixed)).toBe(opf2(CALIBRE_SERIES.replaceAll("<meta ", "<opf:meta ")));
});

test("works on deflated EPUBs with data descriptors", () => {
    const fixed = applySeriesFix(epub2(undefined, { deflate: true, descriptors: true }))!;
    expect(validateEpub(fixed).counts).toEqual({ fatal: 0, error: 0, warning: 0 });
});

test("nothing to do for EPUB 3, valid EPUB 2, and series metas that are not BookOrbit's", () => {
    expect(planSeriesFix(validEpub())).toBeNull();
    expect(planSeriesFix(epub2(CALIBRE_SERIES))).toBeNull();
    // A collection that is not a series, and two collections, are someone else's metadata
    expect(planSeriesFix(epub2(BOOKORBIT_SERIES.replace(">series<", ">set<")))).toBeNull();
    expect(planSeriesFix(epub2(BOOKORBIT_SERIES + BOOKORBIT_SERIES.replaceAll("series-col", "other")))).toBeNull();
    expect(planSeriesFix(new TextEncoder().encode("Call me Ishmael."))).toBeNull();
    expect(applySeriesFix(validEpub())).toBeNull();
});
