import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import type { Session } from "../bookorbit.ts";
import type { Counts } from "./validator.ts";

/** What orbitkit knows about one EPUB file, keyed by BookOrbit's file ID. */
export interface FileState {
    bookId: number;
    /** Size in bytes when it was checked: a different size means a different file */
    size: number | null;
    /** epubveri and epubsana versions that checked it */
    checkedWith: string;
    /** Epoch milliseconds */
    checkedAt: number;
    /** null if the file could not be checked, see `problem` */
    counts: Counts | null;
    /** Why the file was not checked, e.g. "larger than 200 MB" */
    problem?: string;
    /** What epubsana proposes, if it has fixes for the file's findings */
    repair?: RepairSummary;
}

export interface RepairSummary {
    fixes: number;
    /** Fixes epubsana applies without asking */
    safeFixes: number;
    /** Fatals and errors left after the safe fixes */
    errorsAfterSafeFixes: number;
}

/** The values of orbitkit's custom fields on one book. */
export interface FieldValues {
    status: string;
    errors: number | null;
    warnings: number | null;
    report: string | null;
}

export interface BookState {
    title: string;
    authors: string[];
    libraryId: number;
    /** Values last written to BookOrbit by custom field ID, so unchanged books cause no writes */
    written?: Record<string, string | number | null>;
}

export interface StateData {
    version: 1;
    session: Session;
    files: Record<string, FileState>;
    books: Record<string, BookState>;
    /** IDs of custom fields orbitkit created, which it may enable for new libraries */
    createdFields: number[];
    /** Epoch milliseconds of the last successful cycle, for the healthcheck */
    lastSuccess?: number;
    /** Epoch milliseconds of the last checked book, so a long first run counts as healthy */
    lastProgress?: number;
}

export const STATE_FILE = "state.json";
export const REPORTS_DIR = "reports";

/**
 * Persists the BookOrbit session and what was checked in DATA_DIR/check/state.json; the findings of each
 * file go to DATA_DIR/check/reports/<file ID>.json. Mode 0600: it holds a BookOrbit session. Writes are atomic and one at a time.
 */
export class State {
    private writes: Promise<void> = Promise.resolve();

    private constructor(readonly path: string, readonly data: StateData) {}

    static async open(dataDir: string): Promise<State> {
        await mkdir(`${dataDir}/${REPORTS_DIR}`, { recursive: true });
        const path = `${dataDir}/${STATE_FILE}`;
        const file = Bun.file(path);
        const data = (await file.exists())
            ? ((await file.json()) as StateData)
            : { version: 1 as const, session: {}, files: {}, books: {}, createdFields: [] };
        return new State(path, data);
    }

    save(): Promise<void> {
        const json = JSON.stringify(this.data, null, 2);
        this.writes = this.writes.then(async () => {
            const tmp = `${this.path}.tmp`;
            await writeFile(tmp, json, { mode: 0o600 });
            await chmod(tmp, 0o600);
            await rename(tmp, this.path);
        });
        return this.writes;
    }
}
