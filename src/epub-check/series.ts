import { readEntry, replaceEntry, ZipError } from "./zip.ts";

/**
 * Repair for a BookOrbit bug: its metadata write-back puts EPUB 3 series metas into EPUB 2 packages,
 *
 *   <meta id="series-col" property="belongs-to-collection">Moby Dick</meta>
 *   <meta refines="#series-col" property="collection-type">series</meta>
 *   <meta refines="#series-col" property="group-position">1</meta>
 *
 * which OPF 2.0 does not allow (RSC-005). BookOrbit writes the same series as calibre:series and calibre:series_index
 * next to them, so when those match, dropping the EPUB 3 metas loses nothing: safe. Otherwise the series has to be
 * moved into calibre metas, or one of two different series dropped: a choice to confirm.
 */

export interface SeriesFixPlan {
    /** Safe: the calibre metas already say the same */
    safe: boolean;
    title: string;
    rationale: string;
    opfPath: string;
    changes: string[];
}

interface Meta {
    start: number;
    end: number;
    tag: string;
    attrs: string;
    text?: string;
}

const META = /<((?:[\w.-]+:)?meta)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;

function attr(attrs: string, name: string): string | undefined {
    const match = new RegExp(`\\s${name.replace(/[.:]/g, "\\$&")}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
    return match ? unescapeXml(match[1] ?? match[2]!) : undefined;
}

export function unescapeXml(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
        const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
        if (code[0] !== "#") return named[code.toLowerCase()] ?? entity;
        const point = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(point) ? String.fromCodePoint(point) : entity;
    });
}

const escapeXml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Same series position, written differently ("1" and "1.0") */
const samePosition = (a: string | undefined, b: string | undefined) =>
    a !== undefined && b !== undefined && (a.trim() === b.trim() || (Number(a) === Number(b) && !Number.isNaN(Number(a))));

/** Remove a range together with the indentation and line break before it, so no blank line is left. */
function removalRange(opf: string, meta: Meta): [number, number] {
    let start = meta.start;
    while (start > 0 && (opf[start - 1] === " " || opf[start - 1] === "\t")) start--;
    if (opf[start - 1] === "\n") start--;
    if (opf[start - 1] === "\r") start--;
    return [start, meta.end];
}

export function opfPathOf(epub: Uint8Array): string | null {
    const container = readEntry(epub, "META-INF/container.xml")?.toString("utf8");
    return container ? /<(?:[\w.-]+:)?rootfile\b[^>]*\sfull-path\s*=\s*["']([^"']+)["']/.exec(container)?.[1] ?? null : null;
}

/** Plan and apply in one place, so a fix is applied exactly as planned. Null if there is nothing to repair. */
export function analyzeSeries(opf: string, opfPath: string): { plan: SeriesFixPlan; apply: () => string } | null {
    const version = /<(?:[\w.-]+:)?package\b[^>]*\sversion\s*=\s*["']([^"']*)["']/.exec(opf)?.[1];
    if (!version?.startsWith("2")) return null;

    const metas: Meta[] = [...opf.matchAll(META)].map((m) => ({
        start: m.index, end: m.index + m[0].length, tag: m[1]!, attrs: m[2]!, text: m[3],
    }));
    const collections = metas.filter((m) => attr(m.attrs, "property") === "belongs-to-collection");
    // BookOrbit writes one; anything else is not this bug
    if (collections.length !== 1) return null;
    const collection = collections[0]!;
    const id = attr(collection.attrs, "id");
    const refines = id ? metas.filter((m) => attr(m.attrs, "refines") === `#${id}`) : [];
    const refined = (property: string) => {
        const meta = refines.find((m) => attr(m.attrs, "property") === property);
        return meta?.text !== undefined ? unescapeXml(meta.text).trim() : undefined;
    };
    const type = refined("collection-type");
    if (type !== undefined && type !== "series") return null;

    const name = unescapeXml(collection.text ?? "").trim();
    const position = refined("group-position");
    const calibre = (key: string) => metas.find((m) => attr(m.attrs, "name") === key);
    const calibreSeries = calibre("calibre:series");
    const calibreIndex = calibre("calibre:series_index");
    const calibreName = calibreSeries ? attr(calibreSeries.attrs, "content")?.trim() : undefined;
    const calibrePosition = calibreIndex ? attr(calibreIndex.attrs, "content")?.trim() : undefined;
    if (!name) return null;

    const label = (series: string, at?: string) => `"${series}"${at !== undefined ? ` #${at}` : ""}`;
    const dropped = `remove the EPUB 3 series metas (belongs-to-collection ${label(name, position)}${refines.length ? ` and ${refines.length} refining meta(s)` : ""})`;
    const removals = [collection, ...refines];
    const remove = (text: string, extra: [number, number, string][] = []) => {
        const edits: [number, number, string][] = [...removals.map((m) => [...removalRange(text, m), ""] as [number, number, string]), ...extra];
        return edits.sort((a, b) => b[0] - a[0]).reduce((out, [from, to, insert]) => out.slice(0, from) + insert + out.slice(to), text);
    };
    const why = "OPF 2.0 has no property or refines attributes on <meta>; a series there is written as calibre:series and"
        + " calibre:series_index. BookOrbit's write-back adds the EPUB 3 form to EPUB 2 books as well, which makes them invalid.";

    if (calibreName === name && (position === undefined || samePosition(position, calibrePosition))) {
        return {
            plan: {
                safe: true, opfPath,
                title: `Remove BookOrbit's EPUB 3 series metas from the EPUB 2 package; the series ${label(name, position)} stays as calibre:series`,
                rationale: `${why} This book carries the same series in its calibre metas, so nothing is lost.`,
                changes: [dropped],
            },
            apply: () => remove(opf),
        };
    }

    if (calibreName === undefined) {
        // Write the series where the EPUB 3 metas stood, in the form OPF 2.0 has for it
        const indent = /[ \t]*$/.exec(opf.slice(0, collection.start))?.[0] ?? "";
        const lines = [`<${collection.tag} name="calibre:series" content="${escapeXml(name)}"/>`];
        if (position !== undefined && calibrePosition === undefined) lines.push(`<${collection.tag} name="calibre:series_index" content="${escapeXml(position)}"/>`);
        return {
            plan: {
                safe: false, opfPath,
                title: `Move the series ${label(name, position)} from BookOrbit's EPUB 3 metas to calibre:series`,
                rationale: `${why} This book has no calibre series, so the series is written as calibre:series instead of being dropped.`,
                changes: [dropped, `add ${lines.map((l) => l.replace(/^<[\w.:-]+ /, "<meta ")).join(" and ")}`],
            },
            apply: () => remove(opf, [[collection.end, collection.end, `\n${indent}${lines.join(`\n${indent}`)}`]]),
        };
    }

    const kept = label(calibreName, calibrePosition);
    return {
        plan: {
            safe: false, opfPath,
            title: `Remove BookOrbit's EPUB 3 series ${label(name, position)} from the EPUB 2 package; the calibre series ${kept} stays`,
            rationale: `${why} The calibre metas of this book name a different series or position (${kept}), so removing`
                + ` the EPUB 3 form drops ${label(name, position)}. Check which one is right before you approve this.`,
            changes: [dropped],
        },
        apply: () => remove(opf),
    };
}

function load(epub: Uint8Array): { opf: string; opfPath: string } | null {
    try {
        const opfPath = opfPathOf(epub);
        const bytes = opfPath ? readEntry(epub, opfPath) : null;
        if (!opfPath || !bytes) return null;
        // Keep a byte order mark, so an untouched OPF is written back as it was
        return { opf: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), opfPath };
    } catch (err) {
        // Not a ZIP we can read, or an OPF that is not UTF-8: not ours to repair
        if (err instanceof ZipError || err instanceof TypeError || err instanceof RangeError) return null;
        throw err;
    }
}

export function planSeriesFix(epub: Uint8Array): SeriesFixPlan | null {
    const book = load(epub);
    return book ? analyzeSeries(book.opf, book.opfPath)?.plan ?? null : null;
}

/** Apply the fix to a book, which may already carry other repairs. Null if there is nothing to repair. */
export function applySeriesFix(epub: Uint8Array): Uint8Array | null {
    const book = load(epub);
    const fix = book && analyzeSeries(book.opf, book.opfPath);
    return fix ? replaceEntry(epub, book.opfPath, new TextEncoder().encode(fix.apply())) : null;
}
