import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Config } from "../../src/pocketbook-sync/config.ts";
import type { Book } from "../../src/bookorbit.ts";
import type { CloudBook } from "../../src/pocketbook-sync/pocketbook.ts";
import { State } from "../../src/pocketbook-sync/state.ts";
import { Bridge } from "../../src/pocketbook-sync/sync.ts";

export const PB = "/pb/api/v1.0";
export const BO = "/bo/api/v1/koreader";
export const BO_API = "/bo/api/v1";
export const API_KEY = "bok_test-key-0123456789";
const md5 = (data: string | Uint8Array, encoding: "hex" | "base64" = "hex") => createHash("md5").update(data).digest(encoding);

/** Real HTTP server mimicking PocketBook Cloud and BookOrbit's KOReader API. */
export function startFakeServices() {
    const fake = {
        email: "reader@example.com",
        password: "pb-secret",
        providers: [{ alias: "pocketbook_de", name: "Pocketbook.de", shop_id: "1" }],
        books: [] as CloudBook[],
        files: new Map<string, Uint8Array>(),
        accessToken: undefined as string | undefined,
        logins: 0,
        renewals: 0,
        downloads: 0,
        boUser: "reader",
        boKey: md5("bo-secret"),
        /** KOReader hashes BookOrbit knows */
        library: new Set<string>(),
        matchRequests: [] as { hashes: string[]; books: Record<string, unknown>[] }[],
        progress: [] as Record<string, unknown>[],
        /** Uploads to the cloud */
        uploads: [] as { name: string; source: string | null; bytes: number }[],
        /** Cloud collections and the fast hashes in them */
        collections: new Map<string, string[]>(),
        /** Answer uploads with 507, as a full account does */
        storageFull: false,
        /** BookOrbit's collections of the API key's owner */
        shelves: [] as { id: number; name: string; bookIds: number[] }[],
        /** BookOrbit's books, with their files */
        boBooks: [] as Book[],
        boFiles: new Map<number, { bytes: Uint8Array; name: string }>(),
        boDownloads: 0,
    };


    const tokenResponse = (token: string) => Response.json({ access_token: token, refresh_token: "refresh", expires_in: 7200 });
    const pbAuthorized = (req: Request) => !!fake.accessToken && req.headers.get("authorization") === `Bearer ${fake.accessToken}`;
    const boAuthorized = (req: Request) => req.headers.get("x-auth-user") === fake.boUser && req.headers.get("x-auth-key") === fake.boKey;
    const notFound = () => Response.json({ error_msg: "Page not found." }, { status: 404 });
    const unauthorized = () => Response.json({ message: "Unauthorized" }, { status: 401 });

    const server = Bun.serve({
        port: 0,
        async fetch(req) {
            const url = new URL(req.url);
            const path = url.pathname;
            if (path === `${PB}/auth/login`) {
                if (url.searchParams.get("username") !== fake.email) {
                    return Response.json({ error_code: 111, error_msg: "No one account has been found" }, { status: 404 });
                }
                return Response.json({ providers: fake.providers });
            }
            if (path.startsWith(`${PB}/auth/login/`)) {
                const form = new URLSearchParams(await req.text());
                if (form.get("username") !== fake.email || form.get("password") !== fake.password) return unauthorized();
                fake.logins++;
                fake.accessToken = `token-${fake.logins}`;
                return tokenResponse(fake.accessToken);
            }
            if (path === `${PB}/auth/renew-token`) {
                const form = new URLSearchParams(await req.text());
                if (!pbAuthorized(req) || form.get("refresh_token") !== "refresh") return unauthorized();
                fake.renewals++;
                fake.accessToken = `renewed-${fake.renewals}`;
                return tokenResponse(fake.accessToken);
            }
            if (path === `${PB}/books`) {
                if (!pbAuthorized(req)) return unauthorized();
                const offset = Number(url.searchParams.get("offset") ?? 0);
                const limit = Number(url.searchParams.get("limit") ?? 10);
                return Response.json({ total: fake.books.length, items: fake.books.slice(offset, offset + limit) });
            }
            if (path.startsWith(`${PB}/files/`) && req.method === "PUT") {
                if (!pbAuthorized(req)) return unauthorized();
                if (fake.storageFull) return Response.json({ error_code: 334, error_msg: "Reached maximum total files size (5 GB)" }, { status: 507 });
                // Like the real cloud: no chunks without PocketBook's fast hash, spaces become dashes
                if (url.searchParams.has("offset")) return Response.json({ error_code: 0, error_msg: "Param \"fast_hash\" for first chunk is required" }, { status: 400 });
                const name = decodeURIComponent(path.slice(`${PB}/files/`.length)).replaceAll(" ", "-");
                const bytes = new Uint8Array(await req.arrayBuffer());
                if ([...fake.files.values()].some((existing) => md5(existing) === md5(bytes))) {
                    return Response.json({ error_code: 303, error_msg: "File already exists" }, { status: 409 });
                }
                // The cloud's fast hash is the MD5 for small files, something else for big ones
                const fastHash = bytes.length < 1024 * 1024 ? md5(bytes) : md5(`fast ${md5(bytes)}`);
                fake.files.set(fastHash, bytes);
                fake.uploads.push({ name, source: url.searchParams.get("source"), bytes: bytes.length });
                fake.books.push(makeBook(name.replace(/\.[^.]+$/, ""), { fast_hash: fastHash }, bytes));
                return Response.json({ name, fast_hash: fastHash, md5_hash: btoa(fastHash), bytes: bytes.length, format: "epub" });
            }
            const collection = /^\/pb\/api\/v1\.0\/collections\/([^/]+)(\/files)?$/.exec(path);
            if (collection && req.method === "POST") {
                if (!pbAuthorized(req)) return unauthorized();
                const name = decodeURIComponent(collection[1]!);
                if (!collection[2]) {
                    if (fake.collections.has(name)) return Response.json({ error_code: 0, error_msg: "exists" }, { status: 409 });
                    fake.collections.set(name, []);
                    return Response.json({ name });
                }
                const files = fake.collections.get(name);
                if (!files) return Response.json({ error_code: 0, error_msg: "Collection not found" }, { status: 404 });
                const fastHash = url.searchParams.get("fast_hash")!;
                if (!fake.files.has(fastHash)) return Response.json({ error_code: 0, error_msg: "file not found" }, { status: 400 });
                if (!files.includes(fastHash)) files.push(fastHash);
                return new Response("OK", { headers: { "content-type": "text/html" } });
            }
            if (path.startsWith(`${PB}/files/`)) {
                if (!pbAuthorized(req)) return unauthorized();
                fake.downloads++;
                const file = fake.files.get(path.slice(`${PB}/files/`.length).split("/")[0]!);
                return file ? new Response(new Uint8Array(file)) : notFound();
            }
            if (path.startsWith(BO) && !boAuthorized(req)) return unauthorized();
            if (path.startsWith(BO_API) && !path.startsWith(BO)) {
                if (req.headers.get("authorization") !== `Bearer ${API_KEY}`) return unauthorized();
                if (path === `${BO_API}/auth/me`) return Response.json({ username: "reader", authenticationMethod: "api_key" });
                if (path === `${BO_API}/collections`) return Response.json(fake.shelves.map(({ id, name }) => ({ id, name })));
                const shelf = /^\/bo\/api\/v1\/collections\/(\d+)\/books\/query$/.exec(path);
                if (shelf && req.method === "POST") {
                    const found = fake.shelves.find((s) => s.id === Number(shelf[1]));
                    if (!found) return notFound();
                    const { pagination } = (await req.json()) as { pagination: { page: number; size: number } };
                    const items = found.bookIds.map((id) => fake.boBooks.find((b) => b.id === id)!);
                    return Response.json({ items: items.slice(pagination.page * pagination.size, (pagination.page + 1) * pagination.size), total: items.length });
                }
                const file = /^\/bo\/api\/v1\/books\/files\/(\d+)\/download$/.exec(path);
                if (file) {
                    const found = fake.boFiles.get(Number(file[1]));
                    if (!found) return notFound();
                    fake.boDownloads++;
                    return new Response(new Uint8Array(found.bytes), { headers: { "content-disposition": `attachment; filename="${found.name}"` } });
                }
                return notFound();
            }
            if (path === `${BO}/users/auth`) return Response.json({ authorized: "OK", username: fake.boUser });
            if (path === `${BO}/plugin/match-check`) {
                const body = (await req.json()) as (typeof fake.matchRequests)[number];
                fake.matchRequests.push(body);
                const matches = body.hashes.filter((h) => fake.library.has(h)).map((hash) => ({ hash, bookId: 1, bookFileId: 1 }));
                return Response.json({ matches, libraryVersion: "1" });
            }
            if (path === `${BO}/syncs/progress` && req.method === "PUT") {
                const body = (await req.json()) as { document: string };
                if (!fake.library.has(body.document)) return Response.json({ message: "Book not found" }, { status: 404 });
                fake.progress.push(body);
                return Response.json({ document: body.document });
            }
            return notFound();
        },
    });
    const origin = `http://127.0.0.1:${server.port}`;

    /** A cloud book as listed: md5_hash holds the fast_hash, as the real cloud does since November 2026 */
    function makeBook(title: string, options: Partial<CloudBook>, data: Uint8Array): CloudBook {
        const fastHash = options.fast_hash ?? md5(title);
        return {
            id: String(fake.books.length + 1),
            title,
            format: "epub",
            fast_hash: fastHash,
            md5_hash: btoa(fastHash),
            bytes: data.length,
            read_percent: 0,
            read_status: "reading",
            mtime: "2026-10-28T23:15:29Z",
            metadata: { title, authors: "Some Author" },
            link: `${origin}${PB}/files/${fastHash}/signature-download/book.epub`,
            ...options,
        };
    }

    return Object.assign(fake, {
        origin,
        stop: () => server.stop(true),
        /** Add a book with random content; returns it and its KOReader hash. */
        addBook(title: string, options: Partial<CloudBook> = {}, data: Uint8Array = randomBytes(50_000)): CloudBook {
            const book = makeBook(title, options, data);
            fake.files.set(book.fast_hash, data);
            fake.books.push(book);
            return book;
        },
        /** Add a book to BookOrbit with one file per format; returns it and the bytes of each file by format. */
        addBoBook(title: string, formats: string[] = ["epub"], size = 50_000) {
            const id = fake.boBooks.length + 1;
            const bytes: Record<string, Uint8Array> = {};
            const files = formats.map((format, i) => {
                const fileId = id * 100 + i;
                bytes[format] = randomBytes(size);
                fake.boFiles.set(fileId, { bytes: bytes[format]!, name: `${title}.${format}` });
                return { id: fileId, format, role: i === 0 ? "primary" : "content", sizeBytes: size };
            });
            const book: Book = { id, libraryId: 1, title, authors: ["Some Author"], files };
            fake.boBooks.push(book);
            return { book, bytes };
        },
    });
}

export type FakeServices = ReturnType<typeof startFakeServices>;

export function makeConfig(fake: FakeServices, dataDir: string, overrides: Partial<Config> = {}): Config {
    return {
        pbEmail: fake.email,
        pbPassword: fake.password,
        pbUrl: fake.origin + PB,
        bookorbitUrl: `${fake.origin}/bo`,
        koreaderUser: "reader",
        koreaderPassword: "bo-secret",
        deviceName: "PocketBook Era Color",
        syncInterval: 300,
        dataDir,
        dryRun: false,
        ...overrides,
    };
}

export interface TestEnv {
    dir: string;
    /** A bridge on a fresh state, or on the state left by an earlier bridge in this env */
    bridge(overrides?: Partial<Config>): Promise<Bridge>;
    cleanup(): Promise<void>;
}

export async function makeEnv(fake: FakeServices): Promise<TestEnv> {
    const dir = await mkdtemp(`${tmpdir()}/pocketorbit-test-`);
    return {
        dir,
        bridge: async (overrides) => new Bridge(makeConfig(fake, dir, overrides), await State.open(dir)),
        cleanup: () => rm(dir, { recursive: true, force: true }),
    };
}
