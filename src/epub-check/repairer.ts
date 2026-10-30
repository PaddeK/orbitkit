import wasmPath from "@veripublica/epubsana-wasm/epubsana_wasm_bg.wasm" with { type: "file" };
import * as bindings from "@veripublica/epubsana-wasm/epubsana_wasm_bg.js";
import type { Report, Session } from "@veripublica/epubsana-wasm";
import type { Epublift } from "./epublift.ts";
import { applyOwnFix, Book, OWN_FIXES } from "./fixes.ts";
import { validateEpub, type CheckResult, type Counts, type Finding } from "./validator.ts";
import { loadWasm } from "./wasm.ts";

await loadWasm(wasmPath, bindings);

/** epubsana's version. A new version checks every book again, since it may fix more. */
export const epubsanaVersion: string = bindings.version();

/** Index of orbitkit's fix for BookOrbit's series metas; epubsana's fixes count from 0, orbitkit's below 0 */
export const SERIES_FIX = -1;
/** Index of the upgrade to EPUB 3 with epublift */
export const EPUBLIFT_FIX = -9;

export interface RepairOptions {
    /** Offer orbitkit's own fixes (EPUB_CHECK_FIXES) */
    ownFixes?: boolean;
    /** Offer the upgrade to EPUB 3 (EPUB_CHECK_EPUBLIFT) */
    epublift?: Epublift;
}

/** A fix proposed for one book. */
export interface ProposedFix {
    /** Handle in the book's plan: epubsana's 0-based index, or a negative one for orbitkit's fixes and epublift */
    index: number;
    source: "epubsana" | "orbitkit" | "epublift";
    /** Safe to apply without asking (epubsana's "AutoSafe"); otherwise a visible change someone has to approve */
    safe: boolean;
    /** epubcheck-compatible code of the finding it fixes */
    code: string;
    severity: string;
    title: string;
    rationale: string;
    changes: { path: string; note: string }[];
}

export interface FixOutcome {
    outcome: "applied" | "skipped" | "reverted";
    /** For a reverted fix: why it was undone */
    because?: string;
}

export interface RepairResult {
    before: Counts;
    after: Counts;
    /** By fix index */
    outcomes: Record<number, FixOutcome>;
    /** Findings that were always in the book, but only visible once a fix let the validator read a part of it */
    revealed: number;
}

/** What can be done for a book: every fix proposed, and the result of applying just the safe ones. */
export interface RepairPlan {
    fixes: ProposedFix[];
    safe: RepairResult;
}

/** Identifies a plan, so a selection made on a report page is only applied to the same plan. */
export function planId(fixes: ProposedFix[]): string {
    return Bun.hash(JSON.stringify(fixes.map((f) => [f.index, f.code, f.title]))).toString(36);
}

function open(bytes: Uint8Array): Session | null {
    try {
        return bindings.Session.load(bytes);
    } catch {
        // epubsana could not read the book at all; the validator's findings already say why
        return null;
    }
}

function epubsanaFixes(session: Session): ProposedFix[] {
    return session.plan().fixes.map((fix) => ({
        index: fix.index,
        source: "epubsana" as const,
        safe: fix.tier === "AutoSafe",
        code: fix.id,
        severity: fix.severity,
        title: fix.title,
        rationale: fix.rationale,
        changes: fix.preview.map(({ path, note }) => ({ path, note })),
    }));
}

function resultOf(session: Session, report: Report): RepairResult {
    const s = report.summary;
    // The report's index is 1-based; the plan's fixes carry why one was reverted
    const fixes = session.plan().fixes;
    return {
        before: { fatal: s.fatals_before, error: s.errors_before, warning: s.warnings_before },
        after: { fatal: s.fatals_after, error: s.errors_after, warning: s.warnings_after },
        outcomes: Object.fromEntries(report.items.map((item) => [
            item.data.index - 1,
            { outcome: item.outcome as FixOutcome["outcome"], because: fixes[item.data.index - 1]?.reverted_for },
        ])),
        revealed: session.revealed(),
    };
}

