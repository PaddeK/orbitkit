import { randomBytes } from "node:crypto";
import type { ActivityLog } from "../activity.ts";
import { htmlResponse, publicOrigin, redirect, textResponse } from "../http.ts";
import { type CheckResult, checkUpstream } from "../proxy/check.ts";
import {
    type Account, type Server, type Store, type Upstream, accountName, newId, upstreamOf, validateUpstreamUrl,
} from "../store.ts";
import { newAccessToken, normalizeToken } from "../tokens.ts";
import CSS from "./static/app.css" with { type: "text" };
import JS from "./static/app.js" with { type: "text" };
import {
    MIN_PASSWORD_LENGTH, SESSION_COOKIE, Throttle, clearedSessionCookie, getCookie, isSameOrigin, newSession,
    sessionCookie, verifySession,
} from "./auth.ts";
import {
    type AccountForm, type Flash, type ServerForm, type ServerPageOptions, activityPage, dashboardPage, loginPage,
    serverPage, settingsPage, setupPage,
} from "./views.ts";

export interface AdminOptions {
    store: Store;
    activity: ActivityLog;
    /** One-time code required to claim the admin account; undefined once claimed or when ADMIN_PASSWORD is set */
    setupCode?: string;
    setupCodeFromEnv?: boolean;
    publicUrl?: string;
    /** Login test run after saving a server or account (replaceable in tests) */
    check?: (upstream: Upstream) => Promise<CheckResult>;
}

const FLASHES: Record<string, Flash> = {
    "server-created": { kind: "ok", text: "Server added. Create a reader URL for your device below." },
    "account-created": { kind: "ok", text: "Account added. Create a reader URL for it below." },
    "account-removed": { kind: "ok", text: "Account removed." },
    "token-created": { kind: "ok", text: "Reader URL created. Enter it as an OPDS catalog on the device." },
    "token-revoked": { kind: "ok", text: "Reader URL revoked." },
    "server-removed": { kind: "ok", text: "Server removed." },
    "password-changed": { kind: "ok", text: "Password changed." },
};

const STATIC: Record<string, [string, string]> = {
    "/admin/static/app.css": [CSS, "text/css; charset=utf-8"],
    "/admin/static/app.js": [JS, "text/javascript; charset=utf-8"],
};

class UserError extends Error {}

function field(form: FormData, name: string): string {
    const value = form.get(name);
    return typeof value === "string" ? value.trim() : "";
}

/** Passwords are taken verbatim: leading/trailing spaces may be part of them. */
function secret(form: FormData, name: string): string {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
}

function readServerForm(form: FormData): ServerForm {
    return { name: field(form, "name"), upstreamUrl: field(form, "upstreamUrl") };
}

function validateServer(input: ServerForm): string {
    if (!input.name) throw new UserError("Please give the server a name.");
    if (input.name.length > 80) throw new UserError("The name is too long.");
    try {
        return validateUpstreamUrl(input.upstreamUrl);
    } catch (err) {
        throw new UserError((err as Error).message);
    }
}

function validateUsername(server: Server, username: string, except?: Account): void {
    if (username.length > 200) throw new UserError("The username is too long.");
    if (server.accounts.some((a) => a !== except && a.username === username)) {
        throw new UserError(username
            ? `This server already has an account for ${username}. Add another reader URL to it instead.`
            : "This server already has anonymous access set up.");
    }
}

export class AdminRoutes {
    private readonly throttle = new Throttle();
    /** Last login test per account id; in memory only */
    private readonly checks = new Map<string, CheckResult>();
    private readonly check: (upstream: Upstream) => Promise<CheckResult>;

    constructor(private readonly opts: AdminOptions) {
        this.check = opts.check ?? ((u) => checkUpstream(u));
    }

    private get store(): Store {
        return this.opts.store;
    }

