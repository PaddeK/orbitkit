import { analyzeSeries } from "./series.ts";
import { listEntries, readEntry, replaceEntries, ZipError } from "./zip.ts";

/**
 * orbitkit's own fixes (EPUB_CHECK_FIXES), for defects epubsana does not repair. Each one finds exactly one pattern,
 * has exactly one correct repair, and says what it changes. A fix is detected again on the book it is applied to, so
 * it applies the same way whether it runs alone or after other fixes.
 */

/** One of orbitkit's fixes, found in a book */
export interface Detected {
    /** Safe to apply without asking; otherwise it is a choice to confirm */
    safe: boolean;
    /** epubcheck-compatible code of the findings it removes */
    code: string;
    title: string;
    rationale: string;
    changes: { path: string; note: string }[];
    /** New contents by file inside the EPUB */
    edits: Map<string, string>;
}

export interface OwnFix {
    /** Handle in a book's repair plan; negative, so it never collides with epubsana's indices */
    index: number;
    key: string;
    detect(book: Book): Detected | null;
}

const CONTENT = /\.x?html?$/i;
const decoder = () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Read access to the files of an EPUB, with the paths resolved the way the container defines them. */
export class Book {
    private readonly texts = new Map<string, string | null>();

    private constructor(readonly bytes: Uint8Array, readonly names: Set<string>, readonly opfPath: string, readonly opf: string) {}

    /** Null if it is no ZIP, has no package document, or that is not UTF-8. */
    static load(bytes: Uint8Array): Book | null {
        try {
            const names = new Set(listEntries(bytes).map((e) => e.name));
            const container = readEntry(bytes, "META-INF/container.xml")?.toString("utf8");
            const opfPath = container && /<(?:[\w.-]+:)?rootfile\b[^>]*\sfull-path\s*=\s*["']([^"']+)["']/.exec(container)?.[1];
            const opf = opfPath ? readEntry(bytes, opfPath) : null;
            return opfPath && opf ? new Book(bytes, names, opfPath, decoder().decode(opf)) : null;
        } catch (err) {
            if (err instanceof ZipError || err instanceof TypeError || err instanceof RangeError) return null;
            throw err;
        }
    }

    get version(): string {
        return /<(?:[\w.-]+:)?package\b[^>]*\sversion\s*=\s*["']([^"']*)["']/.exec(this.opf)?.[1] ?? "";
    }

    /** A file's text, or null if it is missing or not UTF-8 */
    text(name: string): string | null {
        if (name === this.opfPath) return this.opf;
        if (!this.texts.has(name)) {
            let text: string | null = null;
            try {
                const bytes = this.names.has(name) ? readEntry(this.bytes, name) : null;
                text = bytes ? decoder().decode(bytes) : null;
            } catch {
                text = null;
            }
            this.texts.set(name, text);
        }
        return this.texts.get(name)!;
    }

    contentFiles(): string[] {
        return [...this.names].filter((name) => CONTENT.test(name));
    }

    /** Container path of a relative reference from a file; null for remote and absolute URLs. */
    resolve(from: string, href: string): string | null {
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/")) return null;
        const path = href.split("#")[0]!.split("?")[0]!;
        if (!path) return from;
        let decoded = path;
        try {
            decoded = decodeURIComponent(path);
        } catch {
            // Keep it as written
        }
        const segments = from.split("/").slice(0, -1);
        for (const part of decoded.split("/")) {
            if (part === "..") segments.pop();
            else if (part !== "." && part !== "") segments.push(part);
        }
        return segments.join("/");
    }

    /** The ids defined in a file */
    ids(name: string): Set<string> {
        return new Set([...(this.text(name) ?? "").matchAll(/\sid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]!));
    }

    /** The book with some files replaced */
    write(edits: Map<string, string>): Uint8Array {
        const encoder = new TextEncoder();
        return replaceEntries(this.bytes, new Map([...edits].map(([name, text]) => [name, encoder.encode(text)])));
    }
}

