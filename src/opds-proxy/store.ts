import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { normalizeToken } from "./tokens.ts";

export interface AccessToken {
    id: string;
    token: string;
    /** Device name, e.g. "PocketBook Era" */
    label: string;
    createdAt: string;
    lastUsedAt?: string;
    lastUserAgent?: string;
}

/** A login on the upstream server. Readers using its tokens appear upstream as this user. */
export interface Account {
    id: string;
    /** Empty for servers that allow anonymous access */
    username: string;
    password: string;
    tokens: AccessToken[];
}

export interface Server {
    id: string;
    name: string;
    /** Root OPDS feed of the upstream server, e.g. http://bookorbit:3000/api/v1/opds */
    upstreamUrl: string;
    accounts: Account[];
}

export interface Config {
    version: 2;
    adminPasswordHash?: string;
    sessionSecret: string;
    servers: Server[];
}

/** What the proxy needs to talk to an upstream as a particular account. */
export interface Upstream {
    upstreamUrl: string;
    username: string;
    password: string;
}

export interface TokenMatch {
    server: Server;
    account: Account;
    token: AccessToken;
}

export function newId(): string {
    return crypto.randomUUID().slice(0, 8);
}

export function upstreamOf(server: Server, account: Account): Upstream {
    return { upstreamUrl: server.upstreamUrl, username: account.username, password: account.password };
}

export function accountName(account: Account): string {
    return account.username || "Anonymous";
}

/** Throws with a user-facing message if `url` can't be used as an upstream. */
export function validateUpstreamUrl(url: string): string {
    let u: URL;
    try {
        u = new URL(url.trim());
    } catch {
        throw new Error("The OPDS URL must be an absolute URL like http://bookorbit:3000/api/v1/opds");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("The OPDS URL must start with http:// or https://");
    if (u.username || u.password) throw new Error("Put the credentials in the account's username/password fields, not in the URL");
    if (u.hash) throw new Error("The OPDS URL must not contain a #fragment");
    return u.toString().replace(/\/+$/, "");
}

interface ConfigV1 {
    version: 1;
    adminPasswordHash?: string;
    sessionSecret: string;
    catalogs: { id: string; name: string; upstreamUrl: string; username: string; password: string; tokens: AccessToken[] }[];
}

function migrate(raw: ConfigV1 | Config): Config {
    if (raw.version === 2) return raw;
    if (raw.version === 1) {
        // v1 had one login per catalog; it becomes a server with a single account
        return {
            version: 2,
            adminPasswordHash: raw.adminPasswordHash,
            sessionSecret: raw.sessionSecret,
            servers: raw.catalogs.map((c) => ({
                id: c.id,
                name: c.name,
                upstreamUrl: c.upstreamUrl,
                accounts: [{ id: newId(), username: c.username, password: c.password, tokens: c.tokens }],
            })),
        };
    }
    throw new Error(`Unsupported config version ${(raw as { version: unknown }).version}`);
}

/**
 * Persists everything in a single JSON file (mode 0600: it holds upstream passwords).
 * Mutations go through update() and are written atomically, one at a time.
 */
export class Store {
    private tokenIndex = new Map<string, TokenMatch>();
    private writes: Promise<void> = Promise.resolve();
    private touchTimer: ReturnType<typeof setTimeout> | undefined;

    private constructor(readonly path: string, public config: Config) {
        this.reindex();
    }

    static async open(dataDir: string): Promise<Store> {
        await mkdir(dataDir, { recursive: true });
        const path = `${dataDir}/config.json`;
        const file = Bun.file(path);
        if (await file.exists()) {
            const raw = (await file.json()) as ConfigV1 | Config;
            const store = new Store(path, migrate(raw));
            if (raw.version !== store.config.version) await store.save();
            return store;
        }
        const store = new Store(path, { version: 2, sessionSecret: randomBytes(32).toString("hex"), servers: [] });
        await store.save();
        return store;
    }

    get servers(): Server[] {
        return this.config.servers;
    }

    server(id: string): Server | undefined {
        return this.config.servers.find((s) => s.id === id);
    }

    account(serverId: string, accountId: string): { server: Server; account: Account } | undefined {
        const server = this.server(serverId);
        const account = server?.accounts.find((a) => a.id === accountId);
        return server && account ? { server, account } : undefined;
    }

    findToken(token: string): TokenMatch | undefined {
        return this.tokenIndex.get(normalizeToken(token));
    }

    /** Apply a mutation and persist it. */
    async update(mutate: (config: Config) => void): Promise<void> {
        mutate(this.config);
        this.reindex();
        await this.save();
    }

    /** Record reader activity; written lazily since it changes on every request. */
    touch(match: TokenMatch, userAgent: string): void {
        match.token.lastUsedAt = new Date().toISOString();
        match.token.lastUserAgent = userAgent;
        this.touchTimer ??= setTimeout(() => {
            this.touchTimer = undefined;
            void this.save();
        }, 5000);
    }

    async flush(): Promise<void> {
        if (this.touchTimer) {
            clearTimeout(this.touchTimer);
            this.touchTimer = undefined;
            await this.save();
        }
        await this.writes;
    }

    private reindex(): void {
        this.tokenIndex.clear();
        for (const server of this.config.servers) {
            for (const account of server.accounts) {
                for (const token of account.tokens) this.tokenIndex.set(normalizeToken(token.token), { server, account, token });
            }
        }
    }

    private save(): Promise<void> {
        const data = JSON.stringify(this.config, null, 2);
        this.writes = this.writes.then(async () => {
            const tmp = `${this.path}.tmp`;
            await writeFile(tmp, data, { mode: 0o600 });
            await chmod(tmp, 0o600);
            await rename(tmp, this.path);
        });
        return this.writes;
    }
}
