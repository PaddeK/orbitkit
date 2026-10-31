import type { UrlMapper } from "./mapper.ts";

// Handwritten declaration with double quotes, like Calibre-Web sends; picky reader firmware may expect it
export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';

const EXTENSIONS: Record<string, string> = {
    "application/epub+zip": "epub",
    "application/kepub+zip": "kepub.epub",
    "application/pdf": "pdf",
    "application/x-mobipocket-ebook": "mobi",
    "application/x-mobi8-ebook": "azw3",
    "application/vnd.amazon.ebook": "azw",
    "application/x-fictionbook+xml": "fb2",
    "application/x-zip-compressed-fb2": "fb2.zip",
    "application/vnd.comicbook+zip": "cbz",
    "application/x-cbz": "cbz",
    "application/vnd.comicbook-rar": "cbr",
    "application/x-cbr": "cbr",
    "image/vnd.djvu": "djvu",
    "image/x-djvu": "djvu",
    "text/plain": "txt",
    "application/rtf": "rtf",
    "text/rtf": "rtf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
};

const UNSAFE_FILENAME_CHARS = /[\x00-\x1f/\\:*?"<>|]+/g;
// OPDS/OpenSearch template parameters like {searchTerms} or {startPage?}
const PLACEHOLDER = /\{[^{}\s]+\}/g;

export class XmlError extends Error {}

export function baseMime(contentType: string | null | undefined): string {
    return (contentType ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

export function extensionFor(contentType: string | null | undefined): string | undefined {
    return EXTENSIONS[baseMime(contentType)];
}

export function safeFilename(title: string | null | undefined, ext: string, fallback = "book"): string {
    const cleaned = (title ?? "").replace(UNSAFE_FILENAME_CHARS, " ").split(/\s+/).filter(Boolean).join(" ");
    const name = cleaned.replace(/^[ .]+|[ .]+$/g, "").slice(0, 120).replace(/[ .]+$/, "") || fallback;
    return `${name}.${ext}`;
}

function isFeedType(contentType: string | null | undefined): boolean {
    const mime = baseMime(contentType);
    return mime.endsWith("+xml") || ["text/xml", "application/xml", "text/html", ""].includes(mime);
}

export function rewriteLink(href: string, sourceUrl: string, mapper: UrlMapper, type?: string | null,
                            rel?: string | null, title?: string | null): string {
    // URL parsing would percent-encode the braces of template placeholders, so park them meanwhile
    const saved: string[] = [];
    const masked = href.replace(PLACEHOLDER, (m) => `opdsph${saved.push(m) - 1}x`);
    const restore = (s: string) => s.replace(/opdsph(\d+)x/g, (_, i) => saved[Number(i)]!);

    let absolute: string;
    try {
        absolute = new URL(masked, sourceUrl).toString();
    } catch {
        return href;
    }
    const tail = mapper.tailOf(absolute);
    if (tail === null) return restore(absolute);

    const ext = extensionFor(type);
    if (ext && !isFeedType(type)) {
        if (baseMime(type).startsWith("image/")) {
            return mapper.fileUrl(restore(tail), `${rel?.includes("thumbnail") ? "thumbnail" : "cover"}.${ext}`);
        }
        return mapper.fileUrl(restore(tail), safeFilename(title, ext));
    }
    return restore(mapper.feedUrl(tail));
}

type Node = Bun.XML.Node;
type Child = Node["children"][number];

const isElement = (c: Child): c is Node => typeof c === "object" && "name" in c;
/** Element name without namespace prefix */
export const localName = (node: Node) => node.name.slice(node.name.indexOf(":") + 1);

export function textContent(node: Node): string {
    return node.children.map((c) => (typeof c === "string" ? c : isElement(c) ? textContent(c) : "")).join("");
}

/** Parse XML into Bun's document-order tree; XmlError if it is not well-formed. */
export function parseXml(xml: string): Node {
    try {
        return Bun.XML.parse(xml, { compact: false });
    } catch (err) {
        throw new XmlError((err as Error).message);
    }
}

/** All elements below and including `node`, in document order. */
export function* elements(node: Node): Generator<Node> {
    yield node;
    for (const c of node.children) if (isElement(c)) yield* elements(c);
}

/**
 * Sort links like BookOrbit's rel="http://opds-spec.org/sort/series" belong to the feed, but BookOrbit also puts them in
 * entries, untyped and before the book. PocketBook's reader downloads that link instead of the book: the series feed
 * lands on the reader as the "book".
 */
const isSortLinkInEntry = (c: Child) => isElement(c) && localName(c) === "link" && !!c.attributes.rel?.startsWith("http://opds-spec.org/sort/");

function rewriteTree(node: Node, sourceUrl: string, mapper: UrlMapper, entryTitle: string | null): void {
    const attrs = node.attributes;
    const name = localName(node);
    if (name === "entry") node.children = node.children.filter((c) => !isSortLinkInEntry(c));
    if (name === "link" && attrs.href) {
        attrs.href = rewriteLink(attrs.href, sourceUrl, mapper, attrs.type, attrs.rel, entryTitle);
    } else if (name === "Url" && attrs.template) {
        attrs.template = rewriteLink(attrs.template, sourceUrl, mapper);
    }
    // Links directly inside an <entry> name their download after the entry's title
    const title = name === "entry" ? node.children.find((c) => isElement(c) && localName(c) === "title") : undefined;
    const childTitle = title ? textContent(title as Node).trim() : null;
    for (const c of node.children) if (isElement(c)) rewriteTree(c, sourceUrl, mapper, childTitle);
}

/** Rewrite all links in an Atom/OPDS feed or OpenSearch description to go through the proxy. */
export function rewriteDocument(xml: string, sourceUrl: string, mapper: UrlMapper): string {
    const root = parseXml(xml);
    rewriteTree(root, sourceUrl, mapper, null);
    // Only the root element survives; our declaration replaces the original one
    return XML_DECLARATION + Bun.XML.stringify(root);
}
