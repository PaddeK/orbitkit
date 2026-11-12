import { type Book, type BookFile, BookOrbit } from "../bookorbit.ts";
import { HttpError, TooLargeError } from "../http.ts";
import type { Config, ShelfConfig } from "./config.ts";
import { Fingerprint } from "./fingerprint.ts";
import { log } from "./log.ts";
import type { CloudBook, PocketBookCloud } from "./pocketbook.ts";
import type { ShelfEntry, State } from "./state.ts";

/** The formats sent to the reader, the preferred first; a book goes with the first of them it has. */
export const SHELF_FORMATS = ["epub", "fb2", "mobi", "azw3", "azw", "pdf", "djvu", "cbz", "cbr", "docx", "doc", "rtf", "txt"];
/** Books are held in memory between download and upload */
const MAX_BYTES = 300 * 1024 * 1024;

/** What one round of sending did. */
export interface ShelfResult {
    uploaded: number;
    /** Not sent because the cloud had them already */
    found: number;
}

/** Roles of the files that hold the book: its main file and other formats of it, not covers or supplements */
const BOOK_ROLES = new Set(["primary", "content"]);

/** The file of a book to send: the book in the most preferred format. */
export function pickFile(book: Book): BookFile | undefined {
    const files = book.files.filter((file) => BOOK_ROLES.has(file.role) && file.format);
    for (const format of SHELF_FORMATS) {
        const file = files.find((candidate) => candidate.format!.toLowerCase() === format);
        if (file) return file;
    }
    return undefined;
}

/** A file name the cloud takes: no path separators or control characters, with the extension, at least 5 characters. */
export function cloudFileName(book: Book, file: BookFile, downloaded?: string): string {
    const extension = file.format!.toLowerCase();
    let name = (downloaded || `${book.title || `Book ${book.id}`}.${extension}`).replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim();
    if (!name.toLowerCase().endsWith(`.${extension}`)) name += `.${extension}`;
    if (name.length < 5) name = `book-${book.id}.${extension}`;
    if (name.length > 255) name = `${name.slice(0, 250 - extension.length)}.${extension}`;
    return name;
}

/**
 * Sends the books of a BookOrbit shelf (a collection) to PocketBook Cloud, from where the reader syncs them, and
 * puts them into a cloud collection. Books taken off the shelf stay in the cloud: removing them is up to the reader.
 */
export class ShelfSender {
    readonly bookorbit: BookOrbit;
    /** Warnings about the setup, logged once until they change */
    private readonly warned = new Set<string>();

    constructor(
        private readonly shelf: ShelfConfig,
        private readonly config: Pick<Config, "bookorbitUrl" | "dryRun">,
        private readonly pocketbook: PocketBookCloud,
        private readonly state: State,
    ) {
        this.bookorbit = new BookOrbit(config.bookorbitUrl, { apiKey: shelf.apiKey });
    }

    private get entries(): Record<string, ShelfEntry> {
        return (this.state.data.shelf ??= {});
    }

    /** One round; `cloud` is the cloud library as just listed. */
    async send(cloud: CloudBook[]): Promise<ShelfResult> {
        const result: ShelfResult = { uploaded: 0, found: 0 };
        const books = await this.shelfBooks();
        if (!books) return result;
        this.forgetRemoved(books);

        for (const book of books) {
            const outcome = await this.sendBook(book, cloud);
            if (outcome === "uploaded") result.uploaded++;
            else if (outcome === "found") result.found++;
            else if (outcome === "full") break;
        }
        return result;
    }

    /** The books on the shelf, or undefined if BookOrbit has no shelf of that name. */
    private async shelfBooks(): Promise<Book[] | undefined> {
        const collections = await this.bookorbit.collections();
        const collection = collections.find((c) => c.name === this.shelf.name)
            ?? collections.find((c) => c.name.toLowerCase() === this.shelf.name.toLowerCase());
        if (!collection) {
            const names = collections.map((c) => `"${c.name}"`).join(", ") || "none";
            this.warnOnce(`BookOrbit has no shelf "${this.shelf.name}" for the owner of POCKETBOOK_SYNC_BOOKORBIT_API_KEY (shelves: ${names})`);
            return undefined;
        }
        // Said again if the shelf goes missing once more
        for (const message of this.warned) if (message.startsWith("BookOrbit has no shelf")) this.warned.delete(message);
        return this.bookorbit.collectionBooks(collection.id);
    }

    private forgetRemoved(books: Book[]): void {
        const present = new Set(books.map((book) => String(book.id)));
        for (const [id, entry] of Object.entries(this.entries)) {
            if (present.has(id)) continue;
            delete this.entries[id];
            log.info(`"${entry.title}" left the shelf "${this.shelf.name}"; it stays in PocketBook Cloud`);
        }
    }