const errorCount = (counts: Counts) => counts.fatal + counts.error;

function errorsByCode(check: CheckResult): Map<string, number> {
    const counts = new Map<string, number>();
    for (const f of check.findings) {
        if (f.severity === "fatal" || f.severity === "error") counts.set(f.code, (counts.get(f.code) ?? 0) + 1);
    }
    return counts;
}

/**
 * Whether a change made the book better: fewer errors, and no kind of error more frequent. Like epubsana does with
 * its own fixes, orbitkit undoes one of its fixes otherwise. Null if it is better, else why not.
 */
export function worseBecause(before: CheckResult, after: CheckResult): string | null {
    const beforeCodes = errorsByCode(before);
    const worse = [...errorsByCode(after)].find(([code, n]) => n > (beforeCodes.get(code) ?? 0));
    if (worse) return `made ${worse[0]} more frequent`;
    if (errorCount(after.counts) >= errorCount(before.counts)) return "removed no error";
    return null;
}

/**
 * Upgrade with epublift, then apply orbitkit's own fixes again to the upgraded book (with EPUB_CHECK_FIXES): some
 * leftovers only become fixable errors in EPUB 3, such as Amazon's data-AmznRemoved attributes. Each of those fixes is
 * kept only if it makes the upgraded book better.
 */
async function liftAndTidy(bytes: Uint8Array, options: RepairOptions): Promise<Uint8Array | null> {
    let out = await options.epublift!.lift(bytes);
    if (!out || !options.ownFixes) return out;
    let current = validateEpub(out);
    for (const fix of OWN_FIXES) {
        const fixed = applyOwnFix(fix, out);
        if (!fixed) continue;
        const next = validateEpub(fixed);
        if (worseBecause(current, next)) continue;
        out = fixed;
        current = next;
    }
    return out;
}

/** The epublift upgrade, if the book is EPUB 2 and the upgrade makes it better; else why not, for the log. */
async function liftFix(bytes: Uint8Array, book: Book | null, options: RepairOptions): Promise<ProposedFix | string> {
    const epublift = options.epublift!;
    if (!book?.version.startsWith("2")) return "not an EPUB 2 book";
    const lifted = await liftAndTidy(bytes, options);
    if (!lifted) return "epublift failed on it";
    const before = validateEpub(bytes);
    const after = validateEpub(lifted);
    const because = worseBecause(before, after);
    if (because) return `the upgrade ${because}`;
    return {
        index: EPUBLIFT_FIX, source: "epublift", safe: false, code: "RSC-005", severity: "error",
        title: "Upgrade the book from EPUB 2 to EPUB 3 with epublift",
        rationale: "This EPUB 2 book contains markup only EPUB 3 allows (such as epub:type, role, <section> or <nav>), which"
            + ` is how conversions of Kindle and newer books often turn out. Upgrading it makes that markup valid; on this book alone, errors ${errorCount(before.counts)} → ${errorCount(after.counts)}.`
            + " epublift keeps the EPUB 2 table of contents for older readers. It changes the book's format version, so it is yours to confirm.",
        changes: [
            { path: book.opfPath, note: `package version ${book.version} → 3.0, a navigation document added, documents declared as HTML5 (epublift ${epublift.version})` },
            ...(options.ownFixes ? [{ path: book.opfPath, note: "then orbitkit's own fixes again, where the upgraded book needs them" }] : []),
        ],
    };
}

async function plan(bytes: Uint8Array, options: RepairOptions, session: Session | null): Promise<ProposedFix[]> {
    const book = options.ownFixes || options.epublift ? Book.load(bytes) : null;
    const own = options.ownFixes && book
        ? OWN_FIXES.flatMap((fix): ProposedFix[] => {
            const found = fix.detect(book);
            return found ? [{ index: fix.index, source: "orbitkit", safe: found.safe, code: found.code, severity: "error", title: found.title, rationale: found.rationale, changes: found.changes }] : [];
        })
        : [];
    const lift = options.epublift ? await liftFix(bytes, book, options) : null;
    return [...own, ...(lift && typeof lift !== "string" ? [lift] : []), ...(session ? epubsanaFixes(session) : [])];
}

