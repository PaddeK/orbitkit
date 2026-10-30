import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Login, parseCookies, safeNext } from "../src/login.ts";

interface FakeUser {
    password: string;
    isSuperuser: boolean;
    permissions: string[];
}

/** A fake BookOrbit with several users and sessions: native login, refresh (single-use tokens), me and logout. */
function startFakeBookOrbit() {
    let counter = 0;
    const fake = {
        users: {
            ahab: { password: "white-whale", isSuperuser: false, permissions: ["manage_libraries"] },
            ishmael: { password: "call-me", isSuperuser: false, permissions: ["library_download"] },
            starbuck: { password: "coffee", isSuperuser: true, permissions: ["*"] },
        } as Record<string, FakeUser>,
        /** Live sessions by ID */
        sessions: new Map<number, { username: string; access: string; refresh: string; expiresAt: number }>(),
        logins: 0,
        refreshes: 0,
        url: "",
        stop: () => {},
        /** End a session from BookOrbit's side, as from its session list */
        revokeAll() {
            fake.sessions.clear();
        },
    };
    const issue = (username: string, id = ++counter) => {
        const session = { username, access: `access-${++counter}`, refresh: `refresh-${counter}`, expiresAt: Date.now() + 15 * 60_000 };
        fake.sessions.set(id, session);
        return { accessToken: session.access, accessTokenExpiresAt: new Date(session.expiresAt).toISOString(), refreshToken: session.refresh, sessionId: id };
    };
    const me = (username: string) => ({ id: 1, username, isSuperuser: fake.users[username]!.isSuperuser, permissions: fake.users[username]!.permissions });
    const json = (body: unknown, status = 200) => Response.json(body, { status });

    const server = Bun.serve({
        port: 0,
        async fetch(req) {
            const path = new URL(req.url).pathname.replace(/^\/api\/v1/, "");
            const body = req.method === "POST" ? ((await req.json()) as Record<string, string>) : {};
            if (path === "/auth/login") {
                const user = fake.users[body.username!];
                if (!user || user.password !== body.password) return json({ message: "Invalid credentials" }, 401);
                if (body.clientKind !== "native") return json({ message: "expected a native client" }, 400);
                fake.logins++;
                return json({ ...issue(body.username!), user: me(body.username!) });
            }
            if (path === "/auth/refresh") {
                const entry = [...fake.sessions].find(([, s]) => s.refresh === body.refreshToken);
                if (!entry) return json({ message: "Unauthorized" }, 401);
                fake.refreshes++;
                return json(issue(entry[1].username, entry[0]));
            }
            if (path === "/auth/logout") {
                for (const [id, s] of fake.sessions) if (s.refresh === body.refreshToken) fake.sessions.delete(id);
                return json({});
            }
            if (path === "/auth/me") {
                const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
                const session = [...fake.sessions.values()].find((s) => s.access === token && s.expiresAt > Date.now());
                return session ? json(me(session.username)) : json({ message: "Unauthorized" }, 401);
            }
            return json({ message: "Not found" }, 404);
        },
    });
    fake.url = server.url.origin;
    fake.stop = () => server.stop(true);
    return fake;
}

let fake: ReturnType<typeof startFakeBookOrbit>;
let dir: string;
let server: ReturnType<typeof Bun.serve>;
let login: Login;

async function start(basePath = "") {
    login = await Login.open({
        bookorbitUrl: fake.url, bookorbitPublicUrl: "https://books.example.org", file: join(dir, "sessions.json"), cookie: "orbitkit_test",
        permission: "manage_libraries", permissionLabel: "Manage libraries", title: "orbitkit test", basePath,
        log: { info() {}, warn() {}, error() {} },
        page: (title, body) => `<title>${title}</title>${body}`,
    });
    const page = login.guard((req) => new Response(`hello ${login.auth(req)!.user.username} via ${login.auth(req)!.via}`));
    const routes: Record<string, unknown> = {};
    for (const prefix of basePath ? ["", basePath] : [""]) {
        for (const [path, route] of Object.entries(login.routes())) routes[prefix + path] = route;
        routes[`${prefix}/`] = page;
        routes[`${prefix}/change`] = { POST: page };
    }
    server = Bun.serve({ port: 0, routes: routes as never, fetch: () => new Response("Not found", { status: 404 }) });
}

beforeEach(async () => {
    fake = startFakeBookOrbit();
    dir = await mkdtemp(join(tmpdir(), "orbitkit-login-"));
});
afterEach(async () => {
    setSystemTime();
    server?.stop(true);
    fake.stop();
    await rm(dir, { recursive: true, force: true });
});

const url = (path: string) => new URL(path, server.url);
/** A form post from the page itself, as a browser sends it */
const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(url(path), { method: "POST", body: new URLSearchParams(fields), redirect: "manual", headers: { origin: server.url.origin, ...headers } });
const get = (path: string, headers: Record<string, string> = {}) => fetch(url(path), { redirect: "manual", headers });

async function signIn(username: string, password: string, next = "/") {
    const res = await post("/login", { username, password, next });
    const cookie = res.headers.get("set-cookie") ?? "";
    return { res, cookie: cookie.split(";")[0]! };
}

test("signing in with a BookOrbit account that has the permission", async () => {
    await start();
    const { res, cookie } = await signIn("ahab", "white-whale", "/change?x=1");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/change?x=1");
    expect(res.headers.get("set-cookie")).toMatch(/^orbitkit_test=[\w-]{43}; Path=\/; Max-Age=604800; HttpOnly; SameSite=Strict$/);
    expect(await (await get("/", { cookie })).text()).toBe("hello ahab via session");
    // The cookie holds a random ID, never a BookOrbit token, and the session file is private
    expect(cookie).not.toContain("access-");
    expect((await stat(join(dir, "sessions.json"))).mode & 0o777).toBe(0o600);
    expect(await Bun.file(join(dir, "sessions.json")).text()).not.toContain(cookie.split("=")[1]!);
});

