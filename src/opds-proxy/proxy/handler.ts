import type { Upstream } from "../store.ts";
import { FILE_PREFIX, InvalidPath, UrlMapper } from "./mapper.ts";
import { XmlError, baseMime, rewriteDocument } from "./rewrite.ts";

const MAX_FEED_BYTES = 20 * 1024 * 1024;
const REWRITE_TYPES = new Set(["application/atom+xml", "application/opensearchdescription+xml", "application/xml", "text/xml"]);
const FORWARD_REQUEST_HEADERS = ["range", "if-range", "if-none-match", "if-modified-since", "accept-language"];
const FORWARD_RESPONSE_HEADERS = ["content-type", "content-length", "content-disposition", "content-range",
    "accept-ranges", "etag", "last-modified"];

export interface ProxyResult {
    response: Response;
    /** Short explanation for the activity log */
    note: string;
    /** Where the request was forwarded to, if it got that far */
    upstreamUrl?: string;
}

export function basicAuth(username: string, password: string): string {
    return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

/** fetch() against the upstream; the timeout covers connecting and headers, not streaming the body. */
export async function fetchUpstream(upstream: Upstream, url: string, init: { method?: string; headers?: Record<string, string> } = {},
                                    timeoutMs = 60_000): Promise<Response> {
    const headers: Record<string, string> = { ...init.headers, "accept-encoding": "identity" };
    if (upstream.username) headers.authorization = basicAuth(upstream.username, upstream.password);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`no response within ${timeoutMs / 1000}s`)), timeoutMs);
    try {
        return await fetch(url, { method: init.method ?? "GET", headers, redirect: "manual", signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
    if (!body) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of body) {
        size += chunk.byteLength;
        if (size > max) {
            await body.cancel().catch(() => {});
            return null;
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function contentDisposition(filename: string): string {
    const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replaceAll('"', "");
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function text(status: number, body: string, note: string): ProxyResult {
    return { response: new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } }), note };
}

/**
 * Serve one reader request against `target` (a server URL plus the account to log in as).
 * @param publicPath request path below the token, e.g. "/recent" or "/_f/…/book.epub"
 * @param search     raw query string including "?", or ""
 * @param publicBase externally visible URL of the token root, e.g. http://host:8601/k7m2-x9qp-4rtw-b8nd
 */
export async function proxyRequest(req: Request, target: Upstream, publicPath: string, search: string,
                                   publicBase: string, timeoutMs?: number): Promise<ProxyResult> {
    const mapper = new UrlMapper(target.upstreamUrl, publicBase);
    let upstreamUrl: string;
    try {
        upstreamUrl = mapper.upstreamUrl(publicPath, search);
    } catch (err) {
        if (err instanceof InvalidPath) return text(400, "Bad request", err.message);
        throw err;
    }
    return { ...(await forward(req, target, mapper, upstreamUrl, publicPath, timeoutMs)), upstreamUrl };
}

async function forward(req: Request, target: Upstream, mapper: UrlMapper, upstreamUrl: string, publicPath: string,
                       timeoutMs?: number): Promise<ProxyResult> {
    const isFile = publicPath.startsWith(FILE_PREFIX);
    const headers: Record<string, string> = {};
    for (const name of FORWARD_REQUEST_HEADERS) {
        const value = req.headers.get(name);
        if (value) headers[name] = value;
    }

    let upstream: Response;
    try {
        upstream = await fetchUpstream(target, upstreamUrl, { method: req.method, headers }, timeoutMs);
    } catch (err) {
        return text(502, "Upstream unreachable", `upstream-error: ${(err as Error).message}`);
    }

    if (upstream.status === 401 || upstream.status === 403) {
        await upstream.body?.cancel();
        return text(502, "Upstream rejected the proxy's credentials", `upstream-auth-failed ${upstream.status} (check the account's username/password)`);
    }

    const location = upstream.headers.get("location");
    if (upstream.status >= 300 && upstream.status < 400 && location) {
        await upstream.body?.cancel();
        const tail = mapper.tailOf(new URL(location, upstreamUrl).toString());
        return { response: new Response(null, { status: upstream.status, headers: { location: tail === null ? location : mapper.feedUrl(tail) } }), note: "redirect" };
    }

    const outHeaders = new Headers();
    for (const name of FORWARD_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) outHeaders.set(name, value);
    }
    if ((upstream.headers.get("content-encoding") ?? "identity") !== "identity") {
        outHeaders.delete("content-length"); // fetch() decodes the body on the way through
    }
    const mime = baseMime(upstream.headers.get("content-type"));

    if (!isFile && upstream.status === 200 && REWRITE_TYPES.has(mime)) {
        const raw = await readCapped(upstream.body, MAX_FEED_BYTES);
        if (!raw) return text(502, "Upstream feed too large", "feed-too-large");
        let body = new TextDecoder().decode(raw);
        let note: string;
        try {
            body = rewriteDocument(body, upstreamUrl, mapper);
            note = `rewritten ${Buffer.byteLength(body)}B`;
        } catch (err) {
            if (!(err instanceof XmlError)) throw err;
            note = `unparseable XML passed through: ${err.message.slice(0, 120)}`;
        }
        // Plain media type without OPDS profile parameters, like Calibre-Web sends; PocketBook's reader is happy with that
        outHeaders.set("content-type", `${mime}; charset=utf-8`);
        outHeaders.set("content-length", String(Buffer.byteLength(body)));
        return { response: new Response(req.method === "HEAD" ? null : body, { status: 200, headers: outHeaders }), note };
    }

    if (isFile && upstream.status === 200 && !outHeaders.has("content-disposition")) {
        try {
            const filename = decodeURIComponent(publicPath.slice(publicPath.lastIndexOf("/") + 1));
            if (filename) outHeaders.set("content-disposition", contentDisposition(filename));
        } catch {
            // malformed filename segment: just don't suggest one
        }
    }

    const size = upstream.headers.get("content-length");
    if (req.method === "HEAD") {
        await upstream.body?.cancel();
        return { response: new Response(null, { status: upstream.status, headers: outHeaders }), note: size ? `${size}B` : "" };
    }
    return { response: new Response(upstream.body, { status: upstream.status, headers: outHeaders }), note: size ? `${size}B` : "" };
}
