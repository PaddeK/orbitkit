import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { HttpError, requestJson } from "./http.ts";
import type { Logger } from "./log.ts";

/** A BookOrbit user as GET /api/v1/auth/me describes them. */
export interface LoginUser {
    id: number;
    username: string;
    isSuperuser: boolean;
    /** BookOrbit permission keys, e.g. "manage_libraries"; ["*"] for superusers */
    permissions: string[];
}

interface Credentials {
    accessToken: string;
    accessTokenExpiresAt: string;
    refreshToken: string;
    user?: LoginUser;
}

/**
 * A login made on orbitkit's login page. It is a BookOrbit session of its own (BookOrbit lists it under the user's
 * sessions and can end it), which orbitkit renews and asks BookOrbit about every few minutes.
 */
interface Session {
    user: LoginUser;
    accessToken: string;
    /** Epoch milliseconds, like the other times here */
    accessExpiresAt: number;
    refreshToken: string;
    createdAt: number;
    lastSeenAt: number;
    verifiedAt: number;
}

/** How a request is signed in: with orbitkit's session cookie, or with BookOrbit's own cookie. */
export interface Auth {
    user: LoginUser;
    via: "session" | "bookorbit";
}

export interface LoginOptions {
    /** BookOrbit as orbitkit reaches it */
    bookorbitUrl: string;
    /** BookOrbit as browsers reach it */
    bookorbitPublicUrl: string;
    /** Where the sessions are kept across restarts (mode 0600: it holds BookOrbit refresh tokens) */
    file: string;
    /** Name of the session cookie. Browsers do not tell ports apart for cookies, so each feature has its own. */
    cookie: string;
    /** The BookOrbit permission a user needs; superusers have every permission */
    permission: string;
    /** Human name of the permission, for messages */
    permissionLabel: string;
    /** Shown on the login page, and as the device in BookOrbit's session list */
    title: string;
    /** Path under which the pages are also served, e.g. "/api/orbitkit" (see basePath in config) */
    basePath: string;
    log: Logger;
    /** Wraps a body in the feature's page layout */
    page: (title: string, body: string) => string;
}

/** The part of Bun's server a handler gets that the login uses */
export interface Peer {
    requestIP(req: Request): { address: string } | null;
}

export type Handler<R extends Request = Request> = (req: R, server?: Peer) => Response | Promise<Response>;

/** Ask BookOrbit again this often whether a session still stands and what the user may do */
const VERIFY_EVERY_MS = 5 * 60_000;
/** A login ends after this long without a request... */
const IDLE_MS = 12 * 3_600_000;
/** ...and after this long in any case */
const MAX_AGE_MS = 7 * 86_400_000;
/** How long an answer about BookOrbit's own cookie is trusted */
const COOKIE_CACHE_MS = 60_000;
/** Renew this long before the access token runs out */
const EXPIRY_MARGIN_MS = 60_000;
/** Failed logins allowed per address in FAILURE_WINDOW_MS; BookOrbit locks accounts on its own as well */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;

const escape = (text: string) =>
    text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Cookie values by name. */
export function parseCookies(header: string | null): Map<string, string> {
    const cookies = new Map<string, string>();
    for (const part of (header ?? "").split(";")) {
        const at = part.indexOf("=");
        if (at > 0) cookies.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
    }
    return cookies;
}

/**
 * Whether a request that changes something comes from a page of the same site, judged by the Origin header browsers
 * send with form posts (or Sec-Fetch-Site where there is none). Keeps other sites from posting forms in a signed-in
 * browser's name.
 */
export function sameOrigin(req: Request): boolean {
    const origin = req.headers.get("origin");
    if (origin) {
        try {
            return new URL(origin).host === req.headers.get("host");
        } catch {
            return false;
        }
    }
    return req.headers.get("sec-fetch-site") === "same-origin";
}

/**
 * Pages only BookOrbit users with a permission may see. A browser is let in by either of two cookies:
 *
 * - BookOrbit's own login cookie, when the pages are served under BookOrbit's address below /api (basePath): the
 *   browser sends it along, and BookOrbit says whose it is. Signing in to BookOrbit is all it takes.
 * - orbitkit's session cookie, from the login page, where the pages have an address of their own (e.g. a LAN port).
 *   The user name and password go to BookOrbit, never into orbitkit's data.
 */
export class Login {
    private readonly sessions: Map<string, Session>;
    /** BookOrbit cookie hashes and who they belong to, for COOKIE_CACHE_MS */
    private readonly cookieCache = new Map<string, { user: LoginUser; until: number }>();
    /** Running checks per session, since a refresh token works only once */
    private readonly verifying = new Map<string, Promise<LoginUser | null>>();
    private readonly failures = new Map<string, { count: number; since: number }>();
    private readonly authOf = new WeakMap<Request, Auth>();
    private writes: Promise<void> = Promise.resolve();

