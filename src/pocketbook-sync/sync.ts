import { randomBytes } from "node:crypto";
import { BookOrbit } from "./koreader.ts";
import type { Config } from "./config.ts";
import { Fingerprint } from "./fingerprint.ts";
import { HttpError } from "../http.ts";
import { log } from "./log.ts";
import { type CloudBook, PocketBookCloud } from "./pocketbook.ts";
import type { State } from "./state.ts";

const AUDIO_FORMATS = new Set(["mp3", "m4a", "m4b", "aac", "ogg", "opus", "flac", "wav"]);

/** ISO 8601 to epoch seconds, the unit KOReader sync uses. */
export function toEpochSeconds(iso: string | undefined): number | undefined {
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

/** Whole percent read, as reported by PocketBook Cloud; a book marked as read counts as 100. */
export function readingPercent(book: CloudBook): number {
    if (book.read_status === "read") return 100;
    const percent = Math.trunc(Number(book.read_percent ?? 0));
    return Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
}

function isSyncable(book: CloudBook): boolean {
    return !book.isAudioBook && !AUDIO_FORMATS.has(book.format?.toLowerCase() ?? "") && !!book.link && !!book.fast_hash;
}

/** One sync cycle: PocketBook Cloud reading percentages -> BookOrbit. */
export class Bridge {
    readonly pocketbook: PocketBookCloud;
    readonly bookorbit: BookOrbit;

    constructor(private readonly config: Config, private readonly state: State) {
        const data = state.data;
        data.deviceId ??= config.deviceId ?? `pocketorbit-${randomBytes(8).toString("hex")}`;
        this.pocketbook = new PocketBookCloud(config.pbEmail, config.pbPassword, data.pocketbook, config.pbShop, config.pbUrl);
        this.bookorbit = new BookOrbit(config.bookorbitUrl, config.koreaderUser, config.koreaderPassword,
            { name: config.deviceName, id: data.deviceId });
    }

    private get books() {
        return this.state.data.books;
    }

    /** Fingerprint new books, match them in BookOrbit and send changed percentages. Returns the number sent. */
    async cycle(): Promise<number> {
        const cloud = (await this.pocketbook.books()).filter(isSyncable);
        this.forgetRemoved(cloud);
        await this.fingerprintNew(cloud);
        const known = cloud.filter((b) => this.books[b.fast_hash]);
        await this.matchUnmatched(known);
        const sent = await this.sendChanges(known);
        this.state.data.lastSuccess = Date.now();
        await this.state.save();
        log.info(`cycle done: ${cloud.length} book(s) in PocketBook Cloud, ${sent} progress update(s) sent`);
        return sent;
    }

    private forgetRemoved(cloud: CloudBook[]): void {
        const present = new Set(cloud.map((b) => b.fast_hash));
        for (const [fastHash, book] of Object.entries(this.books)) {
            if (present.has(fastHash)) continue;
            delete this.books[fastHash];
            log.info(`"${book.title}" is no longer in PocketBook Cloud, forgetting it`);
        }
    }

    /** Download each new book once to compute the KOReader hash BookOrbit identifies files by. */
    private async fingerprintNew(cloud: CloudBook[]): Promise<void> {
        for (const book of cloud) {
            if (this.books[book.fast_hash]) continue;
            const fingerprint = new Fingerprint();
            try {
                await this.pocketbook.download(book, (chunk) => fingerprint.update(chunk));
            } catch (err) {
                log.warn(`could not download "${book.title}", will retry next cycle: ${(err as Error).message}`);
                continue;
            }
            if (book.md5_hash && fingerprint.md5Base64 !== book.md5_hash) {
                log.warn(`download of "${book.title}" does not match its MD5, will retry next cycle`);
                continue;
            }
            this.books[book.fast_hash] = { koreaderHash: fingerprint.koreaderHash, title: book.title, matched: false };
            log.info(`fingerprinted "${book.title}" (${fingerprint.size} bytes)`);
            await this.state.save();
        }
    }

    /** Unmatched books are asked about every cycle, so links made in BookOrbit are picked up. */
    private async matchUnmatched(known: CloudBook[]): Promise<void> {
        const unmatched = known.filter((b) => !this.books[b.fast_hash]!.matched);
        if (unmatched.length === 0) return;
        const matched = await this.bookorbit.match(unmatched.map((b) => ({
            hash: this.books[b.fast_hash]!.koreaderHash,
            title: b.metadata?.title || b.title,
            authors: b.metadata?.authors ?? undefined,
            lastOpen: toEpochSeconds(b.mtime),
        })));
        const missing: string[] = [];
        for (const book of unmatched) {
            const entry = this.books[book.fast_hash]!;
            if (matched.has(entry.koreaderHash)) {
                entry.matched = true;
                log.info(`matched "${book.title}" in BookOrbit`);
            } else {
                missing.push(book.title);
            }
        }
        if (missing.length) {
            const list = missing.slice(0, 10).join(", ") + (missing.length > 10 ? ", ..." : "");
            log.info(`${missing.length} book(s) not found in BookOrbit, link them under KOReader Books to Review: ${list}`);
        }
        await this.state.save();
    }

    private async sendChanges(known: CloudBook[]): Promise<number> {
        let sent = 0;
        for (const book of known) {
            const entry = this.books[book.fast_hash]!;
            const percent = readingPercent(book);
            if (!entry.matched || percent === 0) continue;
            const mtime = toEpochSeconds(book.mtime);
            if (entry.sent?.percent === percent && entry.sent.mtime === mtime) continue;
            if (this.config.dryRun) {
                log.info(`[dry run] would send "${book.title}": ${percent}% (as of ${book.mtime})`);
                continue;
            }
            try {
                await this.bookorbit.pushProgress(entry.koreaderHash, percent / 100, mtime);
            } catch (err) {
                if (!(err instanceof HttpError)) throw err;
                // The book or its link was removed in BookOrbit: match again next cycle
                if (err.status === 404) entry.matched = false;
                log.warn(`sending progress for "${book.title}" failed: ${err.message}`);
                continue;
            }
            entry.sent = { percent, mtime };
            sent++;
            log.info(`sent "${book.title}": ${percent}%`);
        }
        return sent;
    }
}
