import { every, type Feature } from "../feature.ts";
import { HttpError } from "../http.ts";
import type { Config } from "./config.ts";
import { log } from "./log.ts";
import { State } from "./state.ts";
import { Bridge } from "./sync.ts";

/** PocketBook Sync: sends the percentages read on PocketBook readers to BookOrbit, and the books of a BookOrbit collection to the readers. */
export async function createPocketbookSync(config: Config): Promise<Feature> {
    const state = await State.open(config.dataDir);
    const bridge = new Bridge(config, state);
    let loop: { stop(): void } | undefined;

    return {
        name: "pocketbook-sync",
        start() {
            log.info(`syncing every ${config.syncInterval}s as device "${config.deviceName}"${config.dryRun ? " (dry run: nothing is sent)" : ""}`);
            void bridge.bookorbit.checkAuth().then(
                (user) => log.info(`BookOrbit KOReader sync: logged in as ${user}`),
                (err) => log.error(err instanceof HttpError
                    ? `BookOrbit KOReader sync login failed, check BOOKORBIT_URL, POCKETBOOK_SYNC_KOREADER_USER and POCKETBOOK_SYNC_KOREADER_PASSWORD: ${err.message}`
                    : `BookOrbit is not reachable: ${(err as Error).message}`));
            if (bridge.collection) {
                const collection = config.collection!;
                void bridge.collection.bookorbit.checkAuth().then(
                    (user) => log.info(`sending the BookOrbit collection "${collection.name}" of ${user} to the PocketBook collection "${collection.cloudCollection}"`),
                    (err) => {
                        // Unreachable is said above already; the collection is tried again every cycle
                        if (err instanceof HttpError) log.error(`BookOrbit refused POCKETBOOK_SYNC_BOOKORBIT_API_KEY, the collection is not sent: ${err.message}`);
                    });
            }
            loop = every(config.syncInterval, log, () => bridge.cycle());
        },
        async once() {
            try {
                await bridge.cycle();
                return true;
            } catch (err) {
                log.error(`cycle failed: ${(err as Error).message}`);
                return false;
            }
        },
        async stop() {
            loop?.stop();
            await state.save();
        },
    };
}
