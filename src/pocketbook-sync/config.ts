import { ConfigError, type Settings } from "../settings.ts";
import type { Shared } from "../config.ts";
import { DEFAULT_URL as POCKETBOOK_URL } from "./pocketbook.ts";

/** Sending the books of a BookOrbit collection to PocketBook Cloud (POCKETBOOK_SYNC_COLLECTION). */
export interface CollectionConfig {
    /** The BookOrbit collection */
    name: string;
    /** BookOrbit API key of the collection's owner: read access with "Download books" is enough */
    apiKey: string;
    /** The PocketBook Cloud collection the books go into, shown as a shelf on the reader */
    cloudCollection: string;
}

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
    /** Log the progress that would be sent and the books that would be uploaded instead (POCKETBOOK_SYNC_DRY_RUN) */
    dryRun: boolean;
    collection?: CollectionConfig;
}

const MIN_SYNC_INTERVAL = 30;

/** PocketBook Sync settings: POCKETBOOK_SYNC_* and BOOKORBIT_URL. */
export function pocketbookSyncConfig(settings: Settings, shared: Shared): Config {
    const deviceId = settings.get("POCKETBOOK_SYNC_DEVICE_ID");
    if (deviceId && !/^[A-Za-z0-9-]{1,100}$/.test(deviceId)) {
        throw new ConfigError("POCKETBOOK_SYNC_DEVICE_ID may only contain letters, digits and hyphens (BookOrbit's rule)");
    }
    let collection: CollectionConfig | undefined;
    const collectionName = settings.get("POCKETBOOK_SYNC_COLLECTION");
    if (collectionName) {
        const apiKey = settings.get("POCKETBOOK_SYNC_BOOKORBIT_API_KEY", true) ?? "";
        if (apiKey && !apiKey.startsWith("bok_")) {
            throw new ConfigError("POCKETBOOK_SYNC_BOOKORBIT_API_KEY is not a BookOrbit API key, which starts with bok_ (Settings > You > API keys in BookOrbit 3.8 or newer)");
        }
        const cloudCollection = settings.get("POCKETBOOK_SYNC_CLOUD_COLLECTION") ?? collectionName;
        if (cloudCollection.length < 3 || cloudCollection.length > 255) {
            throw new ConfigError(`PocketBook Cloud collection names have 3 to 255 characters; set POCKETBOOK_SYNC_CLOUD_COLLECTION to use another name than "${cloudCollection}"`);
        }
        collection = { name: collectionName, apiKey, cloudCollection };
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
        collection,
    };
}
