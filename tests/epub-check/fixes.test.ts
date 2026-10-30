import { describe, expect, test } from "bun:test";
import { applyOwnFix, Book, OWN_FIXES, type OwnFix } from "../../src/epub-check/fixes.ts";
import { validateEpub } from "../../src/epub-check/validator.ts";
import { readEntry } from "../../src/epub-check/zip.ts";
import { CHAPTER, CHAPTER_2, CONTAINER, epub2, NAV, NCX, opf2, validEpub, zip } from "./epub.ts";

const fix = (key: string): OwnFix => OWN_FIXES.find((f) => f.key === key)!;
const detect = (key: string, book: Uint8Array) => fix(key).detect(Book.load(book)!);
const text = (book: Uint8Array, name: string) => readEntry(book, name)!.toString("utf8");
const errors = (book: Uint8Array) => validateEpub(book).findings.filter((f) => f.severity === "error" || f.severity === "fatal");

interface Epub3 {
    metadata?: string;
    modified?: string;
    manifest?: string;
    spine?: string;
    chapter?: string;
    nav?: string;
    files?: [string, string][];
}

/** An EPUB 3 to put one defect into; valid as it comes */
function epub3(o: Epub3 = {}): Uint8Array {
    const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:opf="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:7c4b4a4e-4f6b-4b8e-9d55-3f0d1e2b2701</dc:identifier>
    <dc:title>Moby Dick</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${o.modified ?? "2026-10-29T00:00:00Z"}</meta>${o.metadata ?? `
    <dc:creator>Herman Melville</dc:creator>`}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>${o.manifest ?? ""}
  </manifest>
  <spine${o.spine ?? ""}><itemref idref="ch1"/></spine>
</package>`;
    return zip([
        ["mimetype", "application/epub+zip"],
        ["META-INF/container.xml", CONTAINER],
        ["OEBPS/content.opf", opf],
        ["OEBPS/nav.xhtml", o.nav ?? NAV],
        ["OEBPS/chapter1.xhtml", o.chapter ?? CHAPTER],
        ...(o.files ?? []),
    ]);
}

/** The defect is real, the fix is safe and removes every error, and it finds nothing in a valid book */
function fixes(key: string, broken: Uint8Array): Uint8Array {
    expect(errors(broken).length).toBeGreaterThan(0);
    const found = detect(key, broken)!;
    expect(found.safe).toBe(true);
    const fixed = applyOwnFix(fix(key), broken)!;
    expect(errors(fixed)).toEqual([]);
    expect(applyOwnFix(fix(key), fixed)).toBeNull();
    return fixed;
}

test("the fixture books are valid as they come", () => {
    expect(errors(epub3())).toEqual([]);
    expect(errors(epub2(""))).toEqual([]);
    for (const f of OWN_FIXES) expect(f.detect(Book.load(epub3())!)).toBeNull();
});

test("1. dcterms:modified with milliseconds", () => {
    const fixed = fixes("modified", epub3({ modified: "2026-10-24T04:01:37.489Z" }));
    expect(text(fixed, "OEBPS/content.opf")).toContain('<meta property="dcterms:modified">2026-10-24T04:01:37Z</meta>');
    expect(detect("modified", epub3({ modified: "2026-10-24T04:01:37.489Z" }))!.title).toContain("2026-10-24T04:01:37.489Z → 2026-10-24T04:01:37Z");
});

describe("2. EPUB 2 attributes on metadata in an EPUB 3 package", () => {
    test("move into <meta refines>, with an id where the element has none", () => {
        const broken = epub3({ metadata: `
    <dc:identifier opf:scheme="GOODREADS">22886612</dc:identifier>
    <dc:creator id="c1" opf:role="aut" opf:file-as="Melville, Herman">Herman Melville</dc:creator>` });
        const opf = text(fixes("epub2-attributes", broken), "OEBPS/content.opf");
        expect(opf).toContain('<dc:identifier id="identifier-1">22886612</dc:identifier>\n    <meta refines="#identifier-1" property="identifier-type">GOODREADS</meta>');
        expect(opf).toContain('<meta refines="#c1" property="role" scheme="marc:relators">aut</meta>');
        expect(opf).toContain('<meta refines="#c1" property="file-as">Melville, Herman</meta>');
        expect(opf).not.toContain("opf:");
    });

    test("an EPUB 3 refinement saying something else is left alone", () => {
        const broken = epub3({ metadata: `
    <dc:creator id="c1" opf:role="aut">Herman Melville</dc:creator>
    <meta refines="#c1" property="role" scheme="marc:relators">edt</meta>` });
        expect(detect("epub2-attributes", broken)).toBeNull();
    });

    test("one that says the same only loses the attribute", () => {
        const broken = epub3({ metadata: `
    <dc:creator id="c1" opf:role="aut">Herman Melville</dc:creator>
    <meta refines="#c1" property="role" scheme="marc:relators">aut</meta>` });
        const opf = text(fixes("epub2-attributes", broken), "OEBPS/content.opf");
        expect(opf.match(/property="role"/g)).toHaveLength(1);
    });

    test("also with another prefix for the OPF namespace, declared on the element (as calibre writes it)", () => {
        const broken = epub3({ metadata: `
    <dc:creator>Herman Melville</dc:creator>
    <dc:contributor xmlns:ns2="http://www.idpf.org/2007/opf" ns2:role="bkp">calibre (2.46.0)</dc:contributor>` });
        const opf = text(fixes("epub2-attributes", broken), "OEBPS/content.opf");
        expect(opf).toContain('<dc:contributor id="contributor-1">calibre (2.46.0)</dc:contributor>\n    <meta refines="#contributor-1" property="role" scheme="marc:relators">bkp</meta>');
        expect(opf).not.toContain("ns2");
    });

    test("in EPUB 2, where they belong, nothing is done", () => {
        expect(detect("epub2-attributes", epub2(`\n    <dc:creator opf:role="aut">Herman Melville</dc:creator>`))).toBeNull();
    });
});

test("3. refinements of elements that no longer exist, also refinements of those", () => {
    const fixed = fixes("dangling-refines", epub3({ metadata: `
    <dc:creator id="creator-1">Herman Melville</dc:creator>
    <meta refines="#creator-1" property="role" scheme="marc:relators">aut</meta>
    <meta id="role01" property="role" refines="#creator01" scheme="marc:relators">aut</meta>
    <meta property="file-as" refines="#creator01">MELVILLE, HERMAN</meta>
    <meta property="alternate-script" refines="#role01">aut</meta>` }));
    const opf = text(fixed, "OEBPS/content.opf");
    expect(opf).not.toContain("creator01");
    expect(opf).not.toContain("role01");
    expect(opf).toContain('<meta refines="#creator-1" property="role" scheme="marc:relators">aut</meta>\n  </metadata>');
});

describe("4. Amazon conversion leftovers", () => {
    const amazon = CHAPTER.replace("<p>Call me Ishmael.</p>", '<p class="x" data-AmznRemoved-M8="true" data-AmznRemoved="mobi7">Call me Ishmael.</p>');

    test("are removed from EPUB 3 and EPUB 2 books", () => {
        const fixed = fixes("amazon-attributes", epub3({ chapter: amazon }));
        expect(text(fixed, "OEBPS/chapter1.xhtml")).toContain('<p class="x">Call me Ishmael.</p>');
        const epub2Book = zip([
            ["mimetype", "application/epub+zip"], ["META-INF/container.xml", CONTAINER], ["OEBPS/content.opf", opf2("")], ["OEBPS/toc.ncx", NCX],
            ["OEBPS/chapter1.xhtml", CHAPTER_2.replace("<p>", '<p data-AmznRemoved="mobi7">')],
        ]);
        fixes("amazon-attributes", epub2Book);
    });

    test("stay when a stylesheet selects on them", () => {
        const book = epub3({
            chapter: amazon, manifest: `\n    <item id="css" href="style.css" media-type="text/css"/>`,
            files: [["OEBPS/style.css", "p[data-AmznRemoved] { display: none; }"]],
        });
        expect(detect("amazon-attributes", book)).toBeNull();
    });
});

test("5. links to stylesheets that are not in the book; those that are stay", () => {
    const chapter = CHAPTER.replace("<title>Loomings</title>", `<title>Loomings</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
<link rel="stylesheet" type="text/css" href="../Styles/page_styles1.css"/>`);
    const fixed = fixes("missing-stylesheets", epub3({
        chapter, manifest: `\n    <item id="css" href="style.css" media-type="text/css"/>`, files: [["OEBPS/style.css", "p { margin: 0; }"]],
    }));
    const html = text(fixed, "OEBPS/chapter1.xhtml");
    expect(html).toContain('href="style.css"');
    expect(html).not.toContain("page_styles1.css");
});

describe("6. page lists", () => {
    const ncx = (targets: string) => NCX.replace("</navMap>", `</navMap>
  <pageList>
    <navLabel><text>Pages</text></navLabel>${targets}
  </pageList>`).replace('content="7c4b4a4e', 'content="urn:uuid:7c4b4a4e');
    const target = (page: number, playOrder: number) => `
    <pageTarget id="p${page}" type="normal" value="${page}" playOrder="${playOrder}"><navLabel><text>${page}</text></navLabel><content src="chapter1.xhtml#pg_${page}"/></pageTarget>`;
    const nav = (items: string) => NAV.replace("</body>", `<nav epub:type="page-list" hidden=""><ol>${items}</ol></nav>\n</body>`);
    const item = (page: number) => `<li><a href="chapter1.xhtml#pg_${page}">${page}</a></li>`;
    const book = (chapter: string, pages: number[]) => epub3({
        chapter, nav: nav(pages.map(item).join("")),
        manifest: `\n    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`, spine: ' toc="ncx"',
        // Page entries share the playOrder sequence with the table of contents: here they come before and after it
        files: [["OEBPS/toc.ncx", ncx(pages.map((p, i) => target(p, i === 0 ? 1 : i + 2)).join("")).replace('playOrder="1"><navLabel><text>Loomings', 'playOrder="2"><navLabel><text>Loomings')]],
    });

    test("with every marker gone, the whole page list goes (NCX and nav)", () => {
        const fixed = fixes("page-list", book(CHAPTER, [9, 10, 11]));
        expect(text(fixed, "OEBPS/toc.ncx")).not.toContain("pageList");
        expect(text(fixed, "OEBPS/nav.xhtml")).not.toContain("page-list");
        expect(detect("page-list", book(CHAPTER, [9, 10, 11]))!.changes.map((c) => c.note)).toEqual([
            "remove the page list (3 entries)", "remove the page-list nav (3 entries)",
        ]);
    });

    test("entries whose markers exist stay", () => {
        const chapter = CHAPTER.replace("<p>Call me Ishmael.</p>", '<p><span id="pg_10"/>Call me Ishmael.</p>');
        const fixed = fixes("page-list", book(chapter, [9, 10, 11]));
        expect(text(fixed, "OEBPS/toc.ncx").match(/<pageTarget/g)).toHaveLength(1);
        // Renumbered without gaps, in the old order: the chapter (2 → 1) before page 10 (3 → 2)
        expect(text(fixed, "OEBPS/toc.ncx").match(/playOrder="\d+"/g)).toEqual(['playOrder="1"', 'playOrder="2"']);
        expect(text(fixed, "OEBPS/nav.xhtml")).toContain('href="chapter1.xhtml#pg_10"');
        expect(text(fixed, "OEBPS/nav.xhtml")).not.toContain("pg_9");
    });
});

test("7. an empty <guide>", () => {
    const broken = zip([
        ["mimetype", "application/epub+zip"], ["META-INF/container.xml", CONTAINER],
        ["OEBPS/content.opf", opf2("").replace("</spine>", "</spine>\n  <guide/>")], ["OEBPS/toc.ncx", NCX], ["OEBPS/chapter1.xhtml", CHAPTER_2],
    ]);
    const fixed = fixes("empty-guide", broken);
    expect(text(fixed, "OEBPS/content.opf")).toBe(opf2(""));
});

test("fixes are found in a book loaded once and work on books that are no EPUB as nothing", () => {
    expect(Book.load(new TextEncoder().encode("Call me Ishmael."))).toBeNull();
    expect(applyOwnFix(fix("modified"), validEpub())).toBeNull();
});
