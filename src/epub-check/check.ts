import { unlink } from "node:fs/promises";
import { BookOrbit, type Book, type BookFile, type Field, type FieldType } from "../bookorbit.ts";
import type { Config } from "./config.ts";
import { HttpError, TooLargeError } from "../http.ts";
import { log } from "./log.ts";
import type { Epublift } from "./epublift.ts";
import { epubsanaVersion, planRepair, SERIES_FIX, type RepairOptions, type RepairPlan } from "./repairer.ts";
import { OWN_FIXES } from "./fixes.ts";
import { REPORTS_DIR, type FieldValues, type FileState, type RepairSummary, type State } from "./state.ts";
import { epubveriVersion, validateEpub, type Counts, type Finding } from "./validator.ts";

/** The custom fields orbitkit keeps up to date in BookOrbit, found by label. */
export const FIELDS: Record<keyof FieldValues, { label: string; type: FieldType }> = {
    status: { label: "EPUB check", type: "text" },
    errors: { label: "EPUB errors", type: "number" },
    warnings: { label: "EPUB warnings", type: "number" },
    report: { label: "EPUB report", type: "url" },
};
type FieldKey = keyof FieldValues;


/** What DATA_DIR/check/reports/<file ID>.json holds. */
export interface FileReport {
    fileId: number;
    bookId: number;
    size: number;
    checkedAt: number;
    epubveri: string;
    epubsana: string;
    findings: Finding[];
    /** What epubsana can fix, for files with findings it has fixes for */
    repair?: RepairPlan;
}

function repairSummary(plan: RepairPlan): RepairSummary {
    return {
        fixes: plan.fixes.length,
        safeFixes: plan.fixes.filter((f) => f.safe).length,
        errorsAfterSafeFixes: plan.safe.after.fatal + plan.safe.after.error,
    };
}

export function isEpub(file: BookFile): boolean {
    return file.format?.toLowerCase() === "epub";
}

export function describe(counts: Counts): string {
    const parts = [
        counts.fatal && `${counts.fatal} fatal`,
        counts.error && `${counts.error} error${counts.error === 1 ? "" : "s"}`,
        counts.warning && `${counts.warning} warning${counts.warning === 1 ? "" : "s"}`,
    ].filter(Boolean);
    return parts.length ? parts.join(", ") : "valid";
}

/** One verdict for a book from the checks of its EPUB files: the worst status and the summed counts. */
export function summarize(files: FileState[]): Omit<FieldValues, "report"> {
    const checked = files.filter((f) => f.counts);
    if (!checked.length) return { status: "not checked", errors: null, warnings: null };
    const sum = (pick: (c: Counts) => number) => checked.reduce((total, f) => total + pick(f.counts!), 0);
    const fatal = sum((c) => c.fatal);
    const errors = sum((c) => c.error);
    const warnings = sum((c) => c.warning);
    const status = fatal ? "fatal" : errors ? "errors" : warnings ? "warnings" : "valid";
    return { status, errors: fatal + errors, warnings };
}

export function reportPath(dataDir: string, fileId: number | string): string {
    return `${dataDir}/${REPORTS_DIR}/${fileId}.json`;
}

/** Checks new and changed EPUBs in BookOrbit with epubveri and writes the verdict to custom fields. */
export class Checker {
    readonly bookorbit: BookOrbit;
    /** What repairs are offered, for the report pages and the replacer too */
    readonly repairOptions: RepairOptions;
    /** Tools a file was checked with; a new version of one, or turning a kind of fix on or off, checks every book again */
    private readonly checkedWith: string;
    /** Field/library pairs already warned about, so the log says it once */
    private readonly warned = new Set<string>();

    constructor(private readonly config: Config, private readonly state: State, epublift?: Epublift) {
        this.repairOptions = { ownFixes: config.ownFixes, epublift };
        this.checkedWith = `epubveri ${epubveriVersion}, epubsana ${epubsanaVersion}`
            + `${config.ownFixes ? `, orbitkit fixes ${OWN_FIXES.map((f) => f.key).join(" ")}` : ""}`
            + `${epublift ? `, epublift ${epublift.version}` : ""}`;
        this.bookorbit = new BookOrbit(config.bookorbitUrl, config.bookorbitUser, config.bookorbitPassword, state.data.session, () =>
            state.save());
    }