    private constructor(private readonly options: LoginOptions, sessions: Record<string, Session>) {
        this.sessions = new Map(Object.entries(sessions));
    }

    static async open(options: LoginOptions): Promise<Login> {
        await mkdir(dirname(options.file), { recursive: true });
        const file = Bun.file(options.file);
        const sessions = (await file.exists()) ? ((await file.json()) as Record<string, Session>) : {};
        return new Login(options, sessions);
    }

    /** Who made a request that passed the guard. */
    auth(req: Request): Auth | undefined {
        return this.authOf.get(req);
    }

    /** "" for requests to the pages at the root, basePath for those under it. */
    base(req: Request): string {
        const { basePath } = this.options;
        const path = new URL(req.url).pathname;
        return basePath && (path === basePath || path.startsWith(`${basePath}/`)) ? basePath : "";
    }

    /** Let a request through to the handler only for users with the permission. */
    guard<R extends Request>(handler: Handler<R>): Handler<R> {
        return async (req, server) => {
            const base = this.base(req);
            const changes = req.method !== "GET" && req.method !== "HEAD";
            if (changes && !sameOrigin(req)) return this.message(403, "This form was sent from another site, so it was refused.", base);
            let auth: Auth | null;
            try {
                auth = await this.authenticate(req);
            } catch (err) {
                this.options.log.error(`login: BookOrbit is not reachable: ${(err as Error).message}`);
                return this.message(503, "BookOrbit is not reachable, so your login cannot be checked. Try again in a moment.", base);
            }
            if (!auth) {
                if (changes) return this.message(401, "Your login has ended. Sign in again, then repeat what you did.", base);
                const url = new URL(req.url);
                return redirect(`${base}/login?next=${encodeURIComponent(url.pathname + url.search)}`);
            }
            if (!this.allowed(auth.user)) {
                return this.message(403, `${auth.user.username} may not use this page: it needs the BookOrbit permission "${this.options.permissionLabel}".`, base);
            }
            this.authOf.set(req, auth);
            return handler(req, server);
        };
    }

    /** The login page and its form, and signing out. Paths are relative to the pages' root. */
    routes(): Record<string, { GET?: Handler; POST?: Handler }> {
        return {
            "/login": {
                GET: (req) => this.loginPage(req, ""),
                POST: (req, server) => this.login(req, server?.requestIP(req)?.address ?? "-"),
            },
            "/logout": {
                POST: (req) => this.logout(req),
            },
        };
    }

    /** Who a request belongs to, or null if it is not signed in. Throws if BookOrbit cannot be asked. */
    async authenticate(req: Request): Promise<Auth | null> {
        const cookies = parseCookies(req.headers.get("cookie"));
        const id = cookies.get(this.options.cookie);
        if (id) {
            const user = await this.sessionUser(sha256(id));
            if (user) return { user, via: "session" };
        }
        // Set by BookOrbit for its own address and paths below /api: only there does the browser send it along
        const token = cookies.get("access_token");
        if (token) {
            const user = await this.cookieUser(token);
            if (user) return { user, via: "bookorbit" };
        }
        return null;
    }

    allowed(user: LoginUser): boolean {
        const permissions = user.permissions ?? [];
        return user.isSuperuser === true || permissions.includes("*") || permissions.includes(this.options.permission);
    }

    private async cookieUser(token: string): Promise<LoginUser | null> {
        const key = sha256(token);
        const now = Date.now();
        const cached = this.cookieCache.get(key);
        if (cached && cached.until > now) return cached.user;
        for (const [k, entry] of this.cookieCache) if (entry.until <= now) this.cookieCache.delete(k);
        try {
            const user = await this.me(token);
            this.cookieCache.set(key, { user, until: now + COOKIE_CACHE_MS });
            return user;
        } catch (err) {
            if (err instanceof HttpError && err.status === 401) return null;
            throw err;
        }
    }

    private async sessionUser(key: string): Promise<LoginUser | null> {
        const session = this.sessions.get(key);
        if (!session) return null;
        const now = Date.now();
        if (now - session.lastSeenAt > IDLE_MS || now - session.createdAt > MAX_AGE_MS) {
            await this.end(key);
            return null;
        }
        session.lastSeenAt = now;
        if (now - session.verifiedAt < VERIFY_EVERY_MS) return session.user;
        let check = this.verifying.get(key);
        if (!check) {
            check = this.verify(key, session).finally(() => this.verifying.delete(key));
            this.verifying.set(key, check);
        }
        return check;
    }

