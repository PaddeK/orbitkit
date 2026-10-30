/** Timestamped log lines, so `docker logs` shows when each sync happened. */
function line(level: string, scope: string | undefined, message: string): string {
    const now = new Date();
    const stamp = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 19).replace("T", " ");
    return `${stamp} ${level} ${scope ? `[${scope}] ` : ""}${message}`;
}

export interface Logger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

/** A logger whose lines name the feature they come from, e.g. "[epub-check]". */
export function scoped(scope?: string): Logger {
    return {
        info: (message) => console.log(line("INFO", scope, message)),
        warn: (message) => console.warn(line("WARN", scope, message)),
        error: (message) => console.error(line("ERROR", scope, message)),
    };
}

export const log = scoped();