/**
 * Apply the approved fixes: epubsana's on the book as loaded (its plan's indices refer to it), then orbitkit's own
 * one by one on the result, then the epublift upgrade. Each of orbitkit's steps is undone unless it makes the book
 * better (see worseBecause).
 */
async function run(bytes: Uint8Array, session: Session | null, fixes: ProposedFix[], approved: number[], options: RepairOptions) {
    const has = (index: number) => fixes.some((f) => f.index === index);
    const fromEpubsana = approved.filter((index) => fixes.some((f) => f.source === "epubsana" && f.index === index));
    let result: RepairResult;
    let out = bytes;
    if (session) {
        result = resultOf(session, session.repair(Uint32Array.from(fromEpubsana), "valid"));
        if (fromEpubsana.length) out = session.result_bytes();
    } else {
        const { counts } = validateEpub(bytes);
        result = { before: counts, after: counts, outcomes: {}, revealed: 0 };
    }

    let current: CheckResult | null = null;
    const step = async (index: number, change: (book: Uint8Array) => Promise<Uint8Array | null> | Uint8Array | null) => {
        if (!has(index)) return;
        if (!approved.includes(index)) {
            result.outcomes[index] = { outcome: "skipped" };
            return;
        }
        const changed = await change(out);
        if (!changed) {
            result.outcomes[index] = { outcome: "reverted", because: "found nothing to do after the other fixes" };
            return;
        }
        current ??= validateEpub(out);
        const next = validateEpub(changed);
        const because = worseBecause(current, next);
        if (because) {
            result.outcomes[index] = { outcome: "reverted", because };
            return;
        }
        out = changed;
        current = next;
        result.outcomes[index] = { outcome: "applied" };
    };
    for (const fix of OWN_FIXES) await step(fix.index, (book) => applyOwnFix(fix, book));
    if (options.epublift) await step(EPUBLIFT_FIX, (book) => liftAndTidy(book, options));
    if (current) result.after = (current as CheckResult).counts;
    return { result, bytes: out };
}

/** Plan the repair of a book and try the safe fixes, all in memory. Null if nothing is proposed. */
export async function planRepair(bytes: Uint8Array, options: RepairOptions = {}): Promise<RepairPlan | null> {
    const session = open(bytes);
    try {
        const fixes = await plan(bytes, options, session);
        if (!fixes.length) return null;
        return { fixes, safe: (await run(bytes, session, fixes, fixes.filter((f) => f.safe).map((f) => f.index), options)).result };
    } finally {
        session?.free();
    }
}

/** Apply the chosen fixes. Returns the plan, the repaired book, what happened to each fix, and the findings that remain. */
export async function repair(bytes: Uint8Array, approved: number[], options: RepairOptions = {}):
    Promise<{ plan: ProposedFix[]; result: RepairResult; bytes: Uint8Array; remaining: Finding[] } | null> {
    const session = open(bytes);
    try {
        const fixes = await plan(bytes, options, session);
        if (!fixes.length) return null;
        const { result, bytes: repaired } = await run(bytes, session, fixes, approved, options);
        return { plan: fixes, result, bytes: repaired, remaining: validateEpub(repaired).findings };
    } finally {
        session?.free();
    }
}

/** Why a book is not offered the epublift upgrade, or null if it is; for checking a library by hand. */
export async function whyNoLift(bytes: Uint8Array, options: RepairOptions): Promise<string | null> {
    if (!options.epublift) return "EPUB_CHECK_EPUBLIFT is off";
    const found = await liftFix(bytes, Book.load(bytes), options);
    return typeof found === "string" ? found : null;
}
