import { epubCheckConfig, type Config as EpubCheckConfig } from "./epub-check/config.ts";
import { opdsProxyConfig, type Config as OpdsProxyConfig } from "./opds-proxy/config.ts";
import { pocketbookSyncConfig, type Config as PocketbookSyncConfig } from "./pocketbook-sync/config.ts";
import { ConfigError, Settings, type Env } from "./settings.ts";

export { ConfigError };

/** The BookOrbit instance the features work with. */
export interface BookOrbitSettings {
    /** How orbitkit reaches BookOrbit, e.g. http://app:3000 inside its Docker stack */
    url: string;
    /** How browsers reach BookOrbit, for links; BOOKORBIT_URL unless set */
    publicUrl: string;
    /** BookOrbit web login, for features that use the web API */
    user: string;
    password: string;
}

/** What every feature may use. */
export interface Shared {
    dataDir: string;
    /** BOOKORBIT_*; `login` makes BOOKORBIT_USER and BOOKORBIT_PASSWORD required */
    bookorbit(login: boolean): BookOrbitSettings;
}

export interface Config {
    dataDir: string;
    epubCheck?: EpubCheckConfig;
    pocketbookSync?: PocketbookSyncConfig;
    opdsProxy?: OpdsProxyConfig;
    /** Settings of the separate tools orbitkit replaces, which it ignores */
    legacy: string[];
}

/** Each feature is turned on by its *_ENABLED setting. */
export const FEATURES = [
    { key: "epubCheck", setting: "EPUB_CHECK_ENABLED", what: "EPUB Check" },
    { key: "pocketbookSync", setting: "POCKETBOOK_SYNC_ENABLED", what: "PocketBook Sync" },
    { key: "opdsProxy", setting: "OPDS_PROXY_ENABLED", what: "OPDS Proxy" },
] as const;

/** Settings of orbitcheck, pocketorbit and opds-proxy, and what replaces them. */
const LEGACY: Record<string, string> = {
    PORT: "EPUB_CHECK_PORT or OPDS_PROXY_PORT",
    DRY_RUN: "EPUB_CHECK_DRY_RUN or POCKETBOOK_SYNC_DRY_RUN",
    REPORT_URL: "EPUB_CHECK_REPORT_URL",
    REPORT_USER: "the BookOrbit login (EPUB_CHECK_REQUIRE_LOGIN)",
    REPORT_PASSWORD: "the BookOrbit login (EPUB_CHECK_REQUIRE_LOGIN)",
    CHECK_INTERVAL: "EPUB_CHECK_INTERVAL",
    MAX_FILE_SIZE_MB: "EPUB_CHECK_MAX_FILE_SIZE_MB",
    ORBITCHECK_FIXES: "EPUB_CHECK_FIXES",
    EPUBLIFT: "EPUB_CHECK_EPUBLIFT",
    EPUBLIFT_PATH: "EPUB_CHECK_EPUBLIFT_PATH",
    REPLACE_IN_LIBRARY: "EPUB_CHECK_REPLACE_IN_LIBRARY",
    PB_EMAIL: "POCKETBOOK_SYNC_EMAIL",
    PB_PASSWORD: "POCKETBOOK_SYNC_PASSWORD",
    PB_SHOP: "POCKETBOOK_SYNC_SHOP",
    PB_API_URL: "POCKETBOOK_SYNC_API_URL",
    DEVICE_NAME: "POCKETBOOK_SYNC_DEVICE_NAME",
    DEVICE_ID: "POCKETBOOK_SYNC_DEVICE_ID",
    SYNC_INTERVAL: "POCKETBOOK_SYNC_INTERVAL",
    PUBLIC_URL: "OPDS_PROXY_PUBLIC_URL",
    ADMIN_PASSWORD: "OPDS_PROXY_ADMIN_PASSWORD",
    SETUP_CODE: "OPDS_PROXY_SETUP_CODE",
    UPSTREAM_TIMEOUT: "OPDS_PROXY_UPSTREAM_TIMEOUT",
};

/** All settings, from environment variables. Throws ConfigError with a message for the user. */
export function loadConfig(env: Env = process.env): Config {
    const settings = new Settings(env);
    const enabled = new Set(FEATURES.filter((f) => settings.flag(f.setting)).map((f) => f.key));
    if (enabled.size === 0) {
        throw new ConfigError(`No feature is enabled. Turn on at least one: ${FEATURES.map((f) => `${f.setting} (${f.what})`).join(", ")}`);
    }

    let bookorbit: BookOrbitSettings | undefined;
    const shared: Shared = {
        dataDir: (settings.get("DATA_DIR") ?? "/data").replace(/\/+$/, ""),
        bookorbit(login) {
            bookorbit ??= {
                url: settings.url("BOOKORBIT_URL", true) ?? "",
                publicUrl: settings.url("BOOKORBIT_PUBLIC_URL") ?? "",
                user: "",
                password: "",
            };
            bookorbit.publicUrl ||= bookorbit.url;
            if (login && !bookorbit.user) {
                bookorbit.user = settings.get("BOOKORBIT_USER", true) ?? "";
                bookorbit.password = settings.get("BOOKORBIT_PASSWORD", true) ?? "";
            }
            return bookorbit;
        },
    };

    const config: Config = {
        dataDir: shared.dataDir,
        epubCheck: enabled.has("epubCheck") ? epubCheckConfig(settings, shared) : undefined,
        pocketbookSync: enabled.has("pocketbookSync") ? pocketbookSyncConfig(settings, shared) : undefined,
        opdsProxy: enabled.has("opdsProxy") ? opdsProxyConfig(settings, shared) : undefined,
        legacy: Object.keys(LEGACY).filter((name) => settings.has(name)).map((name) => `${name} (now ${LEGACY[name]})`),
    };
    if (settings.missing.length) {
        const missing = [...new Set(settings.missing)];
        throw new ConfigError(`Missing required settings: ${missing.join(", ")} (set them, or NAME_FILE pointing to a file with the value)`);
    }
    if (config.epubCheck && config.opdsProxy && config.epubCheck.port === config.opdsProxy.port) {
        throw new ConfigError(`EPUB_CHECK_PORT and OPDS_PROXY_PORT are both ${config.epubCheck.port}; each feature needs its own port`);
    }
    return config;
}
