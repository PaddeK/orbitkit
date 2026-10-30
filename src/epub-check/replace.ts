import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Checker } from "./check.ts";
import type { Config } from "./config.ts";
import { log } from "./log.ts";
import { planRepair, repair } from "./repairer.ts";
import type { State } from "./state.ts";
import type { Counts } from "./validator.ts";

/** Why a book was not replaced, worded for the report page. */
export class ReplaceError extends Error {}

export const BACKUPS_DIR = "backups";

export interface Replaced {
    /** The file in the library, as BookOrbit names it */
    path: string;
    /** The original, kept in DATA_DIR/check/backups */
    backup: string;
}

/** A book the "replace all" job would repair with its safe fixes. */
export interface Candidate {
    bookId: number;
    fileId: number;
    title: string;
    errors: number;
    errorsAfterSafeFixes: number;
}

export interface JobItem extends Candidate {
    outcome: "replaced" | "skipped" | "failed";
    message: string;
    before?: Counts;
    after?: Counts;
}

export interface Job {
    startedAt: number;
    finishedAt?: number;
    total: number;
    items: JobItem[];
    /** Settles when the job is done; for tests */
    done: Promise<void>;
}

const errorCount = (counts: Counts) => counts.fatal + counts.error;

function code(err: unknown): string | undefined {
    return (err as NodeJS.ErrnoException).code;
}

/**
 * Replaces books in the library with their repaired version (EPUB_CHECK_REPLACE_IN_LIBRARY). The library must be mounted into
 * orbitkit at the same path as in BookOrbit and be writable. Before a file is replaced, its contents on disk must be
 * exactly what BookOrbit served and orbitkit repaired; the original is kept in DATA_DIR/check/backups. The new file is
 * written next to the old one and renamed over it, so BookOrbit never sees half a book. A library scan afterwards
 * lets BookOrbit pick up the change: the file keeps its ID (reading progress, annotations) and its old hash goes to
 * the file's hash history, so copies on e-readers keep matching.
 */
export class Replacer {
    job?: Job;
    private readonly pendingScans = new Set<number>();
    private scanTimer?: ReturnType<typeof setTimeout>;

    constructor(
        private readonly config: Config,
        private readonly state: State,
        private readonly checker: Checker,
        /** Wait this long for more replacements before asking BookOrbit to scan */
        private readonly scanDelayMs = 5_000,
    ) {}

    /**
     * Replace one file of a book in the library with `repaired`, a repair of `original` as BookOrbit served it.
     * Then BookOrbit is asked to scan the library, unless `scan` is false (the "replace all" job scans once at its end).
     */
    async replace(bookId: number, fileId: number, title: string, original: Uint8Array, repaired: Uint8Array, scan = true): Promise<Replaced & { libraryId: number }> {
        const detail = await this.checker.bookorbit.book(bookId);
        const path = detail.files.find((f) => f.id === fileId)?.absolutePath;
        if (!path) throw new ReplaceError("This file is no longer part of the book in BookOrbit.");

        let current: Buffer;
        try {
            current = await readFile(path);
        } catch (err) {
            if (code(err) === "ENOENT") {
                throw new ReplaceError(`orbitkit cannot find ${path}. Mount the library into orbitkit at the same path as in the BookOrbit container.`);
            }
            if (code(err) === "EACCES") throw new ReplaceError(`orbitkit may not read ${path}.`);
            throw err;
        }
        if (!current.equals(original)) {
            throw new ReplaceError("The file in the library is not the one that was repaired: it changed in the meantime. Nothing was replaced.");
        }

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backup = join(this.config.dataDir, BACKUPS_DIR, String(fileId), `${stamp}-${basename(path)}`);
        await mkdir(dirname(backup), { recursive: true });
        await writeFile(backup, current);

        // A hidden name with an extension BookOrbit does not read, so its folder watcher ignores the file
        const temp = join(dirname(path), `.${basename(path)}.orbitkit-tmp`);
        try {
            const { mode } = await stat(path);
            await writeFile(temp, repaired);
            await chmod(temp, mode & 0o7777);
            await rename(temp, path);
        } catch (err) {
            await rm(temp, { force: true }).catch(() => {});
            if (code(err) === "EACCES" || code(err) === "EPERM" || code(err) === "EROFS") {
                throw new ReplaceError(`orbitkit may not write to ${dirname(path)}. Mount the library read-write, writable for uid ${process.getuid?.() ?? "?"}.`);
            }
            throw err;
        }

        log.info(`replaced "${title}" in the library (${path}); the original is kept as ${backup}`);
        await this.checker.record(bookId, title, fileId, repaired.length, repaired);
        if (scan) this.scanSoon(detail.libraryId);
        return { path, backup, libraryId: detail.libraryId };
    }

