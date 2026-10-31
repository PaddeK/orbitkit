import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { elements, localName, parseXml } from "../../src/opds-proxy/proxy/rewrite.ts";
import { BOOK, READER_ORIGIN, TOKEN, type TestEnv, makeEnv, startFakeBookOrbit } from "./helpers.ts";

let upstream: ReturnType<typeof startFakeBookOrbit>;
let env: TestEnv;

beforeAll(() => {
    upstream = startFakeBookOrbit();
});
afterAll(() => upstream.stop());
beforeEach(async () => {
    upstream.requests.length = 0;
    env = await makeEnv(upstream.url);
});
afterEach(() => env.cleanup());

const hrefs = (xml: string) => [...elements(parseXml(xml))].filter((e) => localName(e) === "link").map((l) => l.attributes.href!);
const lastUpstreamUrl = () => upstream.requests.at(-1)!.url.replace(new URL(upstream.url).origin, "");

test.each(["/api/v1/opds", "/wrong-token/", `/${TOKEN}x/`, "/abcd-efgh-jkmn-pqrz/recent"])("requires a valid token: %s", async (path) => {
    expect((await env.call(path)).status).toBe(404);
    expect(upstream.requests).toHaveLength(0);
});

test.each([`/${TOKEN}`, `/${TOKEN}/`, `/${TOKEN.toUpperCase()}/`])("serves the rewritten root feed at %s", async (path) => {
    const r = await env.call(path);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/atom+xml; charset=utf-8");
    expect(lastUpstreamUrl()).toBe("/api/v1/opds");
    const body = await r.text();
    const links = hrefs(body);
    expect(links).toContain(`${READER_ORIGIN}/${TOKEN}/recent`);
    expect(links.every((h) => h.startsWith(`${READER_ORIGIN}/${TOKEN}/`))).toBe(true);
    expect(body).not.toContain("127.0.0.1");
    expect(r.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));
});

test("every link is reachable, like a reader crawling the catalog", async () => {
    const seen = new Set<string>();
    const queue = [`${READER_ORIGIN}/${TOKEN}/`];
    const unserved = /\/(surprise|libraries|collections|smart-scopes|series)$/; // not implemented by the fake
    while (queue.length) {
        const url = queue.pop()!;
        if (seen.has(url) || url.includes("{searchTerms}")) continue;
        seen.add(url);
        expect(url.startsWith(`${READER_ORIGIN}/${TOKEN}/`)).toBe(true);
        const r = await env.call(url.slice(READER_ORIGIN.length));
        if (unserved.test(new URL(url).pathname)) continue;
        expect([url, r.status]).toEqual([url, 200]);
        if (r.headers.get("content-type")!.includes("atom+xml")) queue.push(...hrefs(await r.text()));
        else await r.arrayBuffer();
    }
    expect([...seen].some((u) => u.endsWith(".epub"))).toBe(true);
    expect([...seen].some((u) => u.endsWith("/thumbnail.jpg"))).toBe(true);
});

test("search and encoded queries are forwarded verbatim", async () => {
    expect((await env.call(`/${TOKEN}/catalog?q=moby%20dick`)).status).toBe(200);
    expect(lastUpstreamUrl()).toBe("/api/v1/opds/catalog?q=moby%20dick");
    await env.call(`/${TOKEN}/catalog?author=Melville%2C%20Herman`);
    expect(lastUpstreamUrl()).toBe("/api/v1/opds/catalog?author=Melville%2C%20Herman");
});

