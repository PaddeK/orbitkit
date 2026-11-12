import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import type { Tokens } from "./pocketbook.ts";

/** What the bridge knows about one cloud book, keyed by PocketBook's fast_hash. */
export interface BookState {
    /** KOReader partial MD5 of the file: BookOrbit's document ID */
    koreaderHash: string;
    title: string;
    /** Whether BookOrbit knows this file */
    matched: boolean;
    /** Last progress sent: whole percent and PocketBook's mtime (epoch seconds) */
    sent?: { percent: number; mtime?: number };
}

/** A book on the BookOrbit shelf, keyed by its BookOrbit ID. */
export interface ShelfEntry {
    title: string;
    /** The BookOrbit file sent, or the one that was skipped */
    fileId?: number;
    /** Its fast_hash in PocketBook Cloud, once it is there */
    fastHash?: string;
    /** Whether it was put into the cloud collection */
    collected?: boolean;
    /** Why this file is not sent, e.g. a format PocketBook does not take; tried again when the book gets another file */
    skipped?: string;
}

export interface StateData {
    version: 1;
    /** Device ID reported to BookOrbit */
    deviceId?: string;
    pocketbook: Tokens;
    books: Record<string, BookState>;
    /** The books of the shelf sent to PocketBook Cloud (POCKETBOOK_SYNC_SHELF) */
    shelf?: Record<string, ShelfEntry>;
    /** Epoch milliseconds of the last successful sync cycle, for the healthcheck */
    lastSuccess?: number;
}

/** The file written by the first, Python version of the bridge (no version field). */
interface PythonState {
    device_id?: string;
    pocketbook?: { access_token?: string; refresh_token?: string; expires_at?: number };
    books?: Record<string, { koreader: string; title?: string; matched?: boolean; pushed?: [number, number | null] }>;
    last_success?: number;
}

function migrate(raw: StateData | PythonState): StateData {
    if ("version" in raw && raw.version === 1) return raw;
    const old = raw as PythonState;
    return {
        version: 1,
        deviceId: old.device_id,
        pocketbook: {
            accessToken: old.pocketbook?.access_token,
            refreshToken: old.pocketbook?.refresh_token,
            expiresAt: old.pocketbook?.expires_at ? old.pocketbook.expires_at * 1000 : undefined,
        },
        books: Object.fromEntries(Object.entries(old.books ?? {}).map(([fastHash, b]) => [fastHash, {
            koreaderHash: b.koreader,
            title: b.title ?? "",
            matched: b.matched ?? false,
            sent: b.pushed ? { percent: b.pushed[0], mtime: b.pushed[1] ?? undefined } : undefined,
        }])),
        lastSuccess: old.last_success ? old.last_success * 1000 : undefined,
    };
}

export const STATE_FILE = "state.json";

/**
 * Persists tokens, device ID, fingerprints and what was sent in DATA_DIR/pocketbook/state.json.
 * Mode 0600: it holds PocketBook tokens. Writes are atomic and one at a time.
 */
export class State {
    private writes: Promise<void> = Promise.resolve();

    private constructor(readonly path: string, readonly data: StateData) {}

    static async open(dataDir: string): Promise<State> {
        await mkdir(dataDir, { recursive: true });
        const path = `${dataDir}/${STATE_FILE}`;
        const file = Bun.file(path);
        if (await file.exists()) {
            const raw = (await file.json()) as StateData | PythonState;
            const state = new State(path, migrate(raw));
            if (!("version" in raw)) await state.save();
            return state;
        }
        return new State(path, { version: 1, pocketbook: {}, books: {} });
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
