import type { BookOrbit } from "../bookorbit.ts";
import type { Handler, Login } from "../login.ts";
import { describe, reportPath, summarize, type Checker, type FileReport } from "./check.ts";
import type { Config } from "./config.ts";
import { HttpError, TooLargeError } from "../http.ts";
import { log } from "./log.ts";
import { ReplaceError, type Job, type Replacer } from "./replace.ts";
import { epubsanaVersion, planId, repair, type FixOutcome, type ProposedFix, type RepairOptions, type RepairResult } from "./repairer.ts";
import type { FileState, State } from "./state.ts";
import { epubTitle, Uploads } from "./upload.ts";
import { epubveriVersion, validateEpub, type Counts, type Finding, type Severity } from "./validator.ts";

const SEVERITY_ORDER: Severity[] = ["fatal", "error", "warning", "info", "usage"];
const STATUS_ORDER = ["fatal", "errors", "warnings", "not checked", "valid"];

const escape = (text: string) =>
    text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function time(ms: number | undefined): string {
    if (!ms) return "never";
    const date = new Date(ms);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16).replace("T", " ");
}

function size(bytes: number | null): string {
    if (bytes === null) return "unknown size";
    return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
:root { color-scheme: light dark; --muted: #6b7280; --line: #d1d5db40; --fatal: #b91c1c; --error: #dc2626; --warning: #b45309; --valid: #15803d; --safe: #15803d; --confirm: #1d4ed8; }
body { font: 15px/1.5 system-ui, sans-serif; max-width: 1100px; margin: 0 auto; padding: 1.5rem; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; } h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; } h3 { font-size: 1rem; margin: 1.5rem 0 .5rem; }
.muted { color: var(--muted); } a { color: inherit; }
table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; } td.num { text-align: right; font-variant-numeric: tabular-nums; }
code { font-size: .9em; } .loc { word-break: break-all; } .nowrap { white-space: nowrap; }
.badge { display: inline-block; padding: 0 .5rem; border-radius: 999px; font-size: .85em; font-weight: 600; color: #fff; background: var(--muted); white-space: nowrap; }
.fatal { background: var(--fatal); } .error, .errors { background: var(--error); } .warning, .warnings { background: var(--warning); } .valid, .applied { background: var(--valid); }
.safe { background: var(--safe); } .confirm { background: var(--confirm); } .reverted { background: var(--error); } .own { background: #7c3aed; } .lift { background: #0f766e; }
.chips { display: flex; flex-wrap: wrap; gap: .5rem; margin: 1rem 0; }
details { margin-top: .25rem; } details ul { margin: .25rem 0; padding-left: 1.25rem; }
.actions { display: flex; gap: .75rem; margin: 1rem 0; } button { font: inherit; padding: .4rem .9rem; border-radius: .4rem; border: 1px solid var(--muted); cursor: pointer; }
button.primary { background: var(--confirm); color: #fff; border-color: var(--confirm); }
input:not([type]), input[type=password] { font: inherit; padding: .3rem .5rem; width: min(20rem, 100%); }
</style>
</head>
<body>
${body}
</body>
</html>`;

const badge = (label: string, kind = label) => `<span class="badge ${escape(kind)}">${escape(label)}</span>`;
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const errorPage = (status: number, message: string, back = "../") => html(page("orbitkit", `<p>${escape(message)}</p><p><a href="${back}">Back</a></p>`), status);

function sortFindings(findings: Finding[]): Finding[] {
    return [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

function findingsTable(findings: Finding[]): string {
    return `<table>
<tr><th>Severity</th><th>Code</th><th>Where</th><th>Message</th></tr>
${sortFindings(findings).map((f) => `<tr>
<td>${badge(f.severity)}</td><td class="nowrap"><code>${escape(f.code)}</code></td>
<td class="loc">${f.location ? `<code>${escape(f.location)}${f.line ? `:${f.line}${f.column ? `:${f.column}` : ""}` : ""}</code>` : ""}</td>
<td>${escape(f.message)}</td>
</tr>`).join("\n")}
</table>`;
}

const errorCount = (counts: Counts) => counts.fatal + counts.error;

function delta(result: RepairResult): string {
    const errors = `errors ${errorCount(result.before)} → ${errorCount(result.after)}`;
    const warnings = result.before.warning || result.after.warning ? `, warnings ${result.before.warning} → ${result.after.warning}` : "";
    return errors + warnings;
}

/** The fixes of a plan as a form: checked ones are applied. With outcomes, also what became of each. */
function fixForm(fixes: ProposedFix[], selected: Set<number>, action: string, outcomes: Record<number, FixOutcome> | undefined, replace: boolean): string {
    const rows = fixes.map((fix) => {
        const outcome = outcomes?.[fix.index];
        return `<tr>
<td><input type="checkbox" name="fix" value="${fix.index}" id="fix-${fix.index}"${selected.has(fix.index) ? " checked" : ""}></td>
<td>${fix.safe ? badge("safe") : badge("confirm")}${fix.source === "epubsana" ? "" : `<br>${badge(fix.source, fix.source === "orbitkit" ? "own" : "lift")}`}</td>
<td class="nowrap"><code>${escape(fix.code)}</code></td>
<td><label for="fix-${fix.index}">${escape(fix.title)}</label>
${outcome && outcome.outcome !== "skipped" ? `<br>${badge(outcome.outcome)}${outcome.because ? ` <span class="muted">${escape(undoneBecause(fix, outcome.because))}</span>` : ""}` : ""}
<details><summary class="muted">Why, and what changes</summary><p>${escape(fix.rationale)}</p>
<ul>${fix.changes.map((c) => `<li><code>${escape(c.path)}</code>: ${escape(c.note)}</li>`).join("")}</ul></details></td>
</tr>`;
    });
    return `<form method="post" action="${escape(action)}">
<input type="hidden" name="plan" value="${planId(fixes)}">
<table>
<tr><th></th><th>Kind</th><th>Code</th><th>Fix</th></tr>
${rows.join("\n")}
</table>
<div class="actions">
<button type="submit" name="action" value="preview">Check selection</button>
<button type="submit" name="action" value="download" class="primary">Download repaired EPUB</button>
${replace ? `<button type="submit" name="action" value="replace" onclick="return confirm('Replace this book in BookOrbit with the repaired version? orbitkit keeps the original as a backup.')">Replace in BookOrbit</button>` : ""}
</div>
</form>`;
}

/** epubsana says which finding a reverted fix made more frequent; orbitkit's own fix says why itself */
function undoneBecause(fix: ProposedFix, because: string): string {
    return fix.source === "epubsana" ? `made ${because} more frequent, so epubsana undid it` : `undone: it ${because}`;
}

interface BookRow {
    id: string;
    title: string;
    authors: string[];
    status: string;
    errors: number | null;
    warnings: number | null;
    /** Fixes epubsana proposes, and errors left after the safe ones */
    fixes: number;
    errorsAfterSafeFixes: number | null;
}

function bookRows(state: State): BookRow[] {
    const filesByBook = new Map<string, FileState[]>();
    for (const file of Object.values(state.data.files)) {
        const key = String(file.bookId);
        filesByBook.set(key, [...(filesByBook.get(key) ?? []), file]);
    }
    return Object.entries(state.data.books)
        .filter(([id]) => filesByBook.has(id))
        .map(([id, book]) => {
            const files = filesByBook.get(id)!;
            const checked = files.filter((f) => f.counts);
            return {
                id, title: book.title || `Book ${id}`, authors: book.authors, ...summarize(files),
                fixes: files.reduce((sum, f) => sum + (f.repair?.fixes ?? 0), 0),
                errorsAfterSafeFixes: checked.length
                    ? checked.reduce((sum, f) => sum + (f.repair ? f.repair.errorsAfterSafeFixes : errorCount(f.counts!)), 0)
                    : null,
            };
        });
}

/** `signedIn`: the user name, for users signed in on orbitkit's login page (who sign out here rather than in BookOrbit) */
export function renderIndex(config: Config, state: State, showAll: boolean, replacer?: Replacer, signedIn?: string): string {
    const rows = bookRows(state).sort((a, b) =>
        STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
        || (b.errors ?? 0) - (a.errors ?? 0)
        || (b.warnings ?? 0) - (a.warnings ?? 0)
        || a.title.localeCompare(b.title));
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
    const shown = showAll ? rows : rows.filter((row) => row.status !== "valid");
    const hidden = rows.length - shown.length;

    const repairCell = (row: BookRow) => {
        if (!row.fixes) return "";
        const safe = row.errors !== null && row.errorsAfterSafeFixes !== null && row.errorsAfterSafeFixes < row.errors
            ? `errors ${row.errors} → ${row.errorsAfterSafeFixes} with safe fixes<br>` : "";
        return `${safe}<span class="muted">${row.fixes} fix${row.fixes === 1 ? "" : "es"} proposed</span>`;
    };
    const table = shown.length
        ? `<table>
<tr><th>Book</th><th>Status</th><th class="num">Errors</th><th class="num">Warnings</th><th>Repair</th><th></th></tr>
${shown.map((row) => `<tr>
<td><a href="books/${row.id}">${escape(row.title)}</a><br><span class="muted">${escape(row.authors.join(", "))}</span></td>
<td>${badge(row.status)}</td><td class="num">${row.errors ?? ""}</td><td class="num">${row.warnings ?? ""}</td>
<td>${repairCell(row)}</td>
<td><a href="${escape(`${config.bookorbitPublicUrl}/book/${row.id}`)}">BookOrbit</a></td>
</tr>`).join("\n")}
</table>`
        : `<p>${rows.length ? "Every EPUB is valid." : "No EPUBs checked yet."}</p>`;

    return page("orbitkit", `<h1>EPUB Check</h1>
<p class="muted">${rows.length} book(s) in ${escape(new URL(config.bookorbitPublicUrl).host)}, checked with epubveri ${escape(epubveriVersion)};
repairs proposed by epubsana ${escape(epubsanaVersion)}${config.ownFixes ? " and orbitkit's own fixes" : ""}${config.epublift ? ", upgrades by epublift" : ""}. Last complete run: ${time(state.data.lastSuccess)}.</p>
<div class="chips">${STATUS_ORDER.filter((s) => counts.get(s)).map((s) => `${badge(s)} ${counts.get(s)}`).join(" &nbsp; ")}</div>
${replaceAllLink(replacer)}
${table}
${hidden ? `<p class="muted">${hidden} valid book(s) not listed. <a href="?all">Show all</a></p>` : ""}
${signedIn ? `<form method="post" action="logout" class="muted">Signed in as ${escape(signedIn)} <button type="submit">Sign out</button></form>` : ""}`);
}

function replaceAllLink(replacer?: Replacer): string {
    if (!replacer) return "";
    if (replacer.job && !replacer.job.finishedAt) return `<p><a href="replace-safe">Replacing books with their safe fixes…</a></p>`;
    const count = replacer.candidates().length;
    return count ? `<p><a href="replace-safe">Replace ${count} book${count === 1 ? "" : "s"} in BookOrbit with their safe fixes…</a></p>` : "";
}

/** Before anything was chosen, only a safe fix that had to be undone is worth a mark. */
function revertedOnly(outcomes: Record<number, FixOutcome>): Record<number, FixOutcome> {
    return Object.fromEntries(Object.entries(outcomes).filter(([, o]) => o.outcome === "reverted"));
}

function repairSection(report: FileReport, action: string, replace: boolean): string {
    if (!report.repair) {
        return report.findings.some((f) => ["fatal", "error", "warning"].includes(f.severity))
            ? `<p class="muted">No fix is known for these findings.</p>` : "";
    }
    const { fixes, safe } = report.repair;
    const confirm = fixes.filter((f) => !f.safe).length;
    const safeCount = fixes.length - confirm;
    return `<h3>Repair</h3>
<p>${safeCount ? `The ${safeCount} safe fix${safeCount === 1 ? "" : "es"} alone: ${delta(safe)}.` : "No fix is safe to apply without asking."}
${confirm ? `${confirm} more need${confirm === 1 ? "s" : ""} your confirmation: tick ${confirm === 1 ? "it" : "them"} to include ${confirm === 1 ? "it" : "them"}.` : ""}
<span class="muted">Check your selection to see the result, or download the repaired book.${replace
        ? " <em>Replace in BookOrbit</em> puts it in place of the book in your library, keeping the original as a backup."
        : " Your book in BookOrbit stays as it is."}</span></p>
${fixForm(fixes, new Set(fixes.filter((f) => f.safe).map((f) => f.index)), action, revertedOnly(safe.outcomes), replace)}`;
}

export async function renderBook(config: Config, state: State, bookId: string, replace = false): Promise<string | null> {
    const book = state.data.books[bookId];
    const files = Object.entries(state.data.files).filter(([, file]) => String(file.bookId) === bookId);
    if (!book || !files.length) return null;
    const title = book.title || `Book ${bookId}`;

    const sections = await Promise.all(files.map(async ([fileId, file]) => {
        const heading = `<h2>File ${escape(fileId)} <span class="muted">· ${size(file.size)} · checked ${time(file.checkedAt)}</span></h2>`;
        const own = replace ? uploadSection(`${bookId}/files/${fileId}`) : "";
        if (!file.counts) return `${heading}<p>Not checked: ${escape(file.problem ?? "unknown reason")}.</p>${own}`;
        const report = (await Bun.file(reportPath(config.dataDir, fileId)).json().catch(() => null)) as FileReport | null;
        if (!report) return `${heading}<p>${escape(describe(file.counts))}. The detailed report is missing; it is written again on the next check.</p>${own}`;
        if (!report.findings.length) return `${heading}<p>${badge("valid")} No problems found.</p>${own}`;
        return `${heading}
<p>${escape(describe(file.counts))} <span class="muted">(epubveri ${escape(report.epubveri)})</span></p>
${findingsTable(report.findings)}
${repairSection(report, `${bookId}/files/${fileId}/repair`, replace)}
${own}`;
    }));

    return page(`${title} · orbitkit`, `<p><a href="../">← All books</a></p>
<h1>${escape(title)}</h1>
<p class="muted">${escape(book.authors.join(", "))} · <a href="${escape(`${config.bookorbitPublicUrl}/book/${bookId}`)}">Open in BookOrbit</a></p>
${sections.join("\n")}
<p class="muted">Codes follow epubcheck's message IDs. epubveri only reads books; fixes change only the copy you download${replace ? ", or the book in your library when you replace it" : ""}.
Fixes marked ${badge("orbitkit", "own")} are orbitkit's own and ${badge("epublift", "lift")} is epublift's upgrade; the others are epubsana's.</p>`);
}

/** Fixing a book by hand: download it, repair it in Sigil or Calibre, upload it to check it and put it in place. */
function uploadSection(base: string): string {
    return `<h3>Your own fixed version</h3>
<p class="muted">Fix the book yourself, for example in Sigil or calibre: <a href="${escape(base)}/original">download the current file</a>,
repair it, and upload it here. orbitkit checks it first and shows what it fixes; only then can you put it in place of the book in BookOrbit.</p>
<form method="post" action="${escape(base)}/upload" enctype="multipart/form-data"><div class="actions">
<input type="file" name="epub" accept=".epub,application/epub+zip" required>
<button type="submit">Check upload</button>
</div></form>`;
}

/** `Content-Disposition` for a download, with an ASCII fallback for old clients. */
function attachment(filename: string): string {
    // Accents dropped (ä → a), anything else non-ASCII (dashes, CJK) becomes "-"
    const ascii = filename.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\x20-\x7e]/g, "-").replace(/["\\]/g, "") || "book_fixed.epub";
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Repair a file with the fixes ticked on its report page, then show the result or send the repaired book. */
async function handleRepair(req: Request, params: { id: string; fileId: string }, config: Config, state: State, bookorbit: BookOrbit, options: RepairOptions, replacer?: Replacer) {
    const back = `../../../${encodeURIComponent(params.id)}`;
    const file = state.data.files[params.fileId];
    const book = state.data.books[params.id];
    if (!file || !book || String(file.bookId) !== params.id) return errorPage(404, "No such book.", "../../../../");

    const form = await req.formData();
    const approved = form.getAll("fix").map(Number).filter(Number.isInteger);
    let original: { bytes: Uint8Array; filename?: string };
    try {
        original = await bookorbit.download(Number(params.fileId), config.maxFileSize);
    } catch (err) {
        if (err instanceof TooLargeError) return errorPage(413, `The book is ${err.message}.`, back);
        if (err instanceof HttpError && err.status === 404) return errorPage(404, "The book is no longer in BookOrbit.", back);
        log.error(`repair: downloading file ${params.fileId} failed: ${(err as Error).message}`);
        return errorPage(502, "Could not download the book from BookOrbit; see the orbitkit log.", back);
    }

    const result = await repair(original.bytes, approved, options);
    if (!result) return errorPage(409, "There is nothing to repair in this book (any more). Go back to see its current state.", back);
    // The ticked indices refer to the plan shown on the page; a changed book has a different plan
    if (form.get("plan") !== planId(result.plan)) {
        return errorPage(409, "The book changed since this page was made, so its fixes did too. Go back and choose again.", back);
    }

    if (form.get("action") === "download") {
        const stem = (original.filename ?? book.title ?? "book").replace(/\.epub$/i, "");
        log.info(`repair: "${book.title}" downloaded with ${approved.length} fix(es): ${delta(result.result)}`);
        return new Response(new Uint8Array(result.bytes), {
            headers: { "content-type": "application/epub+zip", "content-disposition": attachment(`${stem}_fixed.epub`) },
        });
    }

    if (form.get("action") === "replace") {
        if (!replacer) return errorPage(403, "Replacing books in the library is off (EPUB_CHECK_REPLACE_IN_LIBRARY).", back);
        if (!Object.values(result.result.outcomes).some((o) => o.outcome === "applied")) {
            return errorPage(422, "None of the selected fixes could be applied, so there is nothing to replace the book with.", back);
        }
        try {
            const replaced = await replacer.replace(Number(params.id), Number(params.fileId), book.title || `Book ${params.id}`, original.bytes, result.bytes);
            return html(page(`Replaced · ${book.title} · orbitkit`, `<p><a href="${back}">← ${escape(book.title || "Book")}</a></p>
<h1>Replaced ${escape(book.title || "Book")}</h1>
<p>${badge("applied")} The book in your library is now the repaired version: <strong>${delta(result.result)}</strong>.</p>
<p class="muted">File: <code>${escape(replaced.path)}</code><br>The original is kept in orbitkit's data volume as <code>${escape(replaced.backup)}</code>.<br>
BookOrbit is asked to scan the library, so it picks up the new file; reading progress and annotations stay with the book.</p>`));
        } catch (err) {
            if (!(err instanceof ReplaceError)) throw err;
            return errorPage(409, err.message, back);
        }
    }

    const { result: outcome, remaining, plan } = result;
    const revealed = outcome.revealed
        ? `<p class="muted">${outcome.revealed} finding(s) were always in the book, but only became visible once a fix let the validator read part of it.
Repairing the downloaded book again can fix some of them.</p>` : "";
    return html(page(`Repair · ${book.title} · orbitkit`, `<p><a href="${back}">← ${escape(book.title || "Book")}</a></p>
<h1>Repair of ${escape(book.title || "Book")}</h1>
<p>With the ${approved.length} selected fix${approved.length === 1 ? "" : "es"}: <strong>${delta(outcome)}</strong>.</p>
${revealed}
${fixForm(plan, new Set(approved), "repair", outcome.outcomes, !!replacer)}
<h2>Remaining findings</h2>
${remaining.length ? findingsTable(remaining) : `<p>${badge("valid")} None.</p>`}`));
}

type FileParams = { id: string; fileId: string };

/** The state entries a file route works on, or null if the file does not belong to the book. */
function fileOf(state: State, params: FileParams) {
    const file = state.data.files[params.fileId];
    const book = state.data.books[params.id];
    return file && book && String(file.bookId) === params.id ? { file, book, title: book.title || `Book ${params.id}` } : null;
}

/** The book's current file, straight from BookOrbit, to fix it by hand. */
async function handleOriginal(params: FileParams, config: Config, state: State, bookorbit: BookOrbit) {
    const entry = fileOf(state, params);
    if (!entry) return errorPage(404, "No such book.", "../../../../");
    try {
        const { bytes, filename } = await bookorbit.download(Number(params.fileId), config.maxFileSize);
        return new Response(new Uint8Array(bytes), {
            headers: { "content-type": "application/epub+zip", "content-disposition": attachment(filename ?? `${entry.title}.epub`) },
        });
    } catch (err) {
        if (err instanceof TooLargeError) return errorPage(413, `The book is ${err.message}.`, `../../../${params.id}`);
        log.error(`downloading file ${params.fileId} failed: ${(err as Error).message}`);
        return errorPage(502, "Could not download the book from BookOrbit; see the orbitkit log.", `../../../${params.id}`);
    }
}

/** Check an uploaded version of a book and keep it for confirmation. */
async function handleUpload(req: Request, params: FileParams, config: Config, state: State, uploads: Uploads) {
    const back = `../../../${encodeURIComponent(params.id)}`;
    const entry = fileOf(state, params);
    if (!entry) return errorPage(404, "No such book.", "../../../../");
    const upload = (await req.formData()).get("epub");
    if (!(upload instanceof File) || upload.size === 0) return errorPage(400, "Choose an EPUB file to upload.", back);
    if (upload.size > config.maxFileSize) return errorPage(413, "The file is larger than EPUB_CHECK_MAX_FILE_SIZE_MB.", back);
    const bytes = new Uint8Array(await upload.arrayBuffer());
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return errorPage(422, "That is not an EPUB: EPUB files are ZIP archives.", back);

    const check = validateEpub(bytes);
    const token = await uploads.stage(Number(params.id), Number(params.fileId), upload.name, bytes);
    const current = entry.file.counts;
    const worse = current && errorCount(check.counts) > errorCount(current);
    const uploadTitle = epubTitle(bytes);
    const otherTitle = uploadTitle && uploadTitle.toLowerCase() !== entry.title.toLowerCase();
    const counts = (c: Counts | null) => c ? `${c.fatal ? `${c.fatal} fatal, ` : ""}${c.error} error${c.error === 1 ? "" : "s"}, ${c.warning} warning${c.warning === 1 ? "" : "s"}` : "not checked";
    return html(page(`Upload · ${entry.title} · orbitkit`, `<p><a href="${back}">← ${escape(entry.title)}</a></p>
<h1>Your version of ${escape(entry.title)}</h1>
<table>
<tr><th></th><th>Title inside the book</th><th>Findings</th></tr>
<tr><td>In the library</td><td>${escape(entry.title)}</td><td>${counts(current)}</td></tr>
<tr><td>Your upload <span class="muted">(${escape(upload.name)}, ${size(bytes.length)})</span></td><td>${escape(uploadTitle ?? "none")}</td><td>${counts(check.counts)}</td></tr>
</table>
${otherTitle ? `<p>${badge("check", "warning")} The title inside your upload differs from the book in the library. Make sure it is the right file.</p>` : ""}
${worse ? `<p>${badge("check", "warning")} Your upload has more errors than the book in the library.</p>` : ""}
<form method="post" action="upload/confirm"><input type="hidden" name="token" value="${token}"><div class="actions">
<button type="submit" class="primary" onclick="return confirm('Replace the book in BookOrbit with your upload? orbitkit keeps the original as a backup.')">Replace in BookOrbit</button>
<a href="${back}">Cancel</a>
</div></form>
<h2>Findings in your upload</h2>
${check.findings.length ? findingsTable(check.findings) : `<p>${badge("valid")} None.</p>`}`));
}

/** Put a checked upload in place of the book. */
async function handleUploadConfirm(req: Request, params: FileParams, config: Config, state: State, bookorbit: BookOrbit, replacer: Replacer, uploads: Uploads) {
    const back = `../../../../${encodeURIComponent(params.id)}`;
    const entry = fileOf(state, params);
    if (!entry) return errorPage(404, "No such book.", "../../../../../");
    const token = String((await req.formData()).get("token") ?? "");
    const staged = await uploads.get(token, Number(params.id), Number(params.fileId));
    if (!staged) return errorPage(404, "This upload has expired or was used already. Upload the book again.", back);

    let original: Uint8Array;
    try {
        ({ bytes: original } = await bookorbit.download(Number(params.fileId), config.maxFileSize));
    } catch (err) {
        log.error(`downloading file ${params.fileId} failed: ${(err as Error).message}`);
        return errorPage(502, "Could not download the book from BookOrbit; see the orbitkit log.", back);
    }
    if (Buffer.from(original).equals(Buffer.from(staged.bytes))) {
        await uploads.remove(token);
        return errorPage(409, "Your upload is the same file as the book in the library; nothing to replace.", back);
    }
    const before = entry.file.counts;
    try {
        const replaced = await replacer.replace(Number(params.id), Number(params.fileId), entry.title, original, staged.bytes);
        await uploads.remove(token);
        const after = state.data.files[params.fileId]?.counts;
        return html(page(`Replaced · ${entry.title} · orbitkit`, `<p><a href="${back}">← ${escape(entry.title)}</a></p>
<h1>Replaced ${escape(entry.title)}</h1>
<p>${badge("applied")} The book in your library is now your upload${before && after ? `: <strong>errors ${errorCount(before)} → ${errorCount(after)}</strong>` : ""}.</p>
<p class="muted">File: <code>${escape(replaced.path)}</code><br>The original is kept in orbitkit's data volume as <code>${escape(replaced.backup)}</code>.<br>
BookOrbit is asked to scan the library, so it picks up the new file; reading progress and annotations stay with the book.</p>`));
    } catch (err) {
        if (!(err instanceof ReplaceError)) throw err;
        return errorPage(409, err.message, back);
    }
}

/** The "replace all" page: what would be replaced and a button to start, or the running job's progress. */
export function renderReplaceAll(replacer: Replacer): string {
    const job: Job | undefined = replacer.job;
    const running = job && !job.finishedAt;
    const replacedCount = job ? job.items.filter((i) => i.outcome === "replaced").length : 0;
    const results = job
        ? `<h2>${running ? `Replacing… ${job.items.length} of ${job.total}` : `Done: ${replacedCount} of ${job.total} replaced`}</h2>
${job.items.length ? `<table>
<tr><th>Book</th><th>Result</th><th></th></tr>
${job.items.map((item) => `<tr><td><a href="books/${item.bookId}">${escape(item.title)}</a></td>
<td>${badge(item.outcome, item.outcome === "replaced" ? "applied" : item.outcome === "failed" ? "error" : "skipped")}</td>
<td>${item.before && item.after ? `errors ${errorCount(item.before)} → ${errorCount(item.after)}` : escape(item.message)}</td></tr>`).join("\n")}
</table>` : ""}`
        : "";
    const candidates = running ? [] : replacer.candidates();
    const start = candidates.length
        ? `<p>These ${candidates.length} book(s) get only their <strong>safe</strong> fixes, the ones that need no decision. Each one is
downloaded again and repaired as it is now; the original is kept in orbitkit's data volume, and BookOrbit is asked to scan
the library afterwards. Reading progress and annotations stay with the books.</p>
<table>
<tr><th>Book</th><th>With safe fixes</th></tr>
${candidates.map((c) => `<tr><td><a href="books/${c.bookId}">${escape(c.title)}</a></td><td>errors ${c.errors} → ${c.errorsAfterSafeFixes}</td></tr>`).join("\n")}
</table>
<form method="post" action="replace-safe"><div class="actions">
<button type="submit" class="primary" onclick="return confirm('Replace ${candidates.length} book(s) in BookOrbit with their safe fixes?')">Replace ${candidates.length} book(s) in BookOrbit</button>
</div></form>`
        : running ? "" : `<p>No book has safe fixes that would remove errors.</p>`;
    return page("Replace with safe fixes · orbitkit", `${running ? `<meta http-equiv="refresh" content="3">` : ""}<p><a href="./">← All books</a></p>
<h1>Replace books with their safe fixes</h1>
${results}
${start}`);
}

type Route = Handler<Request & { params: Record<string, string> }> | Partial<Record<"GET" | "POST", Handler<Request & { params: Record<string, string> }>>>;

/** The routes once at the root and once below basePath, where e.g. BookOrbit's address leads to them. */
export function withBasePath(routes: Record<string, Route>, basePath: string): Record<string, Route> {
    if (!basePath) return routes;
    const all: Record<string, Route> = { ...routes };
    for (const [path, route] of Object.entries(routes)) all[`${basePath}${path}`] = route;
    // The pages link relative to their root, which needs the trailing slash
    all[basePath] = () => new Response(null, { status: 308, headers: { location: `${basePath}/` } });
    return all;
}

/**
 * Serve the report pages: / lists books with problems, /books/<book ID> shows every finding and epubsana's fixes,
 * /books/<book ID>/files/<file ID>/repair applies the chosen fixes to a copy (or, with EPUB_CHECK_REPLACE_IN_LIBRARY, to the book),
 * /replace-safe replaces every book whose safe fixes remove errors, and /books/<book ID>/files/<file ID>/upload takes a
 * version fixed by hand (those three with EPUB_CHECK_REPLACE_IN_LIBRARY). With a login, only BookOrbit users with its
 * permission see them; /login and /healthz are open.
 */
export function serveReports(config: Config, state: State, checker: Checker, replacer?: Replacer, login?: Login) {
    const { bookorbit, repairOptions } = checker;
    const uploads = replacer ? new Uploads(config.dataDir) : undefined;
    const off = () => errorPage(404, "Replacing books in the library is off (EPUB_CHECK_REPLACE_IN_LIBRARY).");
    const guard = <R extends Request>(handler: Handler<R>): Handler<R> => login ? login.guard(handler) : handler;
    const signedIn = (req: Request) => {
        const auth = login?.auth(req);
        return auth?.via === "session" ? auth.user.username : undefined;
    };

    return Bun.serve({
        port: config.port,
        // Uploads are whole books
        maxRequestBodySize: config.maxFileSize + 1024 * 1024,
        routes: withBasePath({
            ...login?.routes(),
            "/": guard((req) => html(renderIndex(config, state, new URL(req.url).searchParams.has("all"), replacer, signedIn(req)))),
            "/books/:id": guard(async (req) => {
                const body = await renderBook(config, state, req.params.id!, !!replacer);
                return body ? html(body) : errorPage(404, "No such book.");
            }),
            "/books/:id/files/:fileId/repair": {
                POST: guard((req) => handleRepair(req, req.params as { id: string; fileId: string }, config, state, bookorbit, repairOptions, replacer)),
            },
            "/books/:id/files/:fileId/original": guard((req) =>
                replacer ? handleOriginal(req.params as FileParams, config, state, bookorbit) : off()),
            "/books/:id/files/:fileId/upload": {
                POST: guard((req) => replacer && uploads ? handleUpload(req, req.params as FileParams, config, state, uploads) : off()),
            },
            "/books/:id/files/:fileId/upload/confirm": {
                POST: guard((req) => replacer && uploads
                    ? handleUploadConfirm(req, req.params as FileParams, config, state, bookorbit, replacer, uploads)
                    : off()),
            },
            "/replace-safe": {
                GET: guard(() => replacer ? html(renderReplaceAll(replacer)) : errorPage(404, "Replacing books in the library is off (EPUB_CHECK_REPLACE_IN_LIBRARY).")),
                POST: guard(() => {
                    if (!replacer) return errorPage(403, "Replacing books in the library is off (EPUB_CHECK_REPLACE_IN_LIBRARY).");
                    replacer.startReplaceAll();
                    // Back to the page, which shows the progress; reloading it does not start another job
                    return new Response(null, { status: 303, headers: { location: "replace-safe" } });
                }),
            },
            "/healthz": () => new Response("ok"),
        }, config.basePath),
        fetch: guard(() => new Response("Not found", { status: 404 })),
    });
}