test("wrong passwords and missing permissions are refused, and the session made for the check is ended", async () => {
    await start();
    const wrong = await signIn("ahab", "nope");
    expect(wrong.res.status).toBe(401);
    expect(await wrong.res.text()).toContain("Wrong user name or password");
    expect(wrong.cookie).toBe("");

    const unprivileged = await signIn("ishmael", "call-me");
    expect(unprivileged.res.status).toBe(403);
    expect(await unprivileged.res.text()).toContain("Manage libraries");
    expect(fake.sessions.size).toBe(0);

    expect((await signIn("starbuck", "coffee")).res.status).toBe(303);
});

test("a login survives a restart and is renewed with BookOrbit", async () => {
    await start();
    const { cookie } = await signIn("ahab", "white-whale");
    server.stop(true);
    await start();
    expect((await get("/", { cookie })).status).toBe(200);
    // Past the access token's 15 minutes: renewed with the refresh token, once even for parallel requests
    setSystemTime(new Date(Date.now() + 20 * 60_000));
    const pages = await Promise.all([get("/", { cookie }), get("/", { cookie }), get("/", { cookie })]);
    expect(pages.map((p) => p.status)).toEqual([200, 200, 200]);
    expect(fake.refreshes).toBe(1);
});

test("ending the session in BookOrbit ends it here, and a lost permission locks the user out", async () => {
    await start();
    const { cookie } = await signIn("ahab", "white-whale");
    fake.users.ahab!.permissions = [];
    setSystemTime(new Date(Date.now() + 6 * 60_000));
    expect((await get("/", { cookie })).status).toBe(403);

    fake.revokeAll();
    setSystemTime(new Date(Date.now() + 12 * 60_000));
    const res = await get("/", { cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?next=%2F");
});

test("signing out ends the session here and in BookOrbit", async () => {
    await start();
    const { cookie } = await signIn("ahab", "white-whale");
    const res = await post("/logout", {}, { cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(fake.sessions.size).toBe(0);
    expect((await get("/", { cookie })).status).toBe(303);
});

test("logins end after 12 hours without use", async () => {
    await start();
    const { cookie } = await signIn("ahab", "white-whale");
    setSystemTime(new Date(Date.now() + 13 * 3_600_000));
    expect((await get("/", { cookie })).status).toBe(303);
    expect(fake.sessions.size).toBe(0);
});

test("BookOrbit's own cookie is enough", async () => {
    await start();
    const token = (await (await fetch(`${fake.url}/api/v1/auth/login`, {
        method: "POST", body: JSON.stringify({ username: "starbuck", password: "coffee", clientKind: "native" }),
    })).json() as { accessToken: string }).accessToken;
    expect(await (await get("/", { cookie: `theme=dark; access_token=${token}` })).text()).toBe("hello starbuck via bookorbit");
    expect((await get("/", { cookie: "access_token=forged" })).status).toBe(303);
});

test("forms from other sites are refused, also the login form", async () => {
    await start();
    const { cookie } = await signIn("ahab", "white-whale");
    expect((await post("/change", {}, { cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch(url("/change"), { method: "POST", headers: { cookie } })).status).toBe(403);
    expect((await post("/change", {}, { cookie })).status).toBe(200);
    expect((await post("/login", { username: "ahab", password: "white-whale" }, { origin: "https://evil.example" })).status).toBe(403);
    // A post without a login is not redirected: what it would have done is lost
    expect((await post("/change", {})).status).toBe(401);
});

test("after ten failed logins from one address, it has to wait", async () => {
    await start();
    for (let i = 0; i < 10; i++) expect((await signIn("ahab", "nope")).res.status).toBe(401);
    expect((await signIn("ahab", "white-whale")).res.status).toBe(429);
    setSystemTime(new Date(Date.now() + 16 * 60_000));
    expect((await signIn("ahab", "white-whale")).res.status).toBe(303);
});

test("below a base path, the cookie and the redirects stay there", async () => {
    await start("/api/orbitkit");
    const res = await post("/api/orbitkit/login", { username: "ahab", password: "white-whale", next: "/api/orbitkit/" });
    expect(res.headers.get("set-cookie")).toContain("Path=/api/orbitkit;");
    expect(res.headers.get("location")).toBe("/api/orbitkit/");
    expect((await get("/api/orbitkit/")).headers.get("location")).toBe("/api/orbitkit/login?next=%2Fapi%2Forbitkit%2F");
});

test("the login page under BookOrbit's address points to BookOrbit", async () => {
    await start("/api/orbitkit");
    const page = await (await get("/api/orbitkit/login", { host: "books.example.org" })).text();
    expect(page).toContain("Open BookOrbit");
    expect(await (await get("/login")).text()).not.toContain("Open BookOrbit");
});

test("after signing in, only pages of orbitkit are gone to", () => {
    expect(safeNext("/books/3?x=1", "")).toBe("/books/3?x=1");
    expect(safeNext("//evil.example/", "")).toBe("/");
    expect(safeNext("https://evil.example/", "")).toBe("/");
    expect(safeNext("/\\evil.example", "")).toBe("/");
    expect(safeNext("/books/3", "/api/orbitkit")).toBe("/api/orbitkit/");
    expect(safeNext("/api/orbitkit/books/3", "/api/orbitkit")).toBe("/api/orbitkit/books/3");
    expect(parseCookies("a=1; access_token=x=y;  b = 2")).toEqual(new Map([["a", "1"], ["access_token", "x=y"], ["b", "2"]]));
});