    /** Books whose safe fixes remove errors, by the latest check. */
    candidates(): Candidate[] {
        return Object.entries(this.state.data.files)
            .filter(([, f]) => f.counts && f.repair && f.repair.safeFixes > 0 && f.repair.errorsAfterSafeFixes < errorCount(f.counts))
            .map(([fileId, f]) => ({
                bookId: f.bookId,
                fileId: Number(fileId),
                title: this.state.data.books[f.bookId]?.title || `Book ${f.bookId}`,
                errors: errorCount(f.counts!),
                errorsAfterSafeFixes: f.repair!.errorsAfterSafeFixes,
            }))
            .sort((a, b) => a.title.localeCompare(b.title));
    }

    /** Start replacing every candidate with its safe fixes applied. False if a job is already running. */
    startReplaceAll(): boolean {
        if (this.job && !this.job.finishedAt) return false;
        const candidates = this.candidates();
        const job: Job = { startedAt: Date.now(), total: candidates.length, items: [], done: Promise.resolve() };
        job.done = this.runJob(job, candidates);
        this.job = job;
        return true;
    }

    private async runJob(job: Job, candidates: Candidate[]): Promise<void> {
        log.info(`replacing ${candidates.length} book(s) with their safe fixes`);
        const libraries = new Set<number>();
        for (const candidate of candidates) {
            const { item, libraryId } = await this.replaceWithSafeFixes(candidate);
            job.items.push(item);
            if (libraryId !== undefined) libraries.add(libraryId);
        }
        for (const libraryId of libraries) this.scanSoon(libraryId);
        job.finishedAt = Date.now();
        const replaced = job.items.filter((i) => i.outcome === "replaced").length;
        log.info(`replaced ${replaced} of ${candidates.length} book(s) with their safe fixes`);
    }

    private async replaceWithSafeFixes(candidate: Candidate): Promise<{ item: JobItem; libraryId?: number }> {
        const options = this.checker.repairOptions;
        try {
            const { bytes } = await this.checker.bookorbit.download(candidate.fileId, this.config.maxFileSize);
            // Plan again: the book may have changed since the report was made
            const plan = await planRepair(bytes, options);
            const safe = plan?.fixes.filter((f) => f.safe).map((f) => f.index) ?? [];
            const result = safe.length ? await repair(bytes, safe, options) : null;
            if (!result || errorCount(result.result.after) >= errorCount(result.result.before)) {
                return { item: { ...candidate, outcome: "skipped", message: "Its safe fixes no longer remove errors." } };
            }
            const { libraryId } = await this.replace(candidate.bookId, candidate.fileId, candidate.title, bytes, result.bytes, false);
            return { item: { ...candidate, outcome: "replaced", message: "Replaced.", before: result.result.before, after: result.result.after }, libraryId };
        } catch (err) {
            if (!(err instanceof ReplaceError)) log.error(`replacing "${candidate.title}" failed: ${(err as Error).message}`);
            return { item: { ...candidate, outcome: "failed", message: (err as Error).message } };
        }
    }

    /** Ask BookOrbit to scan the library soon; replacements in quick succession share one scan. */
    private scanSoon(libraryId: number): void {
        this.pendingScans.add(libraryId);
        clearTimeout(this.scanTimer);
        this.scanTimer = setTimeout(() => void this.flushScans(), this.scanDelayMs);
        this.scanTimer.unref?.();
    }

    /** Scan every library with replaced books; a library that is already being scanned is asked again later. */
    async flushScans(attempt = 1): Promise<void> {
        const libraries = [...this.pendingScans];
        this.pendingScans.clear();
        for (const libraryId of libraries) {
            try {
                if (await this.checker.bookorbit.scanLibrary(libraryId)) {
                    log.info(`asked BookOrbit to scan library ${libraryId}`);
                } else if (attempt < 10) {
                    // A scan that started before the replacement may have missed it
                    this.pendingScans.add(libraryId);
                }
            } catch (err) {
                log.warn(`could not ask BookOrbit to scan library ${libraryId}, so it may show the old file until its next scan: ${(err as Error).message}`);
            }
        }
        if (this.pendingScans.size) {
            this.scanTimer = setTimeout(() => void this.flushScans(attempt + 1), 30_000);
            this.scanTimer.unref?.();
        }
    }
}
