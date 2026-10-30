import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createApp, type App } from "../../src/opds-proxy/server.ts";
import { Store, type Upstream } from "../../src/opds-proxy/store.ts";
import type { CheckResult } from "../../src/opds-proxy/proxy/check.ts";

const ORIGIN = "http://192.168.0.10:8601";
const SETUP_CODE = "abcd-efgh";
const PASSWORD = "correct horse";
const OPDS_URL = "http://bookorbit:3000/api/v1/opds";

let dir: string;
let store: Store;
let app: App;
let cookie = "";
const checks: Upstream[] = [];
let checkOk = true;

beforeEach(async () => {
    dir = await mkdtemp(`${tmpdir()}/opds-proxy-admin-`);
    store = await Store.open(dir);
    cookie = "";
    checks.length = 0;
    checkOk = true;
    app = createApp({
        store,
        setupCode: SETUP_CODE,
        check: async (u): Promise<CheckResult> => {
            checks.push(u);
            return checkOk
                ? { ok: true, message: `Connected as ${u.username}`, at: new Date().toISOString() }
                : { ok: false, message: "The server rejected the login (HTTP 401).", at: new Date().toISOString() };
        },
    });
});
afterEach(async () => {
    await store.flush();
    await rm(dir, { recursive: true, force: true });
});

/** Sends what a browser sends for a same-origin form post unless headers override it. */
async function call(path: string, init: RequestInit & { form?: Record<string, string> } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (cookie) headers.set("cookie", cookie);
    let body = init.body;
    if (init.form) {
        body = new URLSearchParams(init.form);
        headers.set("content-type", "application/x-www-form-urlencoded");
        if (!headers.has("origin")) headers.set("origin", ORIGIN);
    }
    const r = await app.fetch(new Request(ORIGIN + path, { method: init.form ? "POST" : init.method, headers, body }));
    const setCookie = r.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0]!;
    return r;
}

const post = (path: string, form: Record<string, string> = {}, headers?: Record<string, string>) => call(path, { form, headers });
const page = async (path: string) => (await call(path)).text();

async function setUp(): Promise<void> {
    const r = await post("/admin/setup", { code: SETUP_CODE, password: PASSWORD, confirm: PASSWORD });
    expect(r.status).toBe(303);
}

async function addServer(name = "BookOrbit", username = "pb", password = "secret"): Promise<string> {
    const r = await post("/admin/servers", { name, upstreamUrl: OPDS_URL + "/", username, password });
    expect(r.status).toBe(303);
    return r.headers.get("location")!.match(/\/admin\/servers\/([\w-]+)/)![1]!;
}

async function addAccount(serverId: string, username: string, password = "pw"): Promise<Response> {
    return post(`/admin/servers/${serverId}/accounts`, { username, password });
}

async function createToken(serverId: string, accountId: string, label: string) {
    const r = await post(`/admin/servers/${serverId}/accounts/${accountId}/tokens`, { label });
    expect(r.status).toBe(303);
    return store.server(serverId)!.accounts.find((a) => a.id === accountId)!.tokens.at(-1)!;
}

// --- admin login ----------------------------------------------------------------