export function attr(attrs: string, name: string): string | undefined {
    const match = new RegExp(`\\s${name.replace(/[.:]/g, "\\$&")}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
    return match ? (match[1] ?? match[2]!) : undefined;
}

/** Remove ranges together with the indentation and line break before each, so no blank lines are left. */
export function removeRanges(text: string, ranges: [number, number][]): string {
    const widened = ranges.map(([from, to]): [number, number] => {
        let start = from;
        while (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) start--;
        if (text[start - 1] === "\n") start--;
        if (text[start - 1] === "\r") start--;
        return [start, to];
    });
    return widened.sort((a, b) => b[0] - a[0]).reduce((out, [from, to]) => out.slice(0, from) + out.slice(to), text);
}

function safeDecode(text: string): string {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// 1. A dcterms:modified with fractions of a second: BookOrbit's write-back uses JavaScript's toISOString()
const modified: OwnFix = {
    index: -2, key: "modified",
    detect(book) {
        if (!book.version.startsWith("3")) return null;
        const values: string[] = [];
        const opf = book.opf.replace(
            /(<(?:[\w.-]+:)?meta\b[^>]*\sproperty\s*=\s*["']dcterms:modified["'][^>]*>\s*)(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)Z/g,
            (_, open: string, seconds: string, fraction: string) => {
                values.push(`${seconds}${fraction}Z`);
                return `${open}${seconds}Z`;
            });
        if (!values.length) return null;
        return {
            safe: true, code: "RSC-005",
            title: `Write the modification date as EPUB requires it: ${values[0]} → ${values[0]!.replace(/\.\d+Z$/, "Z")}`,
            rationale: "EPUB 3 requires dcterms:modified in the form CCYY-MM-DDThh:mm:ssZ, without fractions of a second."
                + " Dropping them keeps the date and time to the second. BookOrbit's metadata write-back writes the date with milliseconds.",
            changes: [{ path: book.opfPath, note: `dcterms:modified: drop the fraction of a second` }],
            edits: new Map([[book.opfPath, opf]]),
        };
    },
};

// 2. EPUB 2 attributes (opf:scheme, opf:role, opf:file-as) on metadata in an EPUB 3 package
const EPUB3_FORM: Record<string, { property: string; scheme?: string }> = {
    scheme: { property: "identifier-type" },
    role: { property: "role", scheme: "marc:relators" },
    "file-as": { property: "file-as" },
};
const OPF_NAMESPACE = "http://www.idpf.org/2007/opf";

const epub2Attributes: OwnFix = {
    index: -3, key: "epub2-attributes",
    detect(book) {
        if (!book.version.startsWith("3")) return null;
        const opf = book.opf;
        const ids = new Set([...opf.matchAll(/\sid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]!));
        const metaTag = /<((?:[\w.-]+:)?meta)\b/.exec(opf.slice(opf.search(/<(?:[\w.-]+:)?metadata\b/)))?.[1] ?? "meta";
        const refinements = [...opf.matchAll(/<(?:[\w.-]+:)?meta\b([^>]*)>([^<]*)</g)].map((m) => ({
            refines: attr(m[1]!, "refines"), property: attr(m[1]!, "property"), value: m[2]!.trim(),
        }));
        const edits: [number, number, string][] = [];
        const notes: string[] = [];
        // The OPF namespace may be bound to any prefix, also on the element itself (calibre writes ns2:role)
        const prefixes = new Set(["opf", ...[...opf.matchAll(/\sxmlns:([\w.-]+)\s*=\s*["']([^"']+)["']/g)].filter((m) => m[2] === OPF_NAMESPACE).map((m) => m[1]!)]);
        const element = /<((?:[\w.-]+:)?(?:identifier|creator|contributor))\b([^>]*)>([\s\S]*?)<\/\1\s*>/g;
        for (const m of opf.matchAll(element)) {
            const attrs = m[2]!;
            const found = [...prefixes].flatMap((prefix) => Object.keys(EPUB3_FORM).map((local) => ({ name: `${prefix}:${local}`, local })))
                .filter(({ name }) => attr(attrs, name) !== undefined);
            if (!found.length) continue;
            let id = attr(attrs, "id");
            const local = m[1]!.replace(/^.*:/, "");
            let newId = "";
            if (!id) {
                let n = 1;
                while (ids.has(`${local}-${n}`)) n++;
                id = `${local}-${n}`;
                ids.add(id);
                newId = ` id="${id}"`;
            }
            const metas: string[] = [];
            let conflict = false;
            for (const { name, local: property } of found) {
                const value = attr(attrs, name)!;
                const form = EPUB3_FORM[property]!;
                const existing = refinements.find((r) => r.refines === `#${id}` && r.property === form.property);
                if (existing && existing.value !== value) conflict = true;
                if (!existing) metas.push(`<${metaTag} refines="#${id}" property="${form.property}"${form.scheme ? ` scheme="${form.scheme}"` : ""}>${value}</${metaTag}>`);
            }
            // The EPUB 3 form already says something else: which one is right is not ours to decide
            if (conflict) continue;
            let cleaned = found.reduce((a, { name }) => a.replace(new RegExp(`\\s${name.replace(/[.:]/g, "\\$&")}\\s*=\\s*(?:"[^"]*"|'[^']*')`), ""), attrs);
            // A prefix declared on this element just for these attributes is not needed any more
            for (const prefix of new Set(found.map(({ name }) => name.split(":")[0]!))) {
                if (!new RegExp(`\\s${prefix.replace(/\./g, "\\.")}:`).test(cleaned.replace(/\sxmlns:[\w.-]+\s*=\s*(?:"[^"]*"|'[^']*')/g, ""))) {
                    cleaned = cleaned.replace(new RegExp(`\\sxmlns:${prefix.replace(/\./g, "\\.")}\\s*=\\s*(?:"[^"]*"|'[^']*')`), "");
                }
            }
            const start = m.index!;
            const indent = /[ \t]*$/.exec(opf.slice(0, start))?.[0] ?? "";
            const open = `<${m[1]}${cleaned}${newId}>`;
            edits.push([start, start + m[0].length, `${open}${m[3]}</${m[1]}>${metas.map((meta) => `\n${indent}${meta}`).join("")}`]);
            notes.push(`${m[1]} "${m[3]!.trim()}": ${found.map(({ name }) => `${name}="${attr(attrs, name)}"`).join(", ")} → <meta refines="#${id}">`);
        }
        if (!edits.length) return null;
        const updated = edits.sort((a, b) => b[0] - a[0]).reduce((out, [from, to, text]) => out.slice(0, from) + text + out.slice(to), opf);
        return {
            safe: true, code: "RSC-005",
            title: `Write ${plural(notes.length, "EPUB 2 metadata attribute")} (opf:scheme, opf:role, opf:file-as) in the EPUB 3 form`,
            rationale: "EPUB 3 has no opf:scheme, opf:role or opf:file-as attributes; it states the same as a <meta refines>"
                + " (identifier-type, role, file-as) on the element. The values move there unchanged. BookOrbit's metadata"
                + " write-back writes identifiers with opf:scheme also into EPUB 3 books.",
            changes: notes.map((note) => ({ path: book.opfPath, note })),
            edits: new Map([[book.opfPath, updated]]),
        };
    },
};

