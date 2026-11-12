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

/** A collection in BookOrbit; each belongs to one user. */
export interface Collection {
    id: number;
    name: string;
}

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

/** How orbitkit signs in: as a user with a password, like BookOrbit's apps, or with an API key (BookOrbit 3.8+). */
export type Auth =
    | {
        user: string;
        password: string;
        session: Session;
        /** Called whenever the session changes, to persist it: refresh tokens are single-use */
        onSession: () => Promise<void>;
    }
    | { apiKey: string };

const PAGE_SIZE = 200;
/** BookOrbit's limit for collection pages */
const COLLECTION_PAGE_SIZE = 100;
/** Renew this long before the access token runs out */
const EXPIRY_MARGIN_MS = 60_000;

/** Client for the parts of BookOrbit's web API orbitkit needs (base /api/v1). */
export class BookOrbit {
    private readonly api: string;
    private renewal?: Promise<string>;

    constructor(readonly url: string, private readonly auth: Auth) {
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
    books(): Promise<Book[]> {
        return this.queryAll("/books/query", PAGE_SIZE, [{ field: "addedAt", dir: "asc" }]);
    }

    /** The user's own collections and the public ones of others. */
    collections(): Promise<Collection[]> {
        return this.authorized("GET", "/collections");
    }

    /** The books of a collection in its order, with their files. */
    collectionBooks(collectionId: number): Promise<Book[]> {
        return this.queryAll(`/collections/${collectionId}/books/query`, COLLECTION_PAGE_SIZE, [{ field: "collectionOrder", dir: "asc" }]);
    }

    private async queryAll(path: string, size: number, sort: { field: string; dir: "asc" | "desc" }[]): Promise<Book[]> {
        const books: Book[] = [];
        for (let page = 0; ; page++) {
            const result = await this.authorized<{ items: Book[]; total: number }>("POST", path, { sort, pagination: { page, size } });
            books.push(...result.items);
            if (result.items.length < size || books.length >= result.total) return books;
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
            // A refused key stays refused
            if ("apiKey" in this.auth) throw new HttpError(401, "BookOrbit refused the API key: it may be revoked or expired, or API keys are turned off", `${this.api}/`);
            this.auth.session.expiresAt = 0;
            return request();
        }
    }

    private async headers(): Promise<Record<string, string>> {
        return { authorization: `Bearer ${"apiKey" in this.auth ? this.auth.apiKey : await this.accessToken()}` };
    }

    private async accessToken(): Promise<string> {
        const auth = this.passwordAuth();
        if (auth.session.accessToken && (auth.session.expiresAt ?? 0) > Date.now() + EXPIRY_MARGIN_MS) return auth.session.accessToken;
        // The check loop and the report pages share the session: renew it once, since a refresh token works only once
        this.renewal ??= this.renew().finally(() => {
            this.renewal = undefined;
        });
        return this.renewal;
    }

    private passwordAuth(): Extract<Auth, { password: string }> {
        if ("apiKey" in this.auth) throw new Error("signed in with an API key");
        return this.auth;
    }

    private async renew(): Promise<string> {
        const { session, onSession } = this.passwordAuth();
        let credentials: Credentials | undefined;
        if (session.refreshToken) {
            credentials = await requestJson<Credentials>("POST", `${this.api}/auth/refresh`, {
                json: { refreshToken: session.refreshToken },
            }).catch((err) => {
                // An expired or revoked refresh token: fall back to the password
                if (err instanceof HttpError && (err.status === 401 || err.status === 400)) return undefined;
                throw err;
            });
        }
        credentials ??= await this.login();
        session.accessToken = credentials.accessToken;
        session.expiresAt = Date.parse(credentials.accessTokenExpiresAt);
        session.refreshToken = credentials.refreshToken;
        await onSession();
        return credentials.accessToken;
    }

    private async login(): Promise<Credentials> {
        const { user, password } = this.passwordAuth();
        try {
            return await requestJson<Credentials>("POST", `${this.api}/auth/login`, {
                // "native" returns the refresh token in the body instead of a browser cookie
                json: { username: user, password, clientKind: "native", deviceLabel: "orbitkit" },
            });
        } catch (err) {
            if (err instanceof HttpError && err.status === 401) {
                throw new Error("BookOrbit login failed, check BOOKORBIT_USER and BOOKORBIT_PASSWORD");
            }
            throw err;
        }
    }
}