test("first start forces setup with the code from the log", async () => {
    expect((await call("/admin")).headers.get("location")).toBe("/admin/setup");
    expect((await call("/admin/login")).headers.get("location")).toBe("/admin/setup");
    expect(await page("/admin/setup")).toContain('name="code"');

    expect((await post("/admin/setup", { code: "wrong-code", password: PASSWORD, confirm: PASSWORD })).status).toBe(403);
    expect((await post("/admin/setup", { code: SETUP_CODE, password: PASSWORD, confirm: "different" })).status).toBe(400);
    expect((await post("/admin/setup", { code: SETUP_CODE, password: "short", confirm: "short" })).status).toBe(400);
    expect(store.config.adminPasswordHash).toBeUndefined();

    // Code is case-insensitive, like reader tokens
    const r = await post("/admin/setup", { code: SETUP_CODE.toUpperCase(), password: PASSWORD, confirm: PASSWORD });
    expect(r.status).toBe(303);
    expect(r.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    expect((await call("/admin")).status).toBe(200);
    expect((await call("/admin/setup")).headers.get("location")).toBe("/admin"); // can't be repeated
});

test("login, logout and brute-force lockout", async () => {
    await setUp();
    await post("/admin/logout");
    cookie = "";
    expect((await call("/admin")).headers.get("location")).toBe("/admin/login");
    expect((await post("/admin/login", { password: "nope" })).status).toBe(401);
    expect((await post("/admin/login", { password: PASSWORD })).status).toBe(303);
    expect((await call("/admin")).status).toBe(200);

    cookie = "";
    for (let i = 0; i < 5; i++) expect((await post("/admin/login", { password: "nope" })).status).toBe(401);
    const locked = await post("/admin/login", { password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(await locked.text()).toContain("Too many failed attempts");
});

test("protected routes need a session", async () => {
    await setUp();
    cookie = "";
    expect((await call("/admin/settings")).headers.get("location")).toBe("/admin/login");
    expect((await post("/admin/servers", { name: "x", upstreamUrl: OPDS_URL })).status).toBe(401);
    cookie = "opds_admin=99999999999999.forged";
    expect((await call("/admin")).headers.get("location")).toBe("/admin/login");
    expect(store.servers).toHaveLength(0);
});

// --- cross-site protection --------------------------------------------------------

test("form posts from a real browser are accepted", async () => {
    // What Chrome sends for a same-origin form post: Sec-Fetch-Site, and Origin may be "null"
    // depending on the Referrer-Policy. This used to be rejected.
    const browser = { origin: "null", "sec-fetch-site": "same-origin" };
    expect((await post("/admin/setup", { code: SETUP_CODE, password: PASSWORD, confirm: PASSWORD }, browser)).status).toBe(303);
    cookie = "";
    expect((await post("/admin/login", { password: PASSWORD }, { "sec-fetch-site": "same-origin", origin: "http://localhost:8601" })).status).toBe(303);
});

test.each([
    [{ origin: "http://evil.example" }],
    [{ "sec-fetch-site": "cross-site", origin: ORIGIN }],
    [{ "sec-fetch-site": "same-site" }],
    [{ origin: "null" }],
])("cross-site form posts are rejected: %p", async (headers) => {
    await setUp();
    expect((await post("/admin/servers", { name: "x", upstreamUrl: OPDS_URL }, headers)).status).toBe(403);
    expect(store.servers).toHaveLength(0);
});

test("the admin pages don't suppress the Origin header", async () => {
    expect((await call("/admin/setup")).headers.get("referrer-policy")).toBe("same-origin");
});

// --- servers, accounts, reader URLs --------------------------------------------

test("server lifecycle: add with first account, create reader URL, revoke, remove", async () => {
    await setUp();
    const id = await addServer();
    const server = store.server(id)!;
    expect(server).toMatchObject({ name: "BookOrbit", upstreamUrl: OPDS_URL }); // trailing slash normalised
    expect(server.accounts).toHaveLength(1);
    expect(server.accounts[0]).toMatchObject({ username: "pb", password: "secret", tokens: [] });
    expect(checks.map((c) => c.username)).toEqual(["pb"]); // login tested on save

    const html = await page(`/admin/servers/${id}`);
    expect(html).toContain('class="card account ok"');
    expect(html).toContain('aria-label="Connected"');
    expect(html).toContain('title="Connected as pb (checked just now)"');
    expect(html).not.toContain("secret"); // stored password is never rendered

    const token = await createToken(id, server.accounts[0]!.id, "PocketBook Era");
    expect(token.token).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    expect(await page(`/admin/servers/${id}`)).toContain(`${ORIGIN}/${token.token}/`);
    expect(store.findToken(token.token.toUpperCase())?.account.username).toBe("pb");

    await post(`/admin/servers/${id}/accounts/${server.accounts[0]!.id}/tokens/${token.id}/delete`);
    expect(store.findToken(token.token)).toBeUndefined();
    expect((await app.fetch(new Request(`${ORIGIN}/${token.token}/`))).status).toBe(404);

    expect((await post(`/admin/servers/${id}/delete`)).headers.get("location")).toBe("/admin?flash=server-removed");
    expect(store.servers).toHaveLength(0);
});

test("several servers side by side", async () => {
    await setUp();
    const a = await addServer("BookOrbit");
    const b = await addServer("Calibre-Web", "", "");
    expect(store.servers.map((s) => s.name)).toEqual(["BookOrbit", "Calibre-Web"]);
    expect(store.server(b)!.accounts[0]!.username).toBe("");
    const dashboard = await page("/admin");
    expect(dashboard).toContain(`/admin/servers/${a}`);
    expect(dashboard).toContain(`/admin/servers/${b}`);
    expect(await page(`/admin/servers/${b}`)).toContain("Anonymous access");
});

test("reader URLs belong to accounts", async () => {
    await setUp();
    const id = await addServer("BookOrbit", "alice", "pw1");
    expect((await addAccount(id, "anna", "pw2")).status).toBe(303);
    const [alice, anna] = store.server(id)!.accounts;
    expect(checks.map((c) => c.username)).toEqual(["alice", "anna"]);

    const t1 = await createToken(id, alice!.id, "PocketBook Era");
    const t2 = await createToken(id, anna!.id, "Kobo");
    expect(store.findToken(t1.token)!.account.username).toBe("alice");
    expect(store.findToken(t2.token)!.account).toMatchObject({ username: "anna", password: "pw2" });

    // Removing an account revokes its reader URLs, the others keep working
    await post(`/admin/servers/${id}/accounts/${anna!.id}/delete`);
    expect(store.findToken(t2.token)).toBeUndefined();
    expect(store.findToken(t1.token)).toBeDefined();
});

test("duplicate accounts on one server are rejected", async () => {
    await setUp();
    const id = await addServer("BookOrbit", "alice");
    const r = await addAccount(id, "alice");
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("already has an account for alice");
    await addAccount(id, "");
    expect((await addAccount(id, "")).status).toBe(400);
    expect(store.server(id)!.accounts.map((a) => a.username)).toEqual(["alice", ""]);
});

test("editing an account keeps the password unless a new one is entered", async () => {
    await setUp();
    const id = await addServer();
    const acc = store.server(id)!.accounts[0]!;
    await post(`/admin/servers/${id}/accounts/${acc.id}`, { username: "pb2", password: "" });
    expect(acc).toMatchObject({ username: "pb2", password: "secret" });
    await post(`/admin/servers/${id}/accounts/${acc.id}`, { username: "pb2", password: "new" });
    expect(acc.password).toBe("new");
});

test("failed logins are shown on the account", async () => {
    await setUp();
    checkOk = false;
    const id = await addServer();
    const html = await page(`/admin/servers/${id}`);
    expect(html).toContain('class="card account err"');
    expect(html).toContain('aria-label="Login failed"');
    expect(html).toContain("The server rejected the login");
    expect(html).toContain("<details open>");
});

test("saving server settings re-tests every account", async () => {
    await setUp();
    const id = await addServer("BookOrbit", "alice");
    await addAccount(id, "anna");
    checks.length = 0;
    await post(`/admin/servers/${id}`, { name: "Books", upstreamUrl: "http://bookorbit:3001/api/v1/opds" });
    expect(store.server(id)!.name).toBe("Books");
    expect(checks.map((c) => [c.username, c.upstreamUrl])).toEqual([
        ["alice", "http://bookorbit:3001/api/v1/opds"], ["anna", "http://bookorbit:3001/api/v1/opds"]]);
});

test.each([
    ["not a url", "absolute URL"],
    ["ftp://host/opds", "http:// or https://"],
    ["http://user:pw@bookorbit/opds", "not in the URL"],
])("rejects OPDS URL %p", async (upstreamUrl, message) => {
    await setUp();
    const r = await post("/admin/servers", { name: "x", upstreamUrl });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain(message);
    expect(store.servers).toHaveLength(0);
});

test("user input is HTML-escaped", async () => {
    await setUp();
    const id = await addServer('<script>alert("x")</script>', "<b>bob</b>");
    const html = await page(`/admin/servers/${id}`);
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<b>bob</b>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
});

// --- settings and persistence ---------------------------------------------------

test("changing the admin password logs out other sessions", async () => {
    await setUp();
    const oldCookie = cookie;
    expect((await post("/admin/settings/password", { current: "wrong", password: "new password", confirm: "new password" })).status).toBe(400);
    expect((await post("/admin/settings/password", { current: PASSWORD, password: "new password", confirm: "new password" })).status).toBe(303);
    expect((await call("/admin")).status).toBe(200); // this session got a fresh cookie
    cookie = oldCookie;
    expect((await call("/admin")).headers.get("location")).toBe("/admin/login");
    expect(await Bun.password.verify("new password", store.config.adminPasswordHash!)).toBe(true);
});

test("config is persisted privately", async () => {
    await setUp();
    await addServer();
    await store.flush();
    expect((await stat(`${dir}/config.json`)).mode & 0o777).toBe(0o600);
    const reopened = await Store.open(dir);
    expect(reopened.servers.map((s) => s.name)).toEqual(["BookOrbit"]);
    expect(reopened.config.adminPasswordHash).toBe(store.config.adminPasswordHash!);
});

test("version 1 configs are migrated: each catalog becomes a server with one account", async () => {
    const old = await mkdtemp(`${tmpdir()}/opds-proxy-v1-`);
    await writeFile(`${old}/config.json`, JSON.stringify({
        version: 1, adminPasswordHash: "hash", sessionSecret: "s",
        catalogs: [{ id: "c1", name: "BookOrbit", upstreamUrl: OPDS_URL, username: "test", password: "pw",
            tokens: [{ id: "t1", token: "mgrt-test-tokn-abcd", label: "PocketBook Era", createdAt: "2026-10-19T00:00:00Z" }] }],
    }));
    const migrated = await Store.open(old);
    expect(migrated.config.version).toBe(2);
    expect(migrated.findToken("mgrt-test-tokn-abcd")).toMatchObject({
        server: { id: "c1", name: "BookOrbit", upstreamUrl: OPDS_URL },
        account: { username: "test", password: "pw" },
        token: { label: "PocketBook Era" },
    });
    expect((await Bun.file(`${old}/config.json`).json()).version).toBe(2); // written back
    await rm(old, { recursive: true, force: true });
});

test("static assets are public, pages send security headers", async () => {
    expect((await call("/admin/static/app.css")).headers.get("content-type")).toContain("text/css");
    const r = await call("/admin/setup");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(r.headers.get("cache-control")).toBe("no-store");
});

test("checkAll tests every account", async () => {
    await setUp();
    const id = await addServer("BookOrbit", "alice");
    await addAccount(id, "anna");
    checks.length = 0;
    await app.checkAll();
    expect(checks.map((c) => c.username).sort()).toEqual(["alice", "anna"]);
});

test("activity shows server, account and device; the server page leaves out the server column", async () => {
    await setUp();
    const id = await addServer("BookOrbit", "alice");
    const acc = store.server(id)!.accounts[0]!;
    const token = await createToken(id, acc.id, "PocketBook Era");
    app.activity.add({
        at: new Date().toISOString(), ip: "1.2.3.4", method: "GET", path: "/***/_f/…/Book.epub",
        fullPath: "/***/_f/LzEvZG93bmxvYWQ/Book.epub", upstreamUrl: `${OPDS_URL}/1/download?fileId=1`,
        status: 200, note: "", userAgent: "PocketBook", serverId: id, serverName: "BookOrbit", accountName: "alice",
        tokenLabel: token.label,
    });
    const row = (html: string) => html.slice(html.indexOf("<tbody>"));

    const full = await page("/admin/activity");
    expect(full).toContain("<th>Server</th><th>Account</th><th>Device</th>");
    expect(row(full)).toMatch(/BookOrbit<\/td>\s*<td class="nowrap">alice<\/td>\s*<td class="nowrap">PocketBook Era<\/td>/);
    // Hovering the request shows the full path and where it went upstream
    expect(full).toContain(`title="GET /***/_f/LzEvZG93bmxvYWQ/Book.epub\n→ forwarded to ${OPDS_URL}/1/download?fileId=1"`);

    const serverView = await page(`/admin/servers/${id}`);
    expect(serverView).not.toContain("<th>Server</th>");
    expect(serverView).toContain("<th>Account</th><th>Device</th>");
});

test("SETUP_CODE from the environment: setup page says where to find it", async () => {
    app = createApp({ store, setupCode: "7f3a9c1e5b2d8a40", setupCodeFromEnv: true });
    const html = await page("/admin/setup");
    expect(html).toContain("from your Docker compose file");
    expect(html).not.toContain("container log");
    expect((await post("/admin/setup", { code: "wrong-code", password: PASSWORD, confirm: PASSWORD })).status).toBe(403);
    expect((await post("/admin/setup", { code: "7F3A9C1E5B2D8A40", password: PASSWORD, confirm: PASSWORD })).status).toBe(303);
});
