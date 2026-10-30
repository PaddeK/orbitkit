import { ConfigError, type Settings } from "../settings.ts";
import type { Shared } from "../config.ts";
import { DEFAULT_URL as POCKETBOOK_URL } from "./pocketbook.ts";

export interface Config {
    pbEmail: string;
    pbPassword: string;
    /** Only needed if the account belongs to several PocketBook shops */
    pbShop?: string;
    pbUrl: string;
    bookorbitUrl: string;
    /** BookOrbit's KOReader sync login (Settings > KOReader in BookOrbit), not the web login */
    koreaderUser: string;
    koreaderPassword: string;
    deviceName: string;
    /** Used on the first start only; afterwards the ID in the state file wins */
    deviceId?: string;
    /** Seconds */
    syncInterval: number;
    dataDir: string;
    /** Log the progress that would be sent instead of sending it (POCKETBOOK_SYNC_DRY_RUN) */
    dryRun: boolean;
}

const MIN_SYNC_INTERVAL = 30;

/** PocketBook Sync settings: POCKETBOOK_SYNC_* and BOOKORBIT_URL. */
export function pocketbookSyncConfig(settings: Settings, shared: Shared): Config {
    const deviceId = settings.get("POCKETBOOK_SYNC_DEVICE_ID");
    if (deviceId && !/^[A-Za-z0-9-]{1,100}$/.test(deviceId)) {
        throw new ConfigError("POCKETBOOK_SYNC_DEVICE_ID may only contain letters, digits and hyphens (BookOrbit's rule)");
    }
    return {
        pbEmail: settings.get("POCKETBOOK_SYNC_EMAIL", true) ?? "",
        pbPassword: settings.get("POCKETBOOK_SYNC_PASSWORD", true) ?? "",
        pbShop: settings.get("POCKETBOOK_SYNC_SHOP"),
        pbUrl: settings.url("POCKETBOOK_SYNC_API_URL") ?? POCKETBOOK_URL,
        bookorbitUrl: shared.bookorbit(false).url,
        koreaderUser: settings.get("POCKETBOOK_SYNC_KOREADER_USER", true) ?? "",
        koreaderPassword: settings.get("POCKETBOOK_SYNC_KOREADER_PASSWORD", true) ?? "",
        deviceName: settings.get("POCKETBOOK_SYNC_DEVICE_NAME") ?? "PocketBook",
        deviceId,
        syncInterval: settings.whole("POCKETBOOK_SYNC_INTERVAL", 300, MIN_SYNC_INTERVAL),
        dataDir: `${shared.dataDir}/pocketbook-sync`,
        dryRun: settings.flag("POCKETBOOK_SYNC_DRY_RUN"),
    };
}