    /** Renew the session if needed and ask BookOrbit who it belongs to now; null if BookOrbit ended it. */
    private async verify(key: string, session: Session): Promise<LoginUser | null> {
        try {
            if (session.accessExpiresAt - EXPIRY_MARGIN_MS < Date.now()) {
                const credentials = await requestJson<Credentials>("POST", `${this.api}/auth/refresh`, {
                    json: { refreshToken: session.refreshToken },
                });
                session.accessToken = credentials.accessToken;
                session.accessExpiresAt = Date.parse(credentials.accessTokenExpiresAt);
                session.refreshToken = credentials.refreshToken;
            }
            session.user = await this.me(session.accessToken);
            session.verifiedAt = Date.now();
            await this.save();
            return session.user;
        } catch (err) {
            if (!(err instanceof HttpError && [400, 401, 403].includes(err.status))) throw err;
            this.options.log.info(`login: BookOrbit ended the session of ${session.user.username}`);
            this.sessions.delete(key);
            await this.save();
            return null;
        }
    }

    private async loginPage(req: Request, error: string, status = 200, username = ""): Promise<Response> {
        const base = this.base(req);
        const url = new URL(req.url);
        const next = url.searchParams.get("next") ?? "";
        const { bookorbitPublicUrl, title } = this.options;
        // Under BookOrbit's address, BookOrbit's own login is enough; its cookie lasts only minutes without the BookOrbit tab
        const underBookOrbit = base !== "" && sameHost(req, bookorbitPublicUrl);
        const hint = underBookOrbit
            ? `<p class="muted">Signed in to BookOrbit in this browser? <a href="${escape(bookorbitPublicUrl)}/">Open BookOrbit</a>
once so it renews your login, then <a href="${escape(safeNext(next, base))}">come back</a>.</p>`
            : "";
        return html(this.options.page(`Sign in · ${title}`, `<h1>Sign in</h1>
<p>Use your <a href="${escape(bookorbitPublicUrl)}/">BookOrbit</a> account; it needs the permission "${escape(this.options.permissionLabel)}".</p>
${error ? `<p><strong>${escape(error)}</strong></p>` : ""}
<form method="post" action="${escape(base)}/login">
<input type="hidden" name="next" value="${escape(next)}">
<p><label>User name<br><input name="username" autocomplete="username" required value="${escape(username)}" autofocus></label></p>
<p><label>Password<br><input name="password" type="password" autocomplete="current-password" required></label></p>
<div class="actions"><button type="submit" class="primary">Sign in</button></div>
</form>
${hint}`), status);
    }

    /** `client` is the address the form came from: BookOrbit sees every login coming from orbitkit's address. */
    private async login(req: Request, client: string): Promise<Response> {
        const base = this.base(req);
        if (!sameOrigin(req)) return this.message(403, "This form was sent from another site, so it was refused.", base);
        const form = await req.formData();
        const username = String(form.get("username") ?? "").trim();
        const password = String(form.get("password") ?? "");
        const next = String(form.get("next") ?? "");
        const page = new Request(`${new URL(req.url).origin}${base}/login?next=${encodeURIComponent(next)}`, { headers: req.headers });
        if (this.tooManyFailures(client)) return this.loginPage(page, "Too many failed logins. Wait a few minutes.", 429, username);
        if (!username || !password) return this.loginPage(page, "Enter your user name and password.", 400, username);

        let credentials: Credentials;
        try {
            credentials = await requestJson<Credentials>("POST", `${this.api}/auth/login`, {
                // "native" returns the tokens in the body instead of as cookies for BookOrbit's address
                json: { username, password, clientKind: "native", deviceLabel: this.options.title },
            });
        } catch (err) {
            if (!(err instanceof HttpError)) {
                this.options.log.error(`login: BookOrbit is not reachable: ${(err as Error).message}`);
                return this.loginPage(page, "BookOrbit is not reachable. Try again in a moment.", 503, username);
            }
            if (err.status === 401) {
                this.failed(client);
                this.options.log.warn(`login: failed for "${username}"`);
                return this.loginPage(page, "Wrong user name or password.", 401, username);
            }
            if (err.status === 429) return this.loginPage(page, "BookOrbit refuses more logins for a minute. Try again shortly.", 429, username);
            return this.loginPage(page, `BookOrbit refused the login: ${bookorbitMessage(err)}`, err.status, username);
        }

        const user = credentials.user ?? (await this.me(credentials.accessToken));
        if (!this.allowed(user)) {
            await this.revoke(credentials.refreshToken);
            return this.loginPage(page, `${user.username} may not use these pages: they need the BookOrbit permission "${this.options.permissionLabel}".`, 403);
        }
        const id = randomBytes(32).toString("base64url");
        const now = Date.now();
        this.sessions.set(sha256(id), {
            user,
            accessToken: credentials.accessToken,
            accessExpiresAt: Date.parse(credentials.accessTokenExpiresAt),
            refreshToken: credentials.refreshToken,
            createdAt: now,
            lastSeenAt: now,
            verifiedAt: now,
        });
        await this.save();
        this.failures.delete(client);
        this.options.log.info(`login: ${user.username} signed in`);
        return redirect(safeNext(next, base), { "set-cookie": this.cookie(req, base, id, MAX_AGE_MS / 1000) });
    }