// 3. Refinements of an id that does not exist (BookOrbit's write-back replaces element ids and leaves them behind)
const danglingRefines: OwnFix = {
    index: -4, key: "dangling-refines",
    detect(book) {
        if (!book.version.startsWith("3")) return null;
        let opf = book.opf;
        const removed: string[] = [];
        // Removing a meta can leave another one, which refined it, pointing nowhere: repeat until nothing changes
        for (;;) {
            const ids = new Set([...opf.matchAll(/\sid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]!));
            const dangling = [...opf.matchAll(/<((?:[\w.-]+:)?(?:meta|link))\b([^>]*?)(?:\/>|>[^<]*<\/\1\s*>)/g)]
                .filter((m) => attr(m[2]!, "refines")?.startsWith("#") && !ids.has(attr(m[2]!, "refines")!.slice(1)));
            if (!dangling.length) break;
            removed.push(...dangling.map((m) => `${attr(m[2]!, "property") ?? m[1]} of ${attr(m[2]!, "refines")}`));
            opf = removeRanges(opf, dangling.map((m) => [m.index!, m.index! + m[0].length]));
        }
        if (!removed.length) return null;
        return {
            safe: true, code: "RSC-005",
            title: `Remove ${plural(removed.length, "metadata refinement")} of elements that no longer exist (${[...new Set(removed.map((r) => r.replace(/^.* of /, "")))].join(", ")})`,
            rationale: "A <meta refines=\"#id\"> describes the element with that id. No element in this book has it any more,"
                + " so the refinement describes nothing; removing it loses nothing. BookOrbit's metadata write-back gives"
                + " elements new ids and leaves the old refinements behind.",
            changes: removed.map((note) => ({ path: book.opfPath, note: `remove ${note}` })),
            edits: new Map([[book.opfPath, opf]]),
        };
    },
};

// 4. Attributes Amazon's conversion leaves behind (data-AmznRemoved, data-AmznRemoved-M8)
const AMAZON = /\s+data-Amzn[\w-]*\s*=\s*(?:"[^"]*"|'[^']*')/g;

