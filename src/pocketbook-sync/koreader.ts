import { createHash } from "node:crypto";
import { requestJson } from "../http.ts";
import { version } from "../../package.json";

/** Client for BookOrbit's KOReader sync API (the endpoints its KOReader plugin uses). */

const MATCH_BATCH = 500; // BookOrbit's limit per match-check request

/** A book offered to BookOrbit for matching. */
export interface MatchCandidate {
    /** KOReader partial MD5 */
    hash: string;
    title?: string;
    authors?: string;
    /** Epoch seconds */
    lastOpen?: number;
}

export interface Device {
    /** Shown in BookOrbit, e.g. "PocketBook Era Color" */
    name: string;
    id: string;
}

export class BookOrbit {
    private readonly base: string;
    private readonly headers: Record<string, string>;

    constructor(url: string, user: string, password: string, readonly device: Device) {
        this.base = `${url.replace(/\/+$/, "")}/api/v1/koreader`;
        this.headers = {
            "x-auth-user": user,
            // KOReader sends the MD5 of the password as its key; BookOrbit accepts both forms
            "x-auth-key": createHash("md5").update(password).digest("hex"),
            accept: "application/vnd.koreader.v1+json",
        };
    }

    /** Returns the username the credentials belong to; throws HttpError 401 for wrong ones. */
    async checkAuth(): Promise<string> {
        const result = await requestJson<{ username?: string }>("GET", `${this.base}/users/auth`, { headers: this.headers });
        return result.username ?? "?";
    }

    /**
     * Ask which documents BookOrbit knows; returns the matched hashes. Unknown books are listed in
     * BookOrbit under "KOReader Books to Review", where they can be linked to a library book by hand.
     */
    async match(books: MatchCandidate[]): Promise<Set<string>> {
        const matched = new Set<string>();
        for (let i = 0; i < books.length; i += MATCH_BATCH) {
            const chunk = books.slice(i, i + MATCH_BATCH);
            const result = await requestJson<{ matches?: { hash: string }[] }>("POST", `${this.base}/plugin/match-check`, {
                headers: this.headers,
                json: {
                    deviceId: this.device.id,
                    deviceModel: this.device.name,
                    pluginVersion: `pocketorbit-${version}`,
                    hashes: chunk.map((b) => b.hash),
                    books: chunk.map((b) => ({ ...b, source: "file" })),
                },
            });
            for (const m of result.matches ?? []) matched.add(m.hash.toLowerCase());
        }
        return matched;
    }

    /** Report a percentage (0..1). BookOrbit ignores it if it already has newer progress. */
    async pushProgress(document: string, percentage: number, timestamp?: number): Promise<void> {
        await requestJson("PUT", `${this.base}/syncs/progress`, {
            headers: this.headers,
            json: { document, percentage, device: this.device.name, device_id: this.device.id, timestamp },
        });
    }
}