test("OpenSearch description is rewritten", async () => {
    const r = await env.call(`/${TOKEN}/search.opds`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toStartWith("application/opensearchdescription+xml");
    expect(await r.text()).toContain(`template="${READER_ORIGIN}/${TOKEN}/catalog?q={searchTerms}"`);
});

async function bookPath(): Promise<string> {
    const feed = await (await env.call(`/${TOKEN}/recent`)).text();
    return new URL(hrefs(feed).find((h) => h.endsWith(".epub"))!).pathname;
}

test("downloads stream through with headers intact", async () => {
    const r = await env.call(await bookPath());
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(BOOK);
    expect(r.headers.get("content-type")).toBe("application/epub+zip");
    expect(r.headers.get("content-length")).toBe(String(BOOK.length));
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="Moby Dick.epub"');
});

test("HEAD on a download returns headers only", async () => {
    const r = await env.call(await bookPath(), { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-length")).toBe(String(BOOK.length));
    expect((await r.arrayBuffer()).byteLength).toBe(0);
});

test("range requests are forwarded", async () => {
    const r = await env.call(await bookPath(), { headers: { range: "bytes=0-3" } });
    expect(r.status).toBe(206);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(BOOK.slice(0, 4));
    expect(r.headers.get("content-range")).toBe(`bytes 0-3/${BOOK.length}`);
});

test("files without Content-Disposition get the filename from the URL", async () => {
    const { UrlMapper } = await import("../../src/opds-proxy/proxy/mapper.ts");
    const path = new URL(new UrlMapper(upstream.url, `${READER_ORIGIN}/${TOKEN}`).fileUrl("/nodisposition.epub", "Über Buch.epub")).pathname;
    const r = await env.call(path);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toBe(`attachment; filename="_ber Buch.epub"; filename*=UTF-8''%C3%9Cber%20Buch.epub`);
});

test("wrong upstream credentials are reported as 502", async () => {
    const bad = await makeEnv(upstream.url, { password: "wrong" });
    const r = await bad.call(`/${TOKEN}/`);
    expect(r.status).toBe(502);
    expect(await r.text()).toContain("credentials");
    expect(bad.app.activity.recent(1)[0]!.note).toContain("upstream-auth-failed");
    await bad.cleanup();
});

test("unreachable upstream is reported as 502", async () => {
    const dead = await makeEnv("http://127.0.0.1:1/api/v1/opds");
    expect((await dead.call(`/${TOKEN}/`)).status).toBe(502);
    await dead.cleanup();
});

test.each(["/../users", "/%2e%2e/users", "/a/%2E%2E/%2E%2E/admin", "/_f/Ly4uL2FkbWlu/x.epub"])(
    "cannot escape the OPDS subtree: %s", async (path) => {
        // Either rejected, or URL normalization resolved the dots before routing (e.g. to /admin -> login)
        const r = await env.call(`/${TOKEN}${path}`);
        expect([303, 400, 404]).toContain(r.status);
        for (const req of upstream.requests) expect(new URL(req.url).pathname).toStartWith("/api/v1/opds");
    });

test("redirects are rewritten", async () => {
    const r = await env.call(`/${TOKEN}/old`);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`${READER_ORIGIN}/${TOKEN}/recent`);
});

test("PUBLIC_URL overrides the Host header", async () => {
    const e = await makeEnv(upstream.url, { publicUrl: "https://books.example.org" });
    expect(hrefs(await (await e.call(`/${TOKEN}/`)).text())).toContain(`https://books.example.org/${TOKEN}/recent`);
    await e.cleanup();
});

test("links keep the reader's https behind a proxy that ends TLS (X-Forwarded-Proto)", async () => {
    const host = new URL(READER_ORIGIN).host;
    const links = async (headers: Record<string, string>) => hrefs(await (await env.call(`/${TOKEN}/`, { headers })).text());
    expect(await links({ "x-forwarded-proto": "https" })).toContain(`https://${host}/${TOKEN}/recent`);
    expect(await links({ "x-forwarded-proto": "https, http" })).toContain(`https://${host}/${TOKEN}/recent`);
    // Anything else is ignored
    expect(await links({ "x-forwarded-proto": "javascript" })).toContain(`${READER_ORIGIN}/${TOKEN}/recent`);
});

test("reader activity is recorded with the token masked", async () => {
    await env.call(`/${TOKEN}/recent`, { headers: { "user-agent": "PocketBook" } });
    const [entry] = env.app.activity.recent(1);
    expect(entry).toMatchObject({ path: "/***/recent", status: 200, userAgent: "PocketBook", tokenLabel: "PocketBook Era" });
    expect(env.store.findToken(TOKEN)!.token.lastUserAgent).toBe("PocketBook");
});

test("only GET and HEAD are proxied", async () => {
    expect((await env.call(`/${TOKEN}/`, { method: "POST" })).status).toBe(404);
    expect(upstream.requests).toHaveLength(0);
});

test("healthz and root redirect", async () => {
    expect(await (await env.call("/healthz")).text()).toBe("ok");
    const r = await env.call("/");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/admin");
});

test("file paths are shortened in the activity log", async () => {
    await env.call(await bookPath());
    expect(env.app.activity.recent(1)[0]!.path).toBe("/***/_f/…/Moby%20Dick%3B%20or%2C%20The%20Whale.epub");
});

test("each reader URL logs in upstream as its own account", async () => {
    const { AUTH, AUTH_ANNA, TOKEN_ANNA } = await import("./helpers.ts");
    await env.call(`/${TOKEN}/recent`);
    expect(upstream.requests.at(-1)!.headers.get("authorization")).toBe(AUTH);
    await env.call(`/${TOKEN_ANNA}/recent`);
    expect(upstream.requests.at(-1)!.headers.get("authorization")).toBe(AUTH_ANNA);
    expect(env.app.activity.recent(1)[0]).toMatchObject({ tokenLabel: "Anna's Kobo", accountName: "anna" });
    // Links in Anna's feed keep Anna's token
    const body = await (await env.call(`/${TOKEN_ANNA}/`)).text();
    expect(body).toContain(`${READER_ORIGIN}/${TOKEN_ANNA}/recent`);
    expect(body).not.toContain(TOKEN);
});

test("anonymous accounts send no credentials", async () => {
    await env.store.update((c) => {
        c.servers.push({ id: "srv2", name: "Public", upstreamUrl: upstream.url.replace("/api/v1/opds", "/public/opds"), accounts: [
            { id: "acc3", username: "", password: "", tokens: [{ id: "tok3", token: "publ-icpu-blic-publ", label: "x", createdAt: "" }] },
        ] });
    });
    expect((await env.call("/publ-icpu-blic-publ/")).status).toBe(200);
    expect(upstream.requests.at(-1)!.headers.get("authorization")).toBeNull();
});

test("activity records the full path and the upstream URL", async () => {
    const path = await bookPath();
    await env.call(path);
    const entry = env.app.activity.recent(1)[0]!;
    expect(entry.fullPath).toBe("/***" + path.slice(TOKEN.length + 1));
    expect(entry.upstreamUrl).toBe(upstream.url + "/1/download?fileId=1&selection=SIGNED.TOKEN_1");
    expect(entry).toMatchObject({ serverName: "BookOrbit", accountName: "test" });
});