    private async logout(req: Request): Promise<Response> {
        const base = this.base(req);
        if (!sameOrigin(req)) return this.message(403, "This form was sent from another site, so it was refused.", base);
        const id = parseCookies(req.headers.get("cookie")).get(this.options.cookie);
        const key = id && sha256(id);
        if (key && this.sessions.has(key)) {
            this.options.log.info(`login: ${this.sessions.get(key)!.user.username} signed out`);
            await this.end(key);
        }
        return redirect(`${base}/login`, { "set-cookie": this.cookie(req, base, "", 0) });
    }

    /** End a session here and in BookOrbit. */
    private async end(key: string): Promise<void> {
        const session = this.sessions.get(key);
        if (!session) return;
        this.sessions.delete(key);
        await this.save();
        await this.revoke(session.refreshToken);
    }

    private async revoke(refreshToken: string): Promise<void> {
        await requestJson("POST", `${this.api}/auth/logout`, { json: { refreshToken } }).catch((err) => {
            this.options.log.warn(`login: could not end the session in BookOrbit: ${(err as Error).message}`);
        });
    }

    private me(accessToken: string): Promise<LoginUser> {
        return requestJson<LoginUser>("GET", `${this.api}/auth/me`, { headers: { authorization: `Bearer ${accessToken}` } });
    }

    private cookie(req: Request, base: string, value: string, maxAgeSeconds: number): string {
        // Behind a TLS-terminating proxy (e.g. Cloudflare), the request reaches orbitkit as plain HTTP
        const secure = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
        return `${this.options.cookie}=${value}; Path=${base || "/"}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
    }

    private message(status: number, text: string, base: string): Response {
        return html(this.options.page(this.options.title, `<p>${escape(text)}</p><p><a href="${escape(base)}/">Back</a> · <a href="${escape(base)}/login">Sign in</a></p>`), status);
    }

    private tooManyFailures(client: string): boolean {
        const entry = this.failures.get(client);
        if (entry && Date.now() - entry.since > FAILURE_WINDOW_MS) this.failures.delete(client);
        return (this.failures.get(client)?.count ?? 0) >= MAX_FAILURES;
    }

    private failed(client: string): void {
        const entry = this.failures.get(client);
        if (entry) entry.count++;
        else this.failures.set(client, { count: 1, since: Date.now() });
    }

    private get api(): string {
        return `${this.options.bookorbitUrl}/api/v1`;
    }

    private save(): Promise<void> {
        const json = JSON.stringify(Object.fromEntries(this.sessions), null, 2);
        const path = this.options.file;
        this.writes = this.writes.then(async () => {
            const tmp = `${path}.tmp`;
            await writeFile(tmp, json, { mode: 0o600 });
            await chmod(tmp, 0o600);
            await rename(tmp, path);
        });
        return this.writes;
    }
}

function html(body: string, status = 200): Response {
    return new Response(body, {
        status,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "same-origin", "x-frame-options": "DENY" },
    });
}

function redirect(location: string, headers: Record<string, string> = {}): Response {
    return new Response(null, { status: 303, headers: { location, ...headers } });
}

/** Where to go after signing in: only a page of these pages, never another site. */
export function safeNext(next: string, base: string): string {
    const root = `${base}/`;
    if (!next.startsWith(root) || next.startsWith("//") || next.includes("\\") || /[\r\n]/.test(next)) return root;
    return next;
}

function sameHost(req: Request, url: string): boolean {
    try {
        return new URL(url).host === req.headers.get("host");
    } catch {
        return false;
    }
}

function bookorbitMessage(err: HttpError): string {
    try {
        const message = (JSON.parse(err.body) as { message?: unknown }).message;
        if (typeof message === "string" && message) return message;
    } catch {
        // Not JSON
    }
    return `HTTP ${err.status}`;
}
