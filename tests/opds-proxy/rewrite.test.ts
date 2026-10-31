import { describe, expect, test } from "bun:test";
import { InvalidPath, UrlMapper } from "../../src/opds-proxy/proxy/mapper.ts";
import { elements, localName, parseXml, rewriteDocument, rewriteLink, safeFilename } from "../../src/opds-proxy/proxy/rewrite.ts";

const FIXTURES = `${import.meta.dir}/fixtures`;
const ORIGIN = "http://bookorbit:3000";
const BASE = "/api/v1/opds";
const PUBLIC = "http://192.168.0.10:8601/tok";
const mapper = new UrlMapper(ORIGIN + BASE, PUBLIC);

const fixture = (name: string) => Bun.file(`${FIXTURES}/${name}`).text();
const byName = (xml: string, name: string) => [...elements(parseXml(xml))].filter((e) => localName(e) === name);
const links = (xml: string) => byName(xml, "link");
const hrefs = (xml: string) => links(xml).map((l) => l.attributes.href!);

describe("UrlMapper", () => {
    test("feed URLs round-trip", () => {
        expect(mapper.feedUrl("")).toBe(PUBLIC + "/");
        expect(mapper.feedUrl("/recent?page=2&size=50")).toBe(PUBLIC + "/recent?page=2&size=50");
        expect(mapper.upstreamUrl("")).toBe(ORIGIN + BASE);
        expect(mapper.upstreamUrl("/")).toBe(ORIGIN + BASE);
        expect(mapper.upstreamUrl("/recent", "?page=2&size=50")).toBe(ORIGIN + BASE + "/recent?page=2&size=50");
        // Percent-encoding from upstream links must survive untouched
        expect(mapper.upstreamUrl("/catalog", "?author=Melville%2C%20Herman")).toBe(ORIGIN + BASE + "/catalog?author=Melville%2C%20Herman");
    });

    test("file URLs round-trip", () => {
        const url = mapper.fileUrl("/1/download?fileId=1&selection=abc", "Moby Dick.epub");
        expect(url.endsWith("/Moby%20Dick.epub")).toBe(true);
        expect(mapper.upstreamUrl(url.slice(PUBLIC.length))).toBe(ORIGIN + BASE + "/1/download?fileId=1&selection=abc");
    });

    test.each(["/../users", "/a/../../admin", "/%2e%2e/users", "/a/%2E%2E/b", "/..\\x"])(
        "rejects escaping the OPDS subtree: %s", (path) => {
            expect(() => mapper.upstreamUrl(path)).toThrow(InvalidPath);
        });

    test("rejects escaping via file token", () => {
        const url = mapper.fileUrl("/../admin", "x.epub");
        expect(() => mapper.upstreamUrl(url.slice(PUBLIC.length))).toThrow(InvalidPath);
        expect(() => mapper.upstreamUrl("/_f/!!!notbase64/x.epub")).toThrow(InvalidPath);
    });

    test("tailOf", () => {
        expect(mapper.tailOf(ORIGIN + BASE)).toBe("");
        expect(mapper.tailOf(ORIGIN + BASE + "/recent?x=1#frag")).toBe("/recent?x=1");
        expect(mapper.tailOf(ORIGIN + BASE + "foo")).toBeNull();
        expect(mapper.tailOf(ORIGIN + "/api/v1/books")).toBeNull();
        expect(mapper.tailOf("https://example.org" + BASE)).toBeNull();
    });
});

