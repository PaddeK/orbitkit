import type { ActivityEntry } from "../activity.ts";
import type { CheckResult } from "../proxy/check.ts";
import { type Account, type Server, accountName } from "../store.ts";
import { MIN_PASSWORD_LENGTH } from "./auth.ts";
import { html, type SafeHtml } from "./html.ts";

export interface Flash {
    kind: "ok" | "err";
    text: string;
}

export function ago(iso: string | undefined, now = Date.now()): string {
    if (!iso) return "never";
    const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
    if (seconds < 45) return "just now";
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
    const days = Math.round(seconds / 86400);
    return `${days} day${days === 1 ? "" : "s"} ago`;
}

function time(iso: string | undefined): SafeHtml {
    return iso ? html`<time datetime="${iso}" title="${iso}">${ago(iso)}</time>` : html`<span class="muted">never</span>`;
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function lastUsed(accounts: Account[]): string | undefined {
    return accounts.flatMap((a) => a.tokens.map((t) => t.lastUsedAt)).filter(Boolean).sort().at(-1);
}

function layout(title: string, body: SafeHtml, opts: { nav?: boolean; flash?: Flash; narrow?: boolean } = {}): SafeHtml {
    return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · OPDS Proxy</title>
<link rel="stylesheet" href="/admin/static/app.css">
<script src="/admin/static/app.js" defer></script>
</head>
<body>
<header class="top">
    <a class="brand" href="/admin">OPDS Proxy</a>
    ${opts.nav ? html`<nav>
        <a href="/admin">Servers</a>
        <a href="/admin/activity">Activity</a>
        <a href="/admin/settings">Settings</a>
        <form method="post" action="/admin/logout"><button class="link">Log out</button></form>
    </nav>` : ""}
</header>
<main class="${opts.narrow ? "narrow" : ""}">
${opts.flash ? html`<div class="banner ${opts.flash.kind}" role="status">${opts.flash.text}</div>` : ""}
${body}
</main>
</body>
</html>`;
}

// --- admin login --------------------------------------------------------------

export function setupPage(opts: { needsCode: boolean; codeFromEnv?: boolean; error?: string }): SafeHtml {
    return layout("Set up", html`
<div class="card">
    <h1>Welcome</h1>
    <p class="muted">Choose a password for this admin page. It protects your servers and their logins.</p>
    <form method="post" action="/admin/setup">
        ${opts.needsCode ? html`
        <label for="code">Setup code</label>
        <input type="text" id="code" name="code" class="mono" required autocomplete="off" placeholder="xxxx-xxxx">
        <p class="hint">${opts.codeFromEnv
            ? html`The <code>SETUP_CODE</code> from your Docker compose file or environment.`
            : html`Printed in the container log on startup (<code>docker logs opds-proxy</code>).`}</p>` : ""}
        <label for="password">Admin password</label>
        <input type="password" id="password" name="password" required minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password">
        <label for="confirm">Repeat password</label>
        <input type="password" id="confirm" name="confirm" required minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password">
        <div class="actions"><button>Create admin account</button></div>
    </form>
</div>`, { narrow: true, flash: opts.error ? { kind: "err", text: opts.error } : undefined });
}

export function loginPage(error?: string): SafeHtml {
    return layout("Log in", html`
<div class="card">
    <h1>Log in</h1>
    <form method="post" action="/admin/login">
        <label for="password">Admin password</label>
        <input type="password" id="password" name="password" required autofocus autocomplete="current-password">
        <div class="actions"><button>Log in</button></div>
    </form>
</div>`, { narrow: true, flash: error ? { kind: "err", text: error } : undefined });
}

export function settingsPage(flash?: Flash): SafeHtml {
    return layout("Settings", html`
<h1>Settings</h1>
<section class="card">
    <h2>Change admin password</h2>
    <form method="post" action="/admin/settings/password">
        <label for="current">Current password</label>
        <input type="password" id="current" name="current" required autocomplete="current-password">
        <div class="grid2">
            <div><label for="password">New password</label>
            <input type="password" id="password" name="password" required minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password"></div>
            <div><label for="confirm">Repeat new password</label>
            <input type="password" id="confirm" name="confirm" required minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password"></div>
        </div>
        <p class="hint">Changing the password logs out all other admin sessions.</p>
        <div class="actions"><button>Change password</button></div>
    </form>
</section>`, { nav: true, flash });
}

// --- form fragments -----------------------------------------------------------

export interface ServerForm {
    name: string;
    upstreamUrl: string;
}

export interface AccountForm {
    username: string;
}

function serverFields(values: Partial<ServerForm>, prefix = ""): SafeHtml {
    return html`
<div class="grid2">
    <div>
        <label for="${prefix}name">Name</label>
        <input type="text" id="${prefix}name" name="name" required maxlength="80" value="${values.name ?? ""}" placeholder="BookOrbit">
    </div>
    <div>
        <label for="${prefix}upstreamUrl">OPDS URL</label>
        <input type="url" id="${prefix}upstreamUrl" name="upstreamUrl" required class="mono" value="${values.upstreamUrl ?? ""}" placeholder="http://bookorbit:3000/api/v1/opds">
    </div>
</div>
<p class="hint">The root OPDS feed as reachable <em>from this container</em>. In the same Docker stack, use the service name and container port.</p>`;
}

function accountFields(values: Partial<AccountForm>, prefix: string, editing: boolean): SafeHtml {
    return html`
<div class="grid2">
    <div>
        <label for="${prefix}username">Username</label>
        <input type="text" id="${prefix}username" name="username" value="${values.username ?? ""}" autocomplete="off" placeholder="empty for anonymous access">
    </div>
    <div>
        <label for="${prefix}password">Password</label>
        <input type="password" id="${prefix}password" name="password" autocomplete="new-password" placeholder="${editing ? "unchanged" : ""}">
    </div>
</div>`;
}

// --- servers ------------------------------------------------------------------

export function dashboardPage(servers: Server[], activity: ActivityEntry[],
                              opts: { flash?: Flash; form?: Partial<ServerForm & AccountForm> } = {}): SafeHtml {
    return layout("Servers", html`
<h1>Servers</h1>
${servers.length === 0 ? html`
<section class="card">
    <h2>Get started</h2>
    <ol class="steps">
        <li>Add the OPDS server your e-reader should read from (e.g. BookOrbit) and the account to log in with.</li>
        <li>Create a reader URL for each device. Add more accounts if several people read from the same server.</li>
        <li>Add the reader URL as an OPDS catalog on the e-reader and leave username and password empty.</li>
    </ol>
</section>` : html`
<div class="server-list">
${servers.map((s) => {
    const tokens = s.accounts.reduce((n, a) => n + a.tokens.length, 0);
    return html`
    <div class="card">
        <div>
            <h2><a href="/admin/servers/${s.id}">${s.name}</a></h2>
            <div class="muted mono">${s.upstreamUrl}</div>
        </div>
        <div class="muted right">${plural(s.accounts.length, "account")} · ${plural(tokens, "reader URL")}<br>last used ${time(lastUsed(s.accounts))}</div>
    </div>`;
})}
</div>`}
<section class="card">
    <h2>Add server</h2>
    <form method="post" action="/admin/servers">
        ${serverFields(opts.form ?? {})}
        <h3>First account</h3>
        ${accountFields(opts.form ?? {}, "", false)}
        <p class="hint">The login the proxy uses for this server. You can add more accounts later, e.g. one per person.</p>
        <div class="actions"><button>Add server</button></div>
    </form>
</section>
<section>
    <h2>Recent activity</h2>
    ${activityTable(activity)}
    <p><a href="/admin/activity">All activity →</a></p>
</section>`, { nav: true, flash: opts.flash });
}

export interface ServerPageOptions {
    readerBase: string;
    checks: Map<string, CheckResult>;
    /** Freshly created token to highlight */
    highlight?: string;
    activity: ActivityEntry[];
    flash?: Flash;
    serverForm?: Partial<ServerForm>;
    newAccountForm?: Partial<AccountForm>;
}

function accountCard(server: Server, account: Account, opts: ServerPageOptions): SafeHtml {
    const check = opts.checks.get(account.id);
    const base = `/admin/servers/${server.id}/accounts/${account.id}`;
    return html`
<section class="card account ${check ? (check.ok ? "ok" : "err") : ""}" id="account-${account.id}">
    <div class="account-head">
        <h2>${account.username ? html`<span class="muted">Account</span> ${account.username}` : "Anonymous access"}</h2>
        ${check ? html`<span class="status-icon ${check.ok ? "ok" : "err"}" role="img" aria-label="${check.ok ? "Connected" : "Login failed"}"
            title="${check.message} (checked ${ago(check.at)})">${check.ok ? "✓" : "✕"}</span>` : ""}
    </div>
    ${check && !check.ok ? html`<div class="banner err">${check.message} <span class="muted">(checked ${ago(check.at)})</span></div>` : ""}
    ${account.tokens.length === 0 ? html`<p class="empty">No reader URLs for this account yet.</p>` : html`
    <div class="table-wrap"><table>
        <thead><tr><th>Device</th><th>Reader URL</th><th>Last used</th><th></th></tr></thead>
        <tbody>
        ${account.tokens.map((t) => html`
            <tr id="token-${t.id}" class="${t.id === opts.highlight ? "new" : ""}">
                <td class="nowrap">${t.label}</td>
                <td><div class="row">
                    <input type="text" readonly class="mono url" id="url-${t.id}" value="${opts.readerBase}/${t.token}/" size="${`${opts.readerBase}/${t.token}/`.length + 3}">
                    <button type="button" class="secondary" data-copy="url-${t.id}">Copy</button>
                </div></td>
                <td class="nowrap">${time(t.lastUsedAt)}${t.lastUserAgent ? html`<div class="muted ua" title="${t.lastUserAgent}">${t.lastUserAgent}</div>` : ""}</td>
                <td><form method="post" action="${base}/tokens/${t.id}/delete" data-confirm="Revoke the reader URL for ${t.label}? The device will lose access.">
                    <button class="danger">Revoke</button>
                </form></td>
            </tr>`)}
        </tbody>
    </table></div>`}
    <form method="post" action="${base}/tokens">
        <label for="label-${account.id}">New reader URL for device</label>
        <div class="row">
            <input type="text" id="label-${account.id}" name="label" required maxlength="60" placeholder="e.g. PocketBook Era">
            <button>Create</button>
        </div>
    </form>
    <details${check && !check.ok ? html` open` : ""}>
        <summary>Login settings</summary>
        <form method="post" action="${base}">
            ${accountFields(account, `${account.id}-`, true)}
            <p class="hint">Leave the password empty to keep the stored one.</p>
            <div class="actions">
                <button>Save and test</button>
                <button class="secondary" formaction="${base}/test">Test login</button>
            </div>
        </form>
        <form method="post" action="${base}/delete" class="actions"
              data-confirm="Remove the account ${accountName(account)} and its ${plural(account.tokens.length, "reader URL")} from the proxy? The account on the server itself is not touched.">
            <button class="danger">Remove account</button>
        </form>
    </details>
</section>`;
}

export function serverPage(server: Server, opts: ServerPageOptions): SafeHtml {
    return layout(server.name, html`
<p><a href="/admin">← Servers</a></p>
<h1>${server.name}</h1>
<p class="muted mono">${server.upstreamUrl}</p>
<p class="muted">Each account is a login on this server. E-readers using an account's reader URLs appear on the server as
that user, with that user's permissions and reading progress. Anyone with a reader URL can browse and download as its account.</p>

${server.accounts.map((a) => accountCard(server, a, opts))}

<section class="card">
    <h2>Add account</h2>
    <form method="post" action="/admin/servers/${server.id}/accounts">
        ${accountFields(opts.newAccountForm ?? {}, "new-", false)}
        <p class="hint">For example one login per family member, so the server keeps everyone's progress and permissions apart.</p>
        <div class="actions"><button>Add account</button></div>
    </form>
</section>

<section class="card">
    <h2>Server settings</h2>
    <form method="post" action="/admin/servers/${server.id}">
        ${serverFields(opts.serverForm ?? server, "server-")}
        <div class="actions"><button>Save and test all accounts</button></div>
    </form>
</section>

<section>
    <h2>Activity</h2>
    ${activityTable(opts.activity, { showServer: false })}
</section>

<section class="card danger-zone">
    <h2>Remove server</h2>
    <p class="muted">Removes this server with all its accounts and reader URLs from the proxy. Your library on the server is not touched.</p>
    <form method="post" action="/admin/servers/${server.id}/delete" data-confirm="Remove ${server.name} with all its accounts and reader URLs?">
        <button class="danger">Remove server</button>
    </form>
</section>`, { nav: true, flash: opts.flash });
}

// --- activity -----------------------------------------------------------------

/** Hover text for a request: the full (token-masked) path and where it was forwarded to. */
function requestTooltip(e: ActivityEntry): string {
    return `${e.method} ${e.fullPath}` + (e.upstreamUrl ? `\n→ forwarded to ${e.upstreamUrl}` : "");
}

export function activityTable(entries: ActivityEntry[], opts: { showServer?: boolean } = {}): SafeHtml {
    const showServer = opts.showServer ?? true;
    if (entries.length === 0) return html`<p class="empty card">No reader requests yet.</p>`;
    const none = html`<span class="muted">–</span>`;
    return html`
<div class="table-wrap card flush"><table>
    <thead><tr><th>Time</th>${showServer ? html`<th>Server</th>` : ""}<th>Account</th><th>Device</th><th>Request</th><th>Status</th><th>User agent</th></tr></thead>
    <tbody>
    ${entries.map((e) => html`
        <tr>
            <td class="nowrap">${time(e.at)}</td>
            ${showServer ? html`<td class="nowrap">${e.serverName ?? none}</td>` : ""}
            <td class="nowrap">${e.accountName ?? none}</td>
            <td class="nowrap">${e.tokenLabel ?? html`<span class="muted">unknown token</span>`}</td>
            <td class="mono req" title="${requestTooltip(e)}">${e.method} ${e.path}${e.note ? html`<div class="muted">${e.note}</div>` : ""}</td>
            <td class="status-${String(e.status)[0]}">${e.status}</td>
            <td class="ua" title="${e.userAgent}">${e.userAgent}</td>
        </tr>`)}
    </tbody>
</table></div>`;
}

export function activityPage(entries: ActivityEntry[]): SafeHtml {
    return layout("Activity", html`
<h1>Activity</h1>
<p class="muted">The last ${entries.length} requests from e-readers (kept in memory until restart). Useful to see what a reader asks for when something doesn't work.</p>
${activityTable(entries)}`, { nav: true });
}