const amazonAttributes: OwnFix = {
    index: -5, key: "amazon-attributes",
    detect(book) {
        // A stylesheet that selects on them would change the look: then they stay
        const styles = [...book.names].filter((name) => /\.css$/i.test(name)).map((name) => book.text(name) ?? "");
        const files = book.contentFiles();
        if ([...styles, ...files.map((f) => (book.text(f) ?? "").match(/<style\b[\s\S]*?<\/style>/gi)?.join("") ?? "")].some((css) => /Amzn/i.test(css))) return null;
        const edits = new Map<string, string>();
        let count = 0;
        for (const name of files) {
            const text = book.text(name);
            const found = text?.match(AMAZON)?.length ?? 0;
            if (!text || !found) continue;
            count += found;
            edits.set(name, text.replace(AMAZON, ""));
        }
        if (!count) return null;
        return {
            safe: true, code: "RSC-005",
            title: `Remove ${plural(count, "leftover Amazon conversion attribute")} (data-AmznRemoved…) from ${plural(edits.size, "file")}`,
            rationale: "Amazon's Kindle conversion marks elements it dropped with data-AmznRemoved attributes. They mean nothing"
                + " outside that conversion, no stylesheet in this book uses them, and their names are invalid in EPUB.",
            changes: [...edits.keys()].map((path) => ({ path, note: "remove data-AmznRemoved… attributes" })),
            edits,
        };
    },
};

// 5. Links to stylesheets that are not in the book
const missingStylesheets: OwnFix = {
    index: -6, key: "missing-stylesheets",
    detect(book) {
        const edits = new Map<string, string>();
        const missing = new Set<string>();
        let count = 0;
        for (const name of book.contentFiles()) {
            const text = book.text(name);
            if (!text) continue;
            const dead = [...text.matchAll(/<link\b([^>]*)\/?>(?:\s*<\/link>)?/gi)].filter((m) => {
                const href = attr(m[1]!, "href");
                if (!href || !/\bstylesheet\b/i.test(attr(m[1]!, "rel") ?? "")) return false;
                const target = book.resolve(name, href);
                return target !== null && !book.names.has(target);
            });
            for (const m of dead) missing.add(attr(m[1]!, "href")!);
            if (!dead.length) continue;
            count += dead.length;
            edits.set(name, removeRanges(text, dead.map((m) => [m.index!, m.index! + m[0].length])));
        }
        if (!count) return null;
        return {
            safe: true, code: "RSC-007",
            title: `Remove ${plural(count, "link")} to stylesheets that are not in the book (${[...missing].slice(0, 3).join(", ")})`,
            rationale: "These documents link a stylesheet the book does not contain. A missing stylesheet styles nothing, so"
                + " removing the links changes nothing in how the book looks.",
            changes: [...edits.keys()].map((path) => ({ path, note: "remove <link rel=\"stylesheet\"> to a missing file" })),
            edits,
        };
    },
};

/**
 * Table-of-contents and page entries of an NCX share one playOrder sequence without gaps. After entries are removed,
 * number the rest 1, 2, 3… in their old order; entries that shared a number keep sharing it.
 */