    async handle(req: Request, clientIp: string): Promise<Response> {
        const url = new URL(req.url);
        const path = url.pathname.replace(/\/+$/, "") || "/admin";
        const method = req.method;

        const asset = STATIC[path];
        if (asset && (method === "GET" || method === "HEAD")) {
            return new Response(asset[0], { headers: { "content-type": asset[1], "cache-control": "public, max-age=3600" } });
        }

        if (method === "POST" && !isSameOrigin(req, this.allowedHosts(req))) {
            return textResponse("Cross-site request rejected", 403);
        }

        // --- not set up yet: only the setup page is reachable --------------------
        if (!this.store.config.adminPasswordHash) {
            if (path !== "/admin/setup") return redirect("/admin/setup");
            return method === "POST" ? this.setup(req, clientIp) : htmlResponse(setupPage(this.setupPageOptions()));
        }
        if (path === "/admin/setup") return redirect("/admin");

        if (path === "/admin/login") {
            return method === "POST" ? this.login(req, clientIp) : htmlResponse(loginPage());
        }

        // --- everything below requires a session --------------------------------
        if (!verifySession(this.store.config.sessionSecret, getCookie(req, SESSION_COOKIE))) {
            return method === "GET" ? redirect("/admin/login") : textResponse("Not logged in", 401);
        }

        const flash = FLASHES[url.searchParams.get("flash") ?? ""];

        if (method === "GET") {
            if (path === "/admin") return this.dashboard(flash);
            if (path === "/admin/activity") return htmlResponse(activityPage(this.opts.activity.recent(200)));
            if (path === "/admin/settings") return htmlResponse(settingsPage(flash));
            const m = path.match(/^\/admin\/servers\/([\w-]+)$/);
            const server = m && this.store.server(m[1]!);
            if (server) return this.serverView(req, server, { flash, highlight: url.searchParams.get("token") ?? undefined });
            return textResponse("Not found", 404);
        }

        if (method !== "POST") return textResponse("Method not allowed", 405);
        const form = await req.formData();

        if (path === "/admin/logout") return redirect("/admin/login", { "set-cookie": clearedSessionCookie() });
        if (path === "/admin/settings/password") return this.changePassword(req, form);
        if (path === "/admin/servers") return this.createServer(form);

        // /admin/servers/:sid[/action | /accounts[/:aid[/action | /tokens[/:tid/delete]]]]
        const m = path.match(/^\/admin\/servers\/([\w-]+)(?:\/(delete|accounts)(?:\/([\w-]+)(?:\/(test|delete|tokens)(?:\/([\w-]+)\/(delete))?)?)?)?$/);
        const server = m && this.store.server(m[1]!);
        if (!m || !server) return textResponse("Not found", 404);
        const [, , section, accountId, action, tokenId] = m;

        try {
            if (!section) return await this.updateServer(req, server, form);
            if (section === "delete") return await this.removeServer(server);
            if (!accountId) return await this.createAccount(req, server, form);

            const account = server.accounts.find((a) => a.id === accountId);
            if (!account) return textResponse("Not found", 404);
            if (!action) return await this.updateAccount(req, server, account, form);
            if (action === "test") return await this.testAccount(server, account);
            if (action === "delete") return await this.removeAccount(server, account);
            if (!tokenId) return await this.createToken(server, account, form);
            return await this.revokeToken(server, account, tokenId);
        } catch (err) {
            if (!(err instanceof UserError)) throw err;
            const opts: Partial<ServerPageOptions> = { flash: { kind: "err", text: err.message } };
            if (!section) opts.serverForm = readServerForm(form);
            else if (!accountId) opts.newAccountForm = { username: field(form, "username") };
            return this.serverView(req, server, opts, 400);
        }
    }

    private setupPageOptions() {
        return { needsCode: !!this.opts.setupCode, codeFromEnv: !!this.opts.setupCodeFromEnv };
    }

    private allowedHosts(req: Request): string[] {
        const hosts = [req.headers.get("host") ?? new URL(req.url).host];
        if (this.opts.publicUrl) hosts.push(new URL(this.opts.publicUrl).host);
        return hosts;
    }

