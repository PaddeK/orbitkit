import { ConfigError, type Settings } from "../settings.ts";
import type { Shared } from "../config.ts";

export interface Config {
    bookorbitUrl: string;
    bookorbitUser: string;
    bookorbitPassword: string;
    /** Where browsers reach BookOrbit, for links on the report pages; BOOKORBIT_URL may be an internal address */
    bookorbitPublicUrl: string;
    /** How BookOrbit users reach the report pages; without it no report link is stored in BookOrbit */
    reportUrl?: string;
    /** Port of the report pages */
    port: number;
    /** Also serve the pages below this path, e.g. "/api/orbitkit" to put them under BookOrbit's address; "" for none */
    basePath: string;
    /** Let only BookOrbit users with the "Manage libraries" permission see the report pages */
    requireLogin: boolean;
    /** Seconds */
    checkInterval: number;
    /** Bytes; bigger EPUBs are not downloaded */
    maxFileSize: number;
    dataDir: string;
    /** Check, but change nothing in BookOrbit: no custom fields, no replaced books (EPUB_CHECK_DRY_RUN) */
    dryRun: boolean;
    /** Offer orbitkit's own fixes, for defects epubsana does not repair */
    ownFixes: boolean;
    /** Offer upgrading EPUB 2 books to EPUB 3 with epublift */
    epublift: boolean;
    /** The epublift program: a path, or a name looked up in PATH */
    epubliftPath: string;
    /** Allow replacing books in the library with their repaired version; needs the library mounted read-write */
    replaceInLibrary: boolean;
}

export const DEFAULT_PORT = 8602;
const MIN_CHECK_INTERVAL = 60;

/** EPUB Check settings: EPUB_CHECK_* and the shared BookOrbit login. */
export function epubCheckConfig(settings: Settings, shared: Shared): Config {
    const bookorbit = shared.bookorbit(true);
    const basePath = (settings.get("EPUB_CHECK_BASE_PATH") ?? "").replace(/\/+$/, "");
    if (basePath && (!/^(\/[A-Za-z0-9._~-]+)+$/.test(basePath) || basePath.split("/").some((s) => s === "." || s === ".."))) {
        throw new ConfigError(`EPUB_CHECK_BASE_PATH must be a path like /api/orbitkit, got "${basePath}"`);
    }
    return {
        bookorbitUrl: bookorbit.url,
        bookorbitUser: bookorbit.user,
        bookorbitPassword: bookorbit.password,
        bookorbitPublicUrl: bookorbit.publicUrl,
        reportUrl: settings.url("EPUB_CHECK_REPORT_URL"),
        port: settings.whole("EPUB_CHECK_PORT", DEFAULT_PORT, 1),
        basePath,
        requireLogin: settings.flag("EPUB_CHECK_REQUIRE_LOGIN", true),
        checkInterval: settings.whole("EPUB_CHECK_INTERVAL", 300, MIN_CHECK_INTERVAL),
        maxFileSize: settings.whole("EPUB_CHECK_MAX_FILE_SIZE_MB", 200, 1) * 1024 * 1024,
        dataDir: `${shared.dataDir}/epub-check`,
        dryRun: settings.flag("EPUB_CHECK_DRY_RUN"),
        ownFixes: settings.flag("EPUB_CHECK_FIXES"),
        epublift: settings.flag("EPUB_CHECK_EPUBLIFT"),
        epubliftPath: settings.get("EPUB_CHECK_EPUBLIFT_PATH") ?? "epublift",
        replaceInLibrary: settings.flag("EPUB_CHECK_REPLACE_IN_LIBRARY"),
    };
}
