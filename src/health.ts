import { STATE_FILE as EPUB_CHECK_STATE_FILE, type StateData as EpubCheckState } from "./epub-check/state.ts";
import type { Config } from "./config.ts";
import { STATE_FILE as POCKETBOOK_SYNC_STATE_FILE, type StateData as PocketbookSyncState } from "./pocketbook-sync/state.ts";

/** Slack on top of two intervals, for slow downloads and a long first run */
const SLACK_MS = 120_000;

/**
 * What is wrong with the running features, for Docker's HEALTHCHECK (orbitkit --healthcheck); empty when all is well.
 * Runs in a process of its own, so it judges by the state files and the HTTP ports.
 */
export async function problems(config: Config): Promise<string[]> {
    const found: string[] = [];
    const recent = (last: number | undefined, intervalSeconds: number) => !!last && Date.now() - last <= 2 * intervalSeconds * 1000 + SLACK_MS;
    const answers = async (port: number) => {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
        return !!res?.ok;
    };

    if (config.epubCheck) {
        const state = (await Bun.file(`${config.epubCheck.dataDir}/${EPUB_CHECK_STATE_FILE}`).json().catch(() => null)) as Partial<EpubCheckState> | null;
        // A long first run over a big library counts as healthy while it checks book after book
        if (!recent(Math.max(state?.lastSuccess ?? 0, state?.lastProgress ?? 0), config.epubCheck.checkInterval)) found.push("epub-check: no recent successful cycle");
        if (!(await answers(config.epubCheck.port))) found.push(`epub-check: report pages on port ${config.epubCheck.port} do not answer`);
    }
    if (config.pocketbookSync) {
        const state = (await Bun.file(`${config.pocketbookSync.dataDir}/${POCKETBOOK_SYNC_STATE_FILE}`).json().catch(() => null)) as Partial<PocketbookSyncState> | null;
        if (!recent(state?.lastSuccess, config.pocketbookSync.syncInterval)) found.push("pocketbook-sync: no recent successful sync");
    }
    if (config.opdsProxy && !(await answers(config.opdsProxy.port))) found.push(`opds-proxy: port ${config.opdsProxy.port} does not answer`);
    return found;
}
