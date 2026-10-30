import { download, HttpError, requestJson } from "./http.ts";

/** A BookOrbit login of the kind its apps use: the refresh token renews it without the password. */
export interface Session {
    accessToken?: string;
    /** Epoch milliseconds */
    expiresAt?: number;
    refreshToken?: string;
}

export interface Library {
    id: number;
    name: string;
}

export interface BookFile {
    id: number;
    format: string | null;
    role: string;
    sizeBytes: number | null;
}

export interface Book {
    id: number;
    libraryId: number;
    title: string | null;
    authors: string[];
    files: BookFile[];
}

export interface BookDetail {
    id: number;
    libraryId: number;
    /** With their paths inside the BookOrbit container */
    files: (BookFile & { absolutePath: string })[];
}

export type FieldType = "text" | "url" | "number" | "date" | "boolean";

export interface Field {
    id: number;
    label: string;
    type: FieldType;
    enabledLibraryIds: number[];
}

interface Credentials {
    accessToken: string;
    accessTokenExpiresAt: string;
    refreshToken: string;
    user?: { username: string };
}

const PAGE_SIZE = 200;
/** Renew this long before the access token runs out */
const EXPIRY_MARGIN_MS = 60_000;

/** Client for the parts of BookOrbit's web API orbitkit needs (base /api/v1). */
export class BookOrbit {
    private readonly api: string;
    private renewal?: Promise<string>;

    /** `onSession` is called whenever the session changes, to persist it: refresh tokens are single-use. */
    constructor(
        readonly url: string,
        private readonly user: string,
        private readonly password: string,
        private readonly session: Session,
        private readonly onSession: () => Promise<void>,
    ) {
        this.api = `${url}/api/v1`;
    }

    /** Log in if needed and return the user name. */
    async checkAuth(): Promise<string> {
        return (await this.authorized<{ username: string }>("GET", "/auth/me")).username;
    }

    libraries(): Promise<Library[]> {
        return this.authorized("GET", "/libraries");
    }

    /** Every book the user can see, with its files. */
    async books(): Promise<Book[]> {
        const books: Book[] = [];
        for (let page = 0; ; page++) {
            const result = await this.authorized<{ items: Book[]; total: number }>("POST", "/books/query", {
                sort: [{ field: "addedAt", dir: "asc" }],
                pagination: { page, size: PAGE_SIZE },
            });
            books.push(...result.items);
            if (result.items.length < PAGE_SIZE || books.length >= result.total) return books;
        }
    }

    fields(): Promise<Field[]> {
        return this.authorized("GET", "/custom-metadata/fields/active");
    }

    /** Needs the "Manage libraries" permission. */
    createField(label: string, type: FieldType, enabledLibraryIds: number[]): Promise<Field> {
        return this.authorized("POST", "/custom-metadata/fields", { label, type, enabledLibraryIds });
    }

    /** Needs the "Manage libraries" permission. */
    enableField(id: number, enabledLibraryIds: number[]): Promise<Field> {
        return this.authorized("PATCH", `/custom-metadata/fields/${id}`, { enabledLibraryIds });
    }

    book(bookId: number): Promise<BookDetail> {
        return this.authorized("GET", `/books/${bookId}`);
    }

    /**
     * Ask BookOrbit to scan a library, so it notices files changed on disk. False if a scan is already running.
     * Needs the "Manage libraries" permission.
     */
    async scanLibrary(libraryId: number): Promise<boolean> {
        try {
            await this.authorized("POST", `/scanner/libraries/${libraryId}/scan`);
            return true;
        } catch (err) {
            if (err instanceof HttpError && err.status === 409) return false;
            throw err;
        }
    }

    /** Set custom field values of a book; null removes a value. Other fields stay as they are. */
    async setFieldValues(bookId: number, values: { fieldId: number; value: string | number | null }[]): Promise<void> {
        await this.authorized("PATCH", `/books/${bookId}/metadata`, { customMetadata: values });
    }

    async download(fileId: number, maxBytes: number): Promise<{ bytes: Uint8Array; filename?: string }> {
        return this.withRetry(async () => download(`${this.api}/books/files/${fileId}/download`, maxBytes, await this.headers()));
    }

    private async authorized<T>(method: string, path: string, json?: unknown): Promise<T> {
        return this.withRetry(async () => requestJson<T>(method, `${this.api}${path}`, { headers: await this.headers(), json }));
    }

    /** Run a request; if BookOrbit rejects the token (revoked session, restarted server), log in again and retry once. */
    private async withRetry<T>(request: () => Promise<T>): Promise<T> {
        try {
            return await request();
        } catch (err) {
            if (!(err instanceof HttpError && err.status === 401)) throw err;
            this.session.expiresAt = 0;
            return request();
        }
    }

    private async headers(): Promise<Record<string, string>> {
        return { authorization: `Bearer ${await this.accessToken()}` };
    }

    private async accessToken(): Promise<string> {
        if (this.session.accessToken && (this.session.expiresAt ?? 0) > Date.now() + EXPIRY_MARGIN_MS) return this.session.accessToken;
        // The check loop and the report pages share the session: renew it once, since a refresh token works only once
        this.renewal ??= this.renew().finally(() => {
            this.renewal = undefined;
        });
        return this.renewal;
    }

    private async renew(): Promise<string> {
        let credentials: Credentials | undefined;
        if (this.session.refreshToken) {
            credentials = await requestJson<Credentials>("POST", `${this.api}/auth/refresh`, {
                json: { refreshToken: this.session.refreshToken },
            }).catch((err) => {
                // An expired or revoked refresh token: fall back to the password
                if (err instanceof HttpError && (err.status === 401 || err.status === 400)) return undefined;
                throw err;
            });
        }
        credentials ??= await this.login();
        this.session.accessToken = credentials.accessToken;
        this.session.expiresAt = Date.parse(credentials.accessTokenExpiresAt);
        this.session.refreshToken = credentials.refreshToken;
        await this.onSession();
        return credentials.accessToken;
    }

    private async login(): Promise<Credentials> {
        try {
            return await requestJson<Credentials>("POST", `${this.api}/auth/login`, {
                // "native" returns the refresh token in the body instead of a browser cookie
                json: { username: this.user, password: this.password, clientKind: "native", deviceLabel: "orbitkit" },
            });
        } catch (err) {
            if (err instanceof HttpError && err.status === 401) {
                throw new Error("BookOrbit login failed, check BOOKORBIT_USER and BOOKORBIT_PASSWORD");
            }
            throw err;
        }
    }
}
