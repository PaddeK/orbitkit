import type { Server } from "bun";
import { ActivityLog } from "./activity.ts";
import { log } from "./log.ts";
import { AdminRoutes, type AdminOptions } from "./admin/routes.ts";
import { publicOrigin, redirect, textResponse } from "./http.ts";
import { type ProxyResult, proxyRequest } from "./proxy/handler.ts";
import { type Store, accountName, upstreamOf } from "./store.ts";

export interface AppOptions {
    store: Store;
    activity?: ActivityLog;
    setupCode?: string;
    /** The setup code came from SETUP_CODE rather than the log (changes the hint on the setup page) */
    setupCodeFromEnv?: boolean;
    /** Externally visible base URL if the Host header can't be trusted (e.g. behind another reverse proxy) */
    publicUrl?: string;
    upstreamTimeoutMs?: number;
    check?: AdminOptions["check"];
}

export interface App {
    fetch(req: Request, server?: Server<unknown>): Promise<Response>;
    activity: ActivityLog;
    /** Test all account logins in the background so the admin UI shows their status */
    checkAll(): Promise<void>;
}

export function createApp(opts: AppOptions): App {
    const activity = opts.activity ?? new ActivityLog();
    const admin = new AdminRoutes({ store: opts.store, activity, setupCode: opts.setupCode,
        setupCodeFromEnv: opts.setupCodeFromEnv, publicUrl: opts.publicUrl, check: opts.check });

    async function serveReader(req: Request, url: URL, clientIp: string): Promise<Response> {
        const [, first = "", ...rest] = url.pathname.split("/");
        const match = opts.store.findToken(decodeURIComponentSafe(first));
        const userAgent = req.headers.get("user-agent") ?? "-";
        const fullPath = "/***" + (rest.length ? "/" + rest.join("/") : "") + url.search; // token masked
        // The base64 part of file links is just the upstream URL again (shown separately), so shorten it
        const maskedPath = fullPath.replace(/\/_f\/[^/]+\//, "/_f/…/");

        if (!match || (req.method !== "GET" && req.method !== "HEAD")) {
            activity.add({ at: new Date().toISOString(), ip: clientIp, method: req.method, path: maskedPath, fullPath, status: 404,
                note: match ? "method not allowed" : "unknown token", userAgent });
            return textResponse("Not found", 404);
        }

        opts.store.touch(match, userAgent);
        const publicBase = `${publicOrigin(req, opts.publicUrl)}/${match.token.token}`;
        const publicPath = url.pathname.slice(1 + first.length);
        let result: ProxyResult;
        try {
            result = await proxyRequest(req, upstreamOf(match.server, match.account), publicPath, url.search, publicBase, opts.upstreamTimeoutMs);
        } catch (err) {
            log.error(`proxy error: ${(err as Error).stack ?? String(err)}`);
            result = { response: textResponse("Internal error", 500), note: `error: ${(err as Error).message}` };
        }
        activity.add({ at: new Date().toISOString(), ip: clientIp, method: req.method, path: maskedPath, fullPath,
            upstreamUrl: result.upstreamUrl, status: result.response.status, note: result.note,
            userAgent, serverId: match.server.id, serverName: match.server.name, accountName: accountName(match.account),
            tokenLabel: match.token.label });
        return result.response;
    }

    return {
        activity,
        checkAll: () => admin.checkAll(),
        async fetch(req, server) {
            const url = new URL(req.url);
            const clientIp = server?.requestIP(req)?.address ?? "-";
            if (url.pathname === "/healthz") return textResponse("ok", 200);
            if (url.pathname === "/" || url.pathname === "/favicon.ico") return url.pathname === "/" ? redirect("/admin") : textResponse("", 404);
            if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return admin.handle(req, clientIp);
            return serveReader(req, url, clientIp);
        },
    };
}

function decodeURIComponentSafe(text: string): string {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
}