    private loggedIn(req: Request, extraHeaders: Record<string, string> = {}): Record<string, string> {
        const secure = new URL(publicOrigin(req, this.opts.publicUrl)).protocol === "https:";
        return { "set-cookie": sessionCookie(newSession(this.store.config.sessionSecret), secure), ...extraHeaders };
    }

    private tooManyAttempts(clientIp: string): string | undefined {
        const wait = this.throttle.blockedFor(clientIp);
        return wait ? `Too many failed attempts. Try again in ${Math.ceil(wait / 1000)} seconds.` : undefined;
    }

    // --- admin login --------------------------------------------------------------

    private async setup(req: Request, clientIp: string): Promise<Response> {
        const page = this.setupPageOptions();
        const blocked = this.tooManyAttempts(clientIp);
        if (blocked) return htmlResponse(setupPage({ ...page, error: blocked }), 429);
        const form = await req.formData();
        if (page.needsCode && normalizeToken(field(form, "code")) !== this.opts.setupCode) {
            this.throttle.fail(clientIp);
            return htmlResponse(setupPage({ ...page, error: "Wrong setup code." }), 403);
        }
        const password = secret(form, "password");
        const error = passwordProblem(password, secret(form, "confirm"));
        if (error) return htmlResponse(setupPage({ ...page, error }), 400);

        const hash = await Bun.password.hash(password);
        await this.store.update((c) => {
            c.adminPasswordHash = hash;
        });
        this.opts.setupCode = undefined;
        this.throttle.succeed(clientIp);
        return redirect("/admin", this.loggedIn(req));
    }

    private async login(req: Request, clientIp: string): Promise<Response> {
        const blocked = this.tooManyAttempts(clientIp);
        if (blocked) return htmlResponse(loginPage(blocked), 429);
        const form = await req.formData();
        if (!(await Bun.password.verify(secret(form, "password"), this.store.config.adminPasswordHash!))) {
            this.throttle.fail(clientIp);
            return htmlResponse(loginPage("Wrong password."), 401);
        }
        this.throttle.succeed(clientIp);
        return redirect("/admin", this.loggedIn(req));
    }

    private async changePassword(req: Request, form: FormData): Promise<Response> {
        if (!(await Bun.password.verify(secret(form, "current"), this.store.config.adminPasswordHash!))) {
            return htmlResponse(settingsPage({ kind: "err", text: "Current password is wrong." }), 400);
        }
        const password = secret(form, "password");
        const error = passwordProblem(password, secret(form, "confirm"));
        if (error) return htmlResponse(settingsPage({ kind: "err", text: error }), 400);
        const hash = await Bun.password.hash(password);
        await this.store.update((c) => {
            c.adminPasswordHash = hash;
            c.sessionSecret = randomBytes(32).toString("hex"); // log out other sessions
        });
        return redirect("/admin/settings?flash=password-changed", this.loggedIn(req));
    }

    // --- pages --------------------------------------------------------------------

    private dashboard(flash?: Flash, form?: Partial<ServerForm & AccountForm>, status = 200): Response {
        return htmlResponse(dashboardPage(this.store.servers, this.opts.activity.recent(10), { flash, form }), status);
    }

    private serverView(req: Request, server: Server, opts: Partial<ServerPageOptions> = {}, status = 200): Response {
        return htmlResponse(serverPage(server, {
            ...opts,
            readerBase: publicOrigin(req, this.opts.publicUrl),
            checks: this.checks,
            activity: this.opts.activity.recent(20, server.id),
        }), status);
    }

    /** Test every account's login, e.g. on startup so the status icons aren't empty. */
    async checkAll(): Promise<void> {
        await Promise.all(this.store.servers.flatMap((s) => s.accounts.map((a) => this.runCheck(s, a))));
    }

    private async runCheck(server: Server, account: Account): Promise<void> {
        this.checks.set(account.id, await this.check(upstreamOf(server, account)));
    }

