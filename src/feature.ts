import type { Logger } from "./log.ts";

/** One of orbitkit's features, as the entry point runs it. */
export interface Feature {
    name: string;
    /** Start its servers and background loops */
    start(): void;
    /** Run one cycle of its background work, for --once; false if it failed */
    once(): Promise<boolean>;
    /** Stop and save */
    stop(): Promise<void>;
}

/** After a failed cycle, try again within a minute: when BookOrbit restarts with this container, it is not up yet */
const RETRY_SECONDS = 60;

/**
 * Run `cycle` every `intervalSeconds` until stopped. A failed cycle is logged and retried sooner; it never ends the
 * loop or touches the other features. The healthcheck reports lasting failures.
 */
export function every(intervalSeconds: number, log: Logger, cycle: () => Promise<unknown>): { stop(): void } {
    let stopped = false;
    let wake: (() => void) | undefined;
    void (async () => {
        while (!stopped) {
            let failed = false;
            try {
                await cycle();
            } catch (err) {
                log.error(`cycle failed: ${(err as Error).message}`);
                failed = true;
            }
            const seconds = failed ? Math.min(RETRY_SECONDS, intervalSeconds) : intervalSeconds;
            await new Promise<void>((resolve) => {
                wake = resolve;
                setTimeout(resolve, seconds * 1000);
            });
        }
    })();
    return {
        stop() {
            stopped = true;
            wake?.();
        },
    };
}
