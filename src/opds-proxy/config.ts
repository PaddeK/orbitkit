import type { Settings } from "../settings.ts";
import type { Shared } from "../config.ts";

export interface Config {
    port: number;
    /** Externally visible base URL, if the Host header can't be trusted (e.g. behind another reverse proxy) */
    publicUrl?: string;
    /** (Re)sets the admin password on every start */
    adminPassword?: string;
    /** Code for the first-start setup page; without it a random one is logged */
    setupCode?: string;
    upstreamTimeoutMs: number;
    dataDir: string;
}

export const DEFAULT_PORT = 8601;

/** OPDS Proxy settings: OPDS_PROXY_*. It needs no BookOrbit login: readers bring the catalog's. */
export function opdsProxyConfig(settings: Settings, shared: Shared): Config {
    return {
        port: settings.whole("OPDS_PROXY_PORT", DEFAULT_PORT, 1),
        publicUrl: settings.url("OPDS_PROXY_PUBLIC_URL"),
        adminPassword: settings.get("OPDS_PROXY_ADMIN_PASSWORD"),
        setupCode: settings.get("OPDS_PROXY_SETUP_CODE"),
        upstreamTimeoutMs: settings.whole("OPDS_PROXY_UPSTREAM_TIMEOUT", 60, 1) * 1000,
        dataDir: `${shared.dataDir}/opds-proxy`,
    };
}