    /**
     * The cloud's copy of a file, if it has one. The listing has no checksum to compare, so books of the same size are
     * downloaded and compared; that is rare, as sizes seldom match by chance.
     */
    private async findInCloud(bytes: Uint8Array, cloud: CloudBook[]): Promise<CloudBook | undefined> {
        const md5Hex = new Bun.CryptoHasher("md5").update(bytes).digest("hex");
        for (const candidate of cloud) {
            if (Number(candidate.bytes) !== bytes.length || !candidate.link) continue;
            if (candidate.fast_hash === md5Hex) return candidate;
            const fingerprint = new Fingerprint();
            try {
                await this.pocketbook.download(candidate, (chunk) => fingerprint.update(chunk));
            } catch (err) {
                log.info(`could not compare with "${candidate.title}" in PocketBook Cloud: ${(err as Error).message}`);
                continue;
            }
            if (fingerprint.md5Hex === md5Hex) return candidate;
        }
        return undefined;
    }

    private async sendBook(book: Book, cloud: CloudBook[]): Promise<"uploaded" | "found" | "full" | undefined> {
        const title = book.title || `Book ${book.id}`;
        const entry: ShelfEntry = (this.entries[String(book.id)] ??= { title });
        if (entry.fastHash) {
            if (!entry.collected) await this.collect(entry);
            return undefined;
        }

        const file = pickFile(book);
        if (!file) {
            const formats = [...new Set(book.files.map((f) => f.format).filter(Boolean))].join(", ") || "none";
            return this.skip(entry, undefined, `it has no format PocketBook reads (has: ${formats})`);
        }
        if (entry.skipped && entry.fileId === file.id) return undefined;

        let download: { bytes: Uint8Array; filename?: string };
        try {
            download = await this.bookorbit.download(file.id, MAX_BYTES);
        } catch (err) {
            if (err instanceof TooLargeError) return this.skip(entry, file.id, `its ${file.format} file is ${err.message}`);
            if (err instanceof HttpError && err.status === 403) {
                this.warnOnce(`BookOrbit refused to download a book: POCKETBOOK_SYNC_BOOKORBIT_API_KEY needs the "Download books" permission`);
                return undefined;
            }
            throw err;
        }
        const fingerprint = new Fingerprint();
        fingerprint.update(download.bytes);

        // Already in the cloud, e.g. downloaded on the reader before: no second copy
        const existing = await this.findInCloud(download.bytes, cloud);
        if (existing) {
            Object.assign(entry, { fileId: file.id, fastHash: existing.fast_hash, skipped: undefined });
            log.info(`"${title}" is in PocketBook Cloud already`);
            await this.collect(entry);
            return "found";
        }

        const name = cloudFileName(book, file, download.filename);
        if (this.config.dryRun) {
            log.info(`[dry run] would upload "${title}" to PocketBook Cloud as ${name} (${download.bytes.length} bytes)`);
            return undefined;
        }
        try {
            const uploaded = await this.pocketbook.upload(name, new Uint8Array(download.bytes));
            Object.assign(entry, { fileId: file.id, fastHash: uploaded.fast_hash, skipped: undefined });
        } catch (err) {
            if (!(err instanceof HttpError)) throw err;
            if (err.status === 409) return this.skip(entry, file.id, "PocketBook Cloud has this file already, under another name");
            if (err.status === 415) return this.skip(entry, file.id, `PocketBook Cloud does not take it: ${err.body.slice(0, 200)}`);
            if (err.status === 507) {
                log.warn(`PocketBook Cloud storage is full, "${title}" and the rest of the shelf wait: ${err.body.slice(0, 200)}`);
                return "full";
            }
            log.warn(`uploading "${title}" failed, will retry next cycle: ${err.message}`);
            return undefined;
        }
        // The reader's progress sync knows the book right away, without downloading it from the cloud again
        this.state.data.books[entry.fastHash!] ??= { koreaderHash: fingerprint.koreaderHash, title, matched: false };
        log.info(`uploaded "${title}" to PocketBook Cloud (${download.bytes.length} bytes)`);
        await this.collect(entry);
        await this.state.save();
        return "uploaded";
    }

    private warnOnce(message: string): void {
        if (!this.warned.has(message)) log.warn(message);
        this.warned.add(message);
    }

    private skip(entry: ShelfEntry, fileId: number | undefined, reason: string): undefined {
        // Logged once per file, not every cycle
        if (entry.skipped !== reason || entry.fileId !== fileId) log.warn(`not sending "${entry.title}": ${reason}`);
        Object.assign(entry, { fileId, skipped: reason });
        return undefined;
    }

    private async collect(entry: ShelfEntry): Promise<void> {
        if (this.config.dryRun) return;
        try {
            await this.pocketbook.addToCollection(this.shelf.cloudCollection, entry.fastHash!);
            entry.collected = true;
        } catch (err) {
            if (!(err instanceof HttpError)) throw err;
            // A file the cloud is still processing can't be added yet
            log.info(`adding "${entry.title}" to the PocketBook collection "${this.shelf.cloudCollection}" failed, will retry next cycle: ${err.message}`);
        }
    }
}
