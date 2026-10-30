import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Epublift } from "../../src/epub-check/epublift.ts";
import { Book } from "../../src/epub-check/fixes.ts";
import { EPUBLIFT_FIX, planRepair, repair } from "../../src/epub-check/repairer.ts";
import { validateEpub } from "../../src/epub-check/validator.ts";
import { CHAPTER_2, CONTAINER, NCX, opf2, validEpub, zip } from "./epub.ts";

// Tests run where epublift is installed (EPUB_CHECK_EPUBLIFT_PATH, PATH or ~/.local/bin); CI installs the pinned release
const command = process.env.EPUB_CHECK_EPUBLIFT_PATH ?? Bun.which("epublift") ?? join(homedir(), ".local/bin/epublift");
const epublift = await Epublift.find(command, await mkdtemp(join(tmpdir(), "orbitkit-lift-")));

/** An EPUB 2 book with EPUB 3 markup in its chapter, as Kindle conversions turn out */
function epub2WithHtml5(extra = "", css = "p { margin: 0; }"): Uint8Array {
    const chapter = CHAPTER_2
        .replace('<html xmlns="http://www.w3.org/1999/xhtml">', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">')
        .replace("<head><title>Loomings</title></head>", '<head><title>Loomings</title><link rel="stylesheet" type="text/css" href="style.css"/></head>')
        .replace("<p>Call me Ishmael.</p>", `<div epub:type="chapter"><p>Call me Ishmael.</p></div>${extra}`);
    return zip([
        ["mimetype", "application/epub+zip"], ["META-INF/container.xml", CONTAINER],
        ["OEBPS/content.opf", opf2("", `\n    <item id="css" href="style.css" media-type="text/css"/>`)], ["OEBPS/toc.ncx", NCX],
        ["OEBPS/chapter1.xhtml", chapter], ["OEBPS/style.css", css],
    ]);
}

const errorCount = (book: Uint8Array) => {
    const { counts } = validateEpub(book);
    return counts.fatal + counts.error;
};

describe.skipIf(!epublift)("epublift", () => {
    test("is found and reports its version", () => {
        expect(epublift!.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    test("an EPUB 2 book with EPUB 3 markup is offered the upgrade, to confirm, and it makes the book valid", async () => {
        const book = epub2WithHtml5();
        expect(errorCount(book)).toBeGreaterThan(0);
        const plan = (await planRepair(book, { epublift: epublift! }))!;
        const lift = plan.fixes.find((f) => f.index === EPUBLIFT_FIX)!;
        expect(lift).toMatchObject({ source: "epublift", safe: false, title: "Upgrade the book from EPUB 2 to EPUB 3 with epublift" });
        expect(lift.rationale).toMatch(/errors \d+ → 0/);
        // Not among the safe fixes
        expect(plan.safe.outcomes[EPUBLIFT_FIX]?.outcome).toBe("skipped");

        const result = (await repair(book, [EPUBLIFT_FIX], { epublift: epublift! }))!;
        expect(result.result.outcomes[EPUBLIFT_FIX]?.outcome).toBe("applied");
        expect(errorCount(result.bytes)).toBe(0);
        expect(Book.load(result.bytes)!.version).toMatch(/^3\./);
    });

    test("an upgrade that would leave the book worse is not offered", async () => {
        // valign is fine in EPUB 2 but an error in EPUB 3; epublift 4.5.1 leaves it where the CSS sets vertical-align too
        const table = '<table><tr><td valign="top">1</td><td valign="top">2</td><td valign="top">3</td></tr></table>';
        const plan = await planRepair(epub2WithHtml5(table, "td { vertical-align: middle; }"), { epublift: epublift! });
        expect(plan?.fixes.some((f) => f.index === EPUBLIFT_FIX) ?? false).toBe(false);
    });

    test("EPUB 3 books are not offered it, and what is no EPUB fails quietly", async () => {
        expect(await planRepair(validEpub(), { epublift: epublift! })).toBeNull();
        expect(await epublift!.lift(new TextEncoder().encode("Call me Ishmael."))).toBeNull();
    });
});
