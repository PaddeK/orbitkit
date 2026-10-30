import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { opfPathOf, unescapeXml } from "./series.ts";
import { readEntry } from "./zip.ts";

/**
 * Books uploaded on a report page wait in DATA_DIR/check/uploads until they are confirmed: the page shows what the upload
 * fixes before it replaces anything. Unconfirmed uploads are deleted after an hour.
 */
export const UPLOADS_DIR = "uploads";
const MAX_AGE_MS = 60 * 60_000;

export interface StagedUpload {
    bookId: number;
    fileId: number;
    name: string;
    bytes: Uint8Array;
}

/** The book's title from its OPF, to tell a wrong upload apart; null if it has none or is no readable EPUB. */
export function epubTitle(bytes: Uint8Array): string | null {
    try {
        const path = opfPathOf(bytes);
        const opf = path ? readEntry(bytes, path)?.toString("utf8") : null;
        const title = opf ? /<((?:[\w.-]+:)?title)\b[^>]*>([\s\S]*?)<\/\1\s*>/.exec(opf)?.[2] : undefined;
        return title ? unescapeXml(title).trim() || null : null;
    } catch {
        return null;
    }
}

export class Uploads {
    private readonly dir: string;

    constructor(dataDir: string) {
        this.dir = join(dataDir, UPLOADS_DIR);
    }

    /** Keep an upload for confirmation; returns the token that names it. */
    async stage(bookId: number, fileId: number, name: string, bytes: Uint8Array): Promise<string> {
        await mkdir(this.dir, { recursive: true });
        await this.removeExpired();
        const token = crypto.randomUUID();
        await Bun.write(join(this.dir, `${token}.epub`), bytes);
        await Bun.write(join(this.dir, `${token}.json`), JSON.stringify({ bookId, fileId, name }));
        return token;
    }

    /** The staged upload, if the token names one for this file. */
    async get(token: string, bookId: number, fileId: number): Promise<StagedUpload | null> {
        if (!/^[0-9a-f-]{36}$/.test(token)) return null;
        const meta = (await Bun.file(join(this.dir, `${token}.json`)).json().catch(() => null)) as Omit<StagedUpload, "bytes"> | null;
        if (!meta || meta.bookId !== bookId || meta.fileId !== fileId) return null;
        const bytes = await Bun.file(join(this.dir, `${token}.epub`)).bytes().catch(() => null);
        return bytes ? { ...meta, bytes } : null;
    }

    async remove(token: string): Promise<void> {
        if (!/^[0-9a-f-]{36}$/.test(token)) return;
        await rm(join(this.dir, `${token}.epub`), { force: true });
        await rm(join(this.dir, `${token}.json`), { force: true });
    }

    private async removeExpired(): Promise<void> {
        for (const name of await readdir(this.dir).catch(() => [] as string[])) {
            const path = join(this.dir, name);
            const { mtimeMs } = await stat(path).catch(() => ({ mtimeMs: Date.now() }));
            if (Date.now() - mtimeMs > MAX_AGE_MS) await rm(path, { force: true });
        }
    }
}