describe("rewriteDocument", () => {
    test("root feed links all go through the proxy", async () => {
        const out = rewriteDocument(await fixture("bookorbit_root.xml"), ORIGIN + BASE, mapper);
        expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<feed ')).toBe(true);
        const all = hrefs(out);
        expect(all.length).toBeGreaterThan(0);
        expect(all.every((h) => h.startsWith(PUBLIC + "/"))).toBe(true);
        expect(all).toContain(PUBLIC + "/recent");
        expect(all).toContain(PUBLIC + "/catalog?q={searchTerms}"); // placeholder stays literal
        expect(all).toContain(PUBLIC + "/search.opds");
    });

    test("acquisition feed files get real filenames", async () => {
        const out = rewriteDocument(await fixture("bookorbit_recent.xml"), ORIGIN + BASE + "/recent", mapper);
        const byRel = Object.fromEntries(links(out).map((l) => [l.attributes.rel, l.attributes.href!]));
        const book = byRel["http://opds-spec.org/acquisition"]!;
        expect(book.startsWith(PUBLIC + "/_f/")).toBe(true);
        expect(book.endsWith("/Moby%20Dick%3B%20or%2C%20The%20Whale.epub")).toBe(true);
        expect(mapper.upstreamUrl(book.slice(PUBLIC.length))).toBe(ORIGIN + BASE + "/1/download?fileId=1&selection=SIGNED.TOKEN_1");
        expect(byRel["http://opds-spec.org/image"]!.endsWith("/cover.jpg")).toBe(true);
        expect(byRel["http://opds-spec.org/image/thumbnail"]!.endsWith("/thumbnail.jpg")).toBe(true);
        // Non-link content and namespaces are left alone
        expect(out).toContain("Melville, Herman");
        expect(out).toContain("<dc:identifier>urn:gutenberg:2701</dc:identifier>");
        expect(out).toContain('xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"');
    });

    test("OpenSearch template rewritten", async () => {
        const out = rewriteDocument(await fixture("bookorbit_osd.xml"), ORIGIN + BASE + "/search.opds", mapper);
        expect(byName(out, "Url")[0]!.attributes.template).toBe(PUBLIC + "/catalog?q={searchTerms}");
    });

    test("placeholders in the path survive (Calibre-Web style)", () => {
        const m = new UrlMapper("http://calibre:8083/opds", PUBLIC);
        expect(rewriteLink("/opds/search/{searchTerms}", "http://calibre:8083/opds", m, "application/atom+xml"))
            .toBe(PUBLIC + "/search/{searchTerms}");
    });

    test("foreign links left absolute", () => {
        const xml = '<feed xmlns="http://www.w3.org/2005/Atom"><link rel="related" href="https://example.org/x"/></feed>';
        expect(hrefs(rewriteDocument(xml, ORIGIN + BASE, mapper))).toEqual(["https://example.org/x"]);
    });

    test("keeps document order, mixed content and comments", () => {
        const xml = '<?xml version=\'1.0\'?>\n<feed xmlns="http://www.w3.org/2005/Atom"><link href="/api/v1/opds/a"/><entry><title>T</title></entry>'
            + '<link href="/api/v1/opds/b"/><!-- note --><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Hello <b>bold</b> world &amp; <![CDATA[<more>]]></div></content></feed>';
        expect(rewriteDocument(xml, ORIGIN + BASE, mapper)).toBe('<?xml version="1.0" encoding="UTF-8"?>\n'
            + `<feed xmlns="http://www.w3.org/2005/Atom"><link href="${PUBLIC}/a"/><entry><title>T</title></entry>`
            + `<link href="${PUBLIC}/b"/><!-- note --><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Hello <b>bold</b> world &amp; &lt;more&gt;</div></content></feed>`);
    });

    test("download filename comes from the entry title, wherever it sits", () => {
        const xml = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><link href="/api/v1/opds/1/download" type="application/epub+zip"/>'
            + "<title>Late &amp; Title</title></entry></feed>";
        expect(hrefs(rewriteDocument(xml, ORIGIN + BASE, mapper))[0]!.endsWith("/Late%20%26%20Title.epub")).toBe(true);
    });

    test("sort links leave entries, so PocketBook downloads the book and not the series feed", () => {
        const xml = '<feed xmlns="http://www.w3.org/2005/Atom"><link rel="http://opds-spec.org/sort/new" href="/api/v1/opds/recent"/>'
            + '<entry><title>Burning Chrome</title><link rel="http://opds-spec.org/sort/series" href="/api/v1/opds/catalog?seriesId=53" title="The Sprawl Trilogy #0"/>'
            + '<link rel="http://opds-spec.org/acquisition" href="/api/v1/opds/107/download?fileId=249" type="application/epub+zip"/></entry></feed>';
        const out = rewriteDocument(xml, ORIGIN + BASE, mapper);
        expect(links(out).map((l) => l.attributes.rel)).toEqual(["http://opds-spec.org/sort/new", "http://opds-spec.org/acquisition"]);
        expect(hrefs(out)[1]!.endsWith("/Burning%20Chrome.epub")).toBe(true);
    });

    test("rejects malformed XML", () => {
        expect(() => rewriteDocument("<feed><unclosed></feed>", ORIGIN + BASE, mapper)).toThrow();
    });
});

test.each([
    ["Moby Dick; or, The Whale", "Moby Dick; or, The Whale.epub"],
    ['A/B: "C"?', "A B C.epub"],
    ["   ", "book.epub"],
    [null, "book.epub"],
    ["x".repeat(300), "x".repeat(120) + ".epub"],
])("safeFilename(%p)", (title, expected) => {
    expect(safeFilename(title, "epub")).toBe(expected);
});
