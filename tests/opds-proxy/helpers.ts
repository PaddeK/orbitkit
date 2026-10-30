import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createApp, type App, type AppOptions } from "../../src/opds-proxy/server.ts";
import { Store } from "../../src/opds-proxy/store.ts";

const FIXTURES = `${import.meta.dir}/fixtures`;
export const BOOK = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(1000).fill(120)]);
const basic = (user: string, pass: string) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
export const AUTH = basic("test", "password");
/** Second upstream user, to check that each reader URL logs in as its own account */
export const AUTH_ANNA = basic("anna", "secret2");
const ATOM_TYPE = "application/atom+xml;profile=opds-catalog;kind=navigation; charset=utf-8";

/** Real HTTP server mimicking BookOrbit's OPDS endpoints, including mandatory Basic auth. */
export function startFakeBookOrbit() {
    const requests: Request[] = [];
    const feeds: Record<string, string> = {
        "/api/v1/opds": "bookorbit_root.xml",
        "/api/v1/opds/recent": "bookorbit_recent.xml",
        "/api/v1/opds/catalog": "bookorbit_recent.xml",
        "/api/v1/opds/authors": "bookorbit_authors.xml",
    };
    const server = Bun.serve({
        port: 0,
        async fetch(req) {
            requests.push(req);
            const url = new URL(req.url);
            if (url.pathname === "/public/opds") {
                return new Response(Bun.file(`${FIXTURES}/bookorbit_root.xml`), { headers: { "content-type": ATOM_TYPE } });
            }
            const auth = req.headers.get("authorization");
            if (auth !== AUTH && auth !== AUTH_ANNA) {
                return Response.json({ statusCode: 401, message: "Basic authentication required" },
                    { status: 401, headers: { "www-authenticate": 'Basic realm="bookorbit OPDS"' } });
            }
            const feed = feeds[url.pathname];
            if (feed) return new Response(Bun.file(`${FIXTURES}/${feed}`), { headers: { "content-type": ATOM_TYPE } });
            if (url.pathname === "/api/v1/opds/search.opds") {
                return new Response(Bun.file(`${FIXTURES}/bookorbit_osd.xml`),
                    { headers: { "content-type": "application/opensearchdescription+xml; charset=utf-8" } });
            }
            if (url.pathname === "/api/v1/opds/1/cover" || url.pathname === "/api/v1/opds/1/thumbnail") {
                return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x20]), { headers: { "content-type": "image/jpeg" } });
            }
            if (url.pathname === "/api/v1/opds/1/download") {
                if (url.searchParams.get("selection") !== "SIGNED.TOKEN_1") return Response.json({ message: "bad selection" }, { status: 403 });
                const headers: Record<string, string> = {
                    "content-type": "application/epub+zip",
                    "accept-ranges": "bytes",
                    "content-disposition": 'attachment; filename="Moby Dick.epub"',
                };
                const range = req.headers.get("range");
                if (range) {
                    const [start, end] = range.replace("bytes=", "").split("-").map(Number) as [number, number];
                    headers["content-range"] = `bytes ${start}-${end}/${BOOK.length}`;
                    return new Response(BOOK.slice(start, end + 1), { status: 206, headers });
                }
                return new Response(BOOK, { headers });
            }
            if (url.pathname === "/api/v1/opds/nodisposition.epub") {
                return new Response(BOOK, { headers: { "content-type": "application/epub+zip" } });
            }
            if (url.pathname === "/api/v1/opds/old") return Response.redirect("/api/v1/opds/recent", 302);
            return new Response("not found", { status: 404 });
        },
    });
    return { url: `http://127.0.0.1:${server.port}/api/v1/opds`, requests, stop: () => server.stop(true) };
}

export const TOKEN = "abcd-efgh-jkmn-pqrs";
export const TOKEN_ANNA = "anna-anna-anna-anna";
export const READER_ORIGIN = "http://192.168.0.10:8601";

export interface TestEnv {
    app: App;
    store: Store;
    dir: string;
    call(path: string, init?: RequestInit): Promise<Response>;
    cleanup(): Promise<void>;
}

/** App with a temp data dir and one server at `upstreamUrl` with two accounts: test (via TOKEN) and anna (via TOKEN_ANNA). */
export async function makeEnv(upstreamUrl: string, opts: Partial<AppOptions> & { password?: string } = {}): Promise<TestEnv> {
    const dir = await mkdtemp(`${tmpdir()}/opds-proxy-test-`);
    const store = await Store.open(dir);
    await store.update((c) => {
        const createdAt = new Date().toISOString();
        c.servers.push({
            id: "srv1", name: "BookOrbit", upstreamUrl, accounts: [
                { id: "acc1", username: "test", password: opts.password ?? "password",
                    tokens: [{ id: "tok1", token: TOKEN, label: "PocketBook Era", createdAt }] },
                { id: "acc2", username: "anna", password: "secret2",
                    tokens: [{ id: "tok2", token: TOKEN_ANNA, label: "Anna's Kobo", createdAt }] },
            ],
        });
    });
    const app = createApp({ store, ...opts });
    return {
        app, store, dir,
        call: (path, init) => app.fetch(new Request(READER_ORIGIN + path, init)),
        cleanup: async () => {
            await store.flush();
            await rm(dir, { recursive: true, force: true });
        },
    };
}
