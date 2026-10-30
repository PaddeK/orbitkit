import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Config } from "../../src/pocketbook-sync/config.ts";
import type { CloudBook } from "../../src/pocketbook-sync/pocketbook.ts";
import { State } from "../../src/pocketbook-sync/state.ts";
import { Bridge } from "../../src/pocketbook-sync/sync.ts";

export const PB = "/pb/api/v1.0";
export const BO = "/bo/api/v1/koreader";
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
            if (path.startsWith(`${PB}/files/`)) {
                if (!pbAuthorized(req)) return unauthorized();
                fake.downloads++;
                const file = fake.files.get(path.slice(`${PB}/files/`.length).split("/")[0]!);
                return file ? new Response(new Uint8Array(file)) : notFound();
            }
            if (path.startsWith(BO) && !boAuthorized(req)) return unauthorized();
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

    return Object.assign(fake, {
        origin,
        stop: () => server.stop(true),
        /** Add a book with random content; returns it and its KOReader hash. */
        addBook(title: string, options: Partial<CloudBook> = {}, data: Uint8Array = randomBytes(50_000)): CloudBook {
            const fastHash = md5(title);
            fake.files.set(fastHash, data);
            const book: CloudBook = {
                id: String(fake.books.length + 1),
                title,
                format: "epub",
                fast_hash: fastHash,
                md5_hash: md5(data, "base64"),
                read_percent: 0,
                read_status: "reading",
                mtime: "2026-10-28T23:15:29Z",
                metadata: { title, authors: "Some Author" },
                link: `${origin}${PB}/files/${fastHash}/signature-download/book.epub`,
                ...options,
            };
            fake.books.push(book);
            return book;
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
