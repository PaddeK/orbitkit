import { HttpError, requestJson, stream } from "../http.ts";
import { log } from "./log.ts";

/** Client for the (unofficial) PocketBook Cloud API, as used by cloud.pocketbook.digital. */

export const DEFAULT_URL = "https://cloud.pocketbook.digital/api/v1.0";
// Public client credentials shipped with the PocketBook Cloud web app
const CLIENT_ID = "qNAx1RDb";
const CLIENT_SECRET = "K3YYSjCgDJNoWKdGVOyO1mrROp3MMZqqRNXNXTmh";
const PAGE_SIZE = 100;
/** Renew the access token this long before PocketBook says it expires. */
const EXPIRY_MARGIN_MS = 120_000;

/** A book in the cloud library, as far as the bridge uses it. */
export interface CloudBook {
    id: string;
    title: string;
    /** e.g. "epub", "pdf" */
    format?: string;
    /** PocketBook's own file ID; the full-file MD5 only for small files the cloud hashed itself */
    fast_hash: string;
    /**
     * Base64. It used to be the file's MD5; since November 2026 it is the fast_hash as hex text, so it is no
     * checksum any more. See md5Mismatch().
     */
    md5_hash?: string;
    /** File size */
    bytes?: number | string;
    /** Whole percent, sometimes sent as a string */
    read_percent?: number | string | null;
    /** "reading", "read", ... */
    read_status?: string;
    /** When the book (including its reading position) last changed, ISO 8601 */
    mtime?: string;
    isAudioBook?: boolean;
    metadata?: { title?: string; authors?: string | null };
    /** Signed download URL */
    link?: string;
}

/**
 * Whether a downloaded file is not the one listed: its size differs, or md5_hash still holds a real MD5 that differs.
 * md5_hash is usually the fast_hash now, which can't be checked here: PocketBook doesn't document how it computes it.
 */
export function md5Mismatch(book: CloudBook, size: number, md5Hex: string): boolean {
    if (book.bytes !== undefined && book.bytes !== null && Number(book.bytes) !== size) return true;
    if (!book.md5_hash) return false;
    const decoded = Buffer.from(book.md5_hash, "base64");
    // The old form: the raw digest
    if (decoded.length === 16) return decoded.toString("hex") !== md5Hex;
    return false;
}

/** Login state, persisted by the caller so restarts don't need a new login. */
export interface Tokens {
    accessToken?: string;
    refreshToken?: string;
    /** Epoch milliseconds */
    expiresAt?: number;
}

interface Provider {
    alias: string;
    name?: string;
    shop_id?: string;
}

interface TokenResponse {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
}

export class PocketBookError extends Error {}

export class PocketBookCloud {
    private readonly base: string;

    constructor(
        private readonly email: string,
        private readonly password: string,
        private readonly tokens: Tokens,
        private readonly shop?: string,
        baseUrl = DEFAULT_URL,
    ) {
        this.base = baseUrl.replace(/\/+$/, "");
    }

    /** All books in the cloud library. */
    async books(): Promise<CloudBook[]> {
        const items: CloudBook[] = [];
        for (;;) {
            const url = `${this.base}/books?limit=${PAGE_SIZE}&offset=${items.length}`;
            const page = await this.authorized((headers) => requestJson<{ total?: number; items?: CloudBook[] }>("GET", url, { headers }));
            const batch = page.items ?? [];
            items.push(...batch);
            if (batch.length === 0 || items.length >= Number(page.total ?? 0)) return items;
        }
    }

    /** Stream the book's file to sink. */
    async download(book: CloudBook, sink: (chunk: Uint8Array) => void): Promise<void> {
        if (!book.link) throw new PocketBookError(`no download link for ${book.title}`);
        const link = book.link;
        await this.authorized((headers) => stream(link, sink, headers));
    }

    /** Run call with auth headers; on a 401 treat the access token as expired and retry once. */
    private async authorized<T>(call: (headers: Record<string, string>) => Promise<T>): Promise<T> {
        for (let attempt = 1; ; attempt++) {
            const headers = { authorization: `Bearer ${await this.accessToken()}`, "cache-control": "no-cache" };
            try {
                return await call(headers);
            } catch (err) {
                if (!(err instanceof HttpError) || err.status !== 401 || attempt === 2) throw err;
                // Keep the old access token: renewing sends it along with the refresh token
                this.tokens.expiresAt = 0;
            }
        }
    }

    private async accessToken(): Promise<string> {
        if (this.tokens.accessToken && Date.now() < (this.tokens.expiresAt ?? 0)) return this.tokens.accessToken;
        if (this.tokens.accessToken && this.tokens.refreshToken) {
            try {
                return await this.renew();
            } catch (err) {
                if (!(err instanceof HttpError)) throw err;
                log.info(`PocketBook token renewal failed (HTTP ${err.status}), logging in again`);
            }
        }
        return this.login();
    }

    private async login(): Promise<string> {
        const query = new URLSearchParams({ username: this.email, client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
        const { providers = [] } = await requestJson<{ providers?: Provider[] }>("GET", `${this.base}/auth/login?${query}`)
            .catch((err: unknown) => {
                // Unknown emails get a 404 ("No one account has been found")
                if (err instanceof HttpError && err.status === 404) return { providers: [] };
                throw err;
            });
        const provider = this.pickProvider(providers);
        const tokens = await requestJson<TokenResponse>("POST", `${this.base}/auth/login/${encodeURIComponent(provider.alias)}`, {
            form: {
                shop_id: provider.shop_id || "1",
                username: this.email,
                password: this.password,
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: "password",
                language: "en",
            },
        });
        log.info(`logged into PocketBook Cloud (${provider.alias})`);
        return this.store(tokens);
    }

    private pickProvider(providers: Provider[]): Provider {
        if (providers.length === 0) throw new PocketBookError("PocketBook Cloud has no account for this email, check PB_EMAIL");
        if (this.shop) {
            const match = providers.find((p) => p.alias === this.shop || p.name === this.shop);
            if (!match) {
                const available = providers.map((p) => p.alias).join(", ");
                throw new PocketBookError(`PocketBook shop "${this.shop}" not found for this account, available: ${available}`);
            }
            return match;
        }
        if (providers.length > 1) log.warn(`account belongs to several PocketBook shops, using ${providers[0]!.alias}; set PB_SHOP to choose`);
        return providers[0]!;
    }

    private async renew(): Promise<string> {
        const tokens = await requestJson<TokenResponse>("POST", `${this.base}/auth/renew-token`, {
            headers: { authorization: `Bearer ${this.tokens.accessToken}` },
            form: { grant_type: "refresh_token", refresh_token: this.tokens.refreshToken! },
        });
        return this.store(tokens);
    }

    private store(tokens: TokenResponse): string {
        this.tokens.accessToken = tokens.access_token;
        this.tokens.refreshToken = tokens.refresh_token;
        this.tokens.expiresAt = Date.now() + Number(tokens.expires_in ?? 3600) * 1000 - EXPIRY_MARGIN_MS;
        return tokens.access_token;
    }
}