function renumberPlayOrder(ncx: string): string {
    const PLAY_ORDER = /(\splayOrder\s*=\s*["'])(\d+)(["'])/g;
    const ranks = new Map([...new Set([...ncx.matchAll(PLAY_ORDER)].map((m) => Number(m[2])))].sort((a, b) => a - b).map((n, i) => [n, i + 1]));
    return ncx.replace(PLAY_ORDER, (_, before: string, n: string, after: string) => `${before}${ranks.get(Number(n))}${after}`);
}

// 6. Page-list entries whose page markers are not in the book
const pageLists: OwnFix = {
    index: -7, key: "page-list",
    detect(book) {
        const reaches = (from: string, href: string | undefined) => {
            if (!href) return true;
            const target = book.resolve(from, href);
            if (target === null) return true;
            const fragment = href.includes("#") ? safeDecode(href.slice(href.indexOf("#") + 1)) : "";
            return book.names.has(target) && (!fragment || book.ids(target).has(fragment));
        };
        const edits = new Map<string, string>();
        const notes: { path: string; note: string }[] = [];
        let count = 0;

        for (const name of [...book.names].filter((n) => /\.ncx$/i.test(n))) {
            const ncx = book.text(name);
            const list = ncx && /<((?:[\w.-]+:)?pageList)\b[^>]*>[\s\S]*?<\/\1\s*>/.exec(ncx);
            if (!ncx || !list) continue;
            const targets = [...list[0].matchAll(/<((?:[\w.-]+:)?pageTarget)\b[\s\S]*?<\/\1\s*>/g)];
            const dead = targets.filter((t) => !reaches(name, attr(/<(?:[\w.-]+:)?content\b([^>]*)/.exec(t[0])?.[1] ?? "", "src")));
            if (!dead.length) continue;
            count += dead.length;
            const offset = list.index!;
            edits.set(name, renumberPlayOrder(dead.length === targets.length
                ? removeRanges(ncx, [[offset, offset + list[0].length]])
                : removeRanges(ncx, dead.map((t) => [offset + t.index!, offset + t.index! + t[0].length]))));
            notes.push({ path: name, note: dead.length === targets.length ? `remove the page list (${dead.length} entries)` : `remove ${dead.length} of ${targets.length} page entries` });
        }

        for (const name of book.contentFiles()) {
            const doc = book.text(name);
            const nav = doc && /<((?:[\w.-]+:)?nav)\b[^>]*epub:type\s*=\s*["'][^"']*\bpage-list\b[^"']*["'][^>]*>[\s\S]*?<\/\1\s*>/.exec(doc);
            if (!doc || !nav || /<(?:[\w.-]+:)?ol\b[\s\S]*<(?:[\w.-]+:)?ol\b/.test(nav[0])) continue;
            const items = [...nav[0].matchAll(/<((?:[\w.-]+:)?li)\b[\s\S]*?<\/\1\s*>/g)];
            const dead = items.filter((li) => !reaches(name, attr(/<(?:[\w.-]+:)?a\b([^>]*)/.exec(li[0])?.[1] ?? "", "href")));
            if (!dead.length) continue;
            count += dead.length;
            const offset = nav.index!;
            edits.set(name, dead.length === items.length
                ? removeRanges(doc, [[offset, offset + nav[0].length]])
                : removeRanges(doc, dead.map((li) => [offset + li.index!, offset + li.index! + li[0].length])));
            notes.push({ path: name, note: dead.length === items.length ? `remove the page-list nav (${dead.length} entries)` : `remove ${dead.length} of ${items.length} page-list entries` });
        }
        if (!count) return null;
        return {
            safe: true, code: "RSC-012",
            title: `Remove ${plural(count, "page-list entry", "page-list entries")} whose page markers are not in the book`,
            rationale: "A page list maps the print edition's page numbers to markers in the text. These markers are gone (often"
                + " dropped by an earlier conversion), so the entries lead nowhere; removing them loses nothing a reader could use.",
            changes: notes,
            edits,
        };
    },
};

// 7. An empty <guide>, which EPUB 2 does not allow
const emptyGuide: OwnFix = {
    index: -8, key: "empty-guide",
    detect(book) {
        const guide = /<((?:[\w.-]+:)?guide)\b[^>]*?(?:\/>|>\s*<\/\1\s*>)/.exec(book.opf);
        if (!guide) return null;
        return {
            safe: true, code: "RSC-005",
            title: "Remove the empty <guide>",
            rationale: "A <guide> must list at least one reference. This one lists none, so it says nothing; removing it loses nothing.",
            changes: [{ path: book.opfPath, note: "remove <guide/>" }],
            edits: new Map([[book.opfPath, removeRanges(book.opf, [[guide.index, guide.index + guide[0].length]])]]),
        };
    },
};

// The series metas BookOrbit's write-back puts into EPUB 2 books (series.ts)
const series: OwnFix = {
    index: -1, key: "bookorbit-series",
    detect(book) {
        const found = analyzeSeries(book.opf, book.opfPath);
        if (!found) return null;
        const { plan } = found;
        return {
            safe: plan.safe, code: "RSC-005", title: plan.title, rationale: plan.rationale,
            changes: plan.changes.map((note) => ({ path: plan.opfPath, note })),
            edits: new Map([[book.opfPath, found.apply()]]),
        };
    },
};

export const OWN_FIXES: OwnFix[] = [series, modified, epub2Attributes, danglingRefines, amazonAttributes, missingStylesheets, pageLists, emptyGuide];

/** Apply one fix to a book, which may carry other repairs already. Null if the fix finds nothing to do there. */
export function applyOwnFix(fix: OwnFix, bytes: Uint8Array): Uint8Array | null {
    const book = Book.load(bytes);
    const found = book && fix.detect(book);
    return found ? book.write(found.edits) : null;
}