    async cycle(): Promise<void> {
        const books = (await this.bookorbit.books()).filter((book) => book.files.some(isEpub));
        await this.forgetRemoved(books);
        const fields = await this.ensureFields(books);

        let checked = 0;
        let updated = 0;
        for (const book of books) {
            const previous = this.state.data.books[book.id];
            this.state.data.books[book.id] = { title: book.title ?? "", authors: book.authors, libraryId: book.libraryId, written: previous?.written };
            for (const file of book.files.filter(isEpub)) {
                if (this.isCurrent(file)) continue;
                if (await this.check(book, file)) checked++;
                this.state.data.lastProgress = Date.now();
                await this.state.save();
            }
            if (await this.writeFields(book, fields)) updated++;
        }

        this.state.data.lastSuccess = Date.now();
        await this.state.save();
        log.info(`cycle done: ${books.length} book(s) with EPUBs, ${checked} checked, ${updated} updated in BookOrbit`);
    }

    /** A file needs no check if it has the same size and was checked by these epubveri and epubsana versions. */
    private isCurrent(file: BookFile): boolean {
        const known = this.state.data.files[file.id];
        if (!known || known.size !== file.sizeBytes || known.checkedWith !== this.checkedWith) return false;
        // Skipped as too large, but EPUB_CHECK_MAX_FILE_SIZE_MB was raised since
        return known.counts !== null || (file.sizeBytes ?? 0) > this.config.maxFileSize;
    }

    /** Download and validate one file, and plan its repair if it has findings. False if it is gone from BookOrbit. */
    private async check(book: Book, file: BookFile): Promise<boolean> {
        const title = book.title ?? `book ${book.id}`;
        let bytes: Uint8Array;
        try {
            ({ bytes } = await this.bookorbit.download(file.id, this.config.maxFileSize));
        } catch (err) {
            if (err instanceof HttpError && err.status === 404) return false;
            if (!(err instanceof TooLargeError)) throw err;
            log.warn(`skipped "${title}": ${err.message} (EPUB_CHECK_MAX_FILE_SIZE_MB)`);
            this.state.data.files[file.id] = {
                bookId: book.id, size: file.sizeBytes, checkedWith: this.checkedWith, checkedAt: Date.now(), counts: null, problem: err.message,
            };
            await unlink(reportPath(this.config.dataDir, file.id)).catch(() => {});
            return true;
        }

        await this.record(book.id, title, file.id, file.sizeBytes, bytes);
        return true;
    }

    /**
     * Validate a file's contents, plan its repair and store both. Also used right after orbitkit replaced a file
     * in the library, so its report shows the new state before BookOrbit has rescanned.
     */
    async record(bookId: number, title: string, fileId: number, size: number | null, bytes: Uint8Array): Promise<void> {
        const result = validateEpub(bytes);
        const { fatal, error, warning } = result.counts;
        const plan = fatal + error + warning ? await planRepair(bytes, this.repairOptions) : null;
        const checkedAt = Date.now();
        const report: FileReport = {
            fileId, bookId, size: bytes.length, checkedAt, epubveri: epubveriVersion, epubsana: epubsanaVersion,
            findings: result.findings, repair: plan ?? undefined,
        };
        await Bun.write(reportPath(this.config.dataDir, fileId), JSON.stringify(report));
        this.state.data.files[fileId] = {
            bookId, size, checkedWith: this.checkedWith, checkedAt, counts: result.counts,
            repair: plan ? repairSummary(plan) : undefined,
        };
        await this.state.save();
        const series = plan?.fixes.find((f) => f.index === SERIES_FIX);
        log.info(`checked "${title}": ${describe(result.counts)}${plan ? `; ${plan.fixes.length} fix(es) proposed` : ""}`
            + `${series ? ` (BookOrbit series bug: ${series.safe ? "safe" : "to confirm"})` : ""}`);
    }

    /** Drop books and files that left BookOrbit, with their reports. */
    private async forgetRemoved(books: Book[]): Promise<void> {
        const fileIds = new Set(books.flatMap((book) => book.files.filter(isEpub).map((file) => String(file.id))));
        const bookIds = new Set(books.map((book) => String(book.id)));
        for (const id of Object.keys(this.state.data.files)) {
            if (fileIds.has(id)) continue;
            delete this.state.data.files[id];
            await unlink(reportPath(this.config.dataDir, id)).catch(() => {});
        }
        for (const id of Object.keys(this.state.data.books)) {
            if (!bookIds.has(id)) delete this.state.data.books[id];
        }
    }

    private wantedFields(): FieldKey[] {
        return this.config.reportUrl ? ["status", "errors", "warnings", "report"] : ["status", "errors", "warnings"];
    }

