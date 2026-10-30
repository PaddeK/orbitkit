export const USER_AGENT = "orbitkit";
const JSON_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;

export class HttpError extends Error {
    constructor(readonly status: number, readonly body: string, url: string) {
        super(`HTTP ${status} from ${new URL(url).host}: ${body.slice(0, 300)}`);
    }
}

/** A download stopped because the file is bigger than allowed. */
export class TooLargeError extends Error {}

export interface RequestOptions {
    headers?: Record<string, string>;
    /** Sent as application/x-www-form-urlencoded */
    form?: Record<string, string>;
    /** Sent as JSON */
    json?: unknown;
}

async function send(method: string, url: string, options: RequestOptions, timeoutMs: number): Promise<Response> {
    const headers: Record<string, string> = { "user-agent": USER_AGENT, ...options.headers };
    let body: string | undefined;
    if (options.form) {
        body = new URLSearchParams(options.form).toString();
        headers["content-type"] = "application/x-www-form-urlencoded";
    } else if (options.json !== undefined) {
        body = JSON.stringify(options.json);
        headers["content-type"] = "application/json";
    }
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new HttpError(res.status, await res.text(), url);
    return res;
}

/** Send a request and decode the JSON response (null for an empty body). */
export async function requestJson<T>(method: string, url: string, options: RequestOptions = {}): Promise<T> {
    const text = await (await send(method, url, options, JSON_TIMEOUT_MS)).text();
    return (text ? JSON.parse(text) : null) as T;
}

/** The file name from a Content-Disposition header, preferring the UTF-8 form. */
export function dispositionFilename(header: string | null): string | undefined {
    if (!header) return undefined;
    const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
    if (encoded) {
        try {
            return decodeURIComponent(encoded.trim());
        } catch {
            // Malformed: fall back to the plain form
        }
    }
    return /filename\s*=\s*"([^"]*)"/i.exec(header)?.[1] ?? /filename\s*=\s*([^;]+)/i.exec(header)?.[1]?.trim();
}

/** GET a whole file into memory, refusing anything over maxBytes before or while reading it. */
export async function download(url: string, maxBytes: number, headers: Record<string, string> = {}): Promise<{ bytes: Uint8Array; filename?: string }> {
    const res = await send("GET", url, { headers }, DOWNLOAD_TIMEOUT_MS);
    const length = Number(res.headers.get("content-length"));
    const tooLarge = () => new TooLargeError(`larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    if (length > maxBytes) {
        await res.body?.cancel();
        throw tooLarge();
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body ?? []) {
        size += chunk.length;
        // Leaving the loop cancels the rest of the body
        if (size > maxBytes) throw tooLarge();
        chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks, size), filename: dispositionFilename(res.headers.get("content-disposition")) };
}

/** GET url and pass the body to sink chunk by chunk, so large files never sit in memory. */
export async function stream(url: string, sink: (chunk: Uint8Array) => void, headers: Record<string, string> = {}): Promise<void> {
    const res = await send("GET", url, { headers }, DOWNLOAD_TIMEOUT_MS);
    if (!res.body) return;
    for await (const chunk of res.body) sink(chunk);
}