    // --- servers ------------------------------------------------------------------

    private async createServer(form: FormData): Promise<Response> {
        const input = { ...readServerForm(form), username: field(form, "username") };
        let upstreamUrl: string;
        try {
            upstreamUrl = validateServer(input);
        } catch (err) {
            if (!(err instanceof UserError)) throw err;
            return this.dashboard({ kind: "err", text: err.message }, input, 400);
        }
        const account: Account = { id: newId(), username: input.username, password: secret(form, "password"), tokens: [] };
        const server: Server = { id: newId(), name: input.name, upstreamUrl, accounts: [account] };
        await this.store.update((c) => {
            c.servers.push(server);
        });
        await this.runCheck(server, account);
        return redirect(`/admin/servers/${server.id}?flash=server-created`);
    }

    private async updateServer(_req: Request, server: Server, form: FormData): Promise<Response> {
        const input = readServerForm(form);
        const upstreamUrl = validateServer(input);
        await this.store.update(() => {
            server.name = input.name;
            server.upstreamUrl = upstreamUrl;
        });
        await Promise.all(server.accounts.map((a) => this.runCheck(server, a)));
        return redirect(`/admin/servers/${server.id}`);
    }

    private async removeServer(server: Server): Promise<Response> {
        await this.store.update((c) => {
            c.servers = c.servers.filter((s) => s !== server);
        });
        for (const a of server.accounts) this.checks.delete(a.id);
        return redirect("/admin?flash=server-removed");
    }

    // --- accounts -----------------------------------------------------------------

    private async createAccount(_req: Request, server: Server, form: FormData): Promise<Response> {
        const username = field(form, "username");
        validateUsername(server, username);
        const account: Account = { id: newId(), username, password: secret(form, "password"), tokens: [] };
        await this.store.update(() => {
            server.accounts.push(account);
        });
        await this.runCheck(server, account);
        return redirect(`/admin/servers/${server.id}?flash=account-created#account-${account.id}`);
    }

    private async updateAccount(_req: Request, server: Server, account: Account, form: FormData): Promise<Response> {
        const username = field(form, "username");
        validateUsername(server, username, account);
        const password = secret(form, "password");
        await this.store.update(() => {
            account.username = username;
            if (password) account.password = password;
        });
        await this.runCheck(server, account);
        return redirect(`/admin/servers/${server.id}#account-${account.id}`);
    }

    private async testAccount(server: Server, account: Account): Promise<Response> {
        await this.runCheck(server, account);
        return redirect(`/admin/servers/${server.id}#account-${account.id}`);
    }

    private async removeAccount(server: Server, account: Account): Promise<Response> {
        await this.store.update(() => {
            server.accounts = server.accounts.filter((a) => a !== account);
        });
        this.checks.delete(account.id);
        return redirect(`/admin/servers/${server.id}?flash=account-removed`);
    }

    // --- reader URLs --------------------------------------------------------------

    private async createToken(server: Server, account: Account, form: FormData): Promise<Response> {
        const label = field(form, "label").slice(0, 60) || accountName(account);
        const token = { id: newId(), token: newAccessToken(), label, createdAt: new Date().toISOString() };
        await this.store.update(() => {
            account.tokens.push(token);
        });
        return redirect(`/admin/servers/${server.id}?flash=token-created&token=${token.id}#token-${token.id}`);
    }

    private async revokeToken(server: Server, account: Account, tokenId: string): Promise<Response> {
        await this.store.update(() => {
            account.tokens = account.tokens.filter((t) => t.id !== tokenId);
        });
        return redirect(`/admin/servers/${server.id}?flash=token-revoked#account-${account.id}`);
    }
}

function passwordProblem(password: string, confirm: string): string | undefined {
    if (password.length < MIN_PASSWORD_LENGTH) return `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`;
    if (password !== confirm) return "The passwords don't match.";
    return undefined;
}