    /**
     * Find orbitkit's custom fields, creating missing ones for the libraries with EPUBs. Fields orbitkit
     * created are also enabled for libraries added later; fields someone else made are left alone.
     */
    private async ensureFields(books: Book[]): Promise<Partial<Record<FieldKey, Field>>> {
        const libraryIds = [...new Set(books.map((book) => book.libraryId))].sort((a, b) => a - b);
        const existing = await this.bookorbit.fields();
        const fields: Partial<Record<FieldKey, Field>> = {};

        for (const key of this.wantedFields()) {
            const { label, type } = FIELDS[key];
            let field = existing.find((f) => f.label.trim().toLowerCase() === label.toLowerCase());
            if (field && field.type !== type) {
                throw new Error(`BookOrbit already has a custom field "${field.label}" of type ${field.type}, but orbitkit needs`
                    + ` type ${type}. Rename that field in BookOrbit so orbitkit can create its own.`);
            }
            const missing = libraryIds.filter((id) => !field?.enabledLibraryIds.includes(id));
            if (this.config.dryRun) {
                if (!field) log.info(`dry run: would create custom field "${label}"`);
            } else if (!field) {
                field = await this.permitted(() => this.bookorbit.createField(label, type, libraryIds));
                this.state.data.createdFields.push(field.id);
                await this.state.save();
                log.info(`created custom field "${label}" in BookOrbit`);
            } else if (missing.length && this.state.data.createdFields.includes(field.id)) {
                field = await this.permitted(() => this.bookorbit.enableField(field!.id, [...field!.enabledLibraryIds, ...missing]));
                log.info(`enabled custom field "${label}" for ${missing.length} more librar${missing.length === 1 ? "y" : "ies"}`);
            }
            for (const libraryId of libraryIds.filter((id) => field && !field.enabledLibraryIds.includes(id))) {
                if (this.warned.has(`${field!.id}:${libraryId}`)) continue;
                this.warned.add(`${field!.id}:${libraryId}`);
                log.warn(`custom field "${label}" is not enabled for library ${libraryId}: its books are checked, but this field is not set.`
                    + " Enable the field for the library in BookOrbit to change that.");
            }
            fields[key] = field;
        }
        return fields;
    }

    private async permitted<T>(request: () => Promise<T>): Promise<T> {
        try {
            return await request();
        } catch (err) {
            if (!(err instanceof HttpError && err.status === 403)) throw err;
            const labels = this.wantedFields().map((key) => `"${FIELDS[key].label}" (${FIELDS[key].type})`).join(", ");
            throw new Error(`BOOKORBIT_USER may not manage custom fields. Give it the "Manage libraries" permission,`
                + ` or create these fields in BookOrbit yourself: ${labels}`);
        }
    }

    /** Write the book's verdict to its custom fields if it changed. True if something was written. */
    private async writeFields(book: Book, fields: Partial<Record<FieldKey, Field>>): Promise<boolean> {
        const files = book.files.filter(isEpub).map((file) => this.state.data.files[file.id]).filter((f): f is FileState => !!f);
        if (!files.length) return false;
        const values: FieldValues = {
            ...summarize(files),
            report: this.config.reportUrl ? `${this.config.reportUrl}/books/${book.id}` : null,
        };
        const bookState = this.state.data.books[book.id]!;
        const changes = this.wantedFields()
            .filter((key) => fields[key]?.enabledLibraryIds.includes(book.libraryId) && bookState.written?.[fields[key].id] !== values[key])
            .map((key) => ({ key, fieldId: fields[key]!.id, value: values[key] }));
        if (!changes.length) return false;
        if (this.config.dryRun) {
            log.info(`dry run: would set ${changes.map((c) => `${FIELDS[c.key].label}=${c.value}`).join(", ")} on "${book.title}"`);
            return false;
        }

        try {
            await this.bookorbit.setFieldValues(book.id, changes.map(({ fieldId, value }) => ({ fieldId, value })));
        } catch (err) {
            // 404: deleted between listing and writing. 400: BookOrbit refused the values; the next cycle tries again
            if (!(err instanceof HttpError && (err.status === 404 || err.status === 400))) throw err;
            if (err.status === 400) log.warn(`could not update "${book.title}" in BookOrbit: ${err.message}`);
            return false;
        }
        bookState.written = { ...bookState.written, ...Object.fromEntries(changes.map((c) => [c.fieldId, c.value])) };
        await this.state.save();
        return true;
    }
}
