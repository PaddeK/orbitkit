import { log } from "./log.ts";

export interface ActivityEntry {
    at: string;
    ip: string;
    method: string;
    /** Request path with the access token masked and file links shortened, for display */
    path: string;
    /** Same, but not shortened */
    fullPath: string;
    /** Upstream URL the request was forwarded to */
    upstreamUrl?: string;
    status: number;
    note: string;
    userAgent: string;
    serverId?: string;
    serverName?: string;
    /** Upstream username the request was made as ("Anonymous" if none) */
    accountName?: string;
    tokenLabel?: string;
}

/** In-memory ring buffer of recent reader requests, shown in the admin UI for troubleshooting. */
export class ActivityLog {
    private entries: ActivityEntry[] = [];

    constructor(private readonly capacity = 200) {}

    add(entry: ActivityEntry): void {
        this.entries.push(entry);
        if (this.entries.length > this.capacity) this.entries.shift();
        const who = entry.tokenLabel ? ` [${entry.tokenLabel} as ${entry.accountName}]` : "";
        log.info(`${entry.ip} "${entry.method} ${entry.path}" ${entry.status}${entry.note ? " " + entry.note : ""}${who} ua="${entry.userAgent}"`);
    }

    recent(limit = 50, serverId?: string): ActivityEntry[] {
        const list = serverId ? this.entries.filter((e) => e.serverId === serverId) : this.entries;
        return list.slice(-limit).reverse();
    }
}
