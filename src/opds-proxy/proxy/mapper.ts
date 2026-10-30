/**
 * Maps upstream OPDS URLs to proxy URLs and back.
 *
 * Feeds (navigation/acquisition/search) are mirrored below the public base:
 *   upstream  http://bookorbit:3000/api/v1/opds/recent?page=2
 *   public    http://proxy:8601/<token>/recent?page=2
 *
 * Files (books, covers) get a self-describing URL ending in a real filename,
 * because some readers derive the saved filename/format from the URL:
 *   public    http://proxy:8601/<token>/_f/<base64url(upstream tail)>/Some Title.epub
 */

export const FILE_PREFIX = "/_f/";

export class InvalidPath extends Error {}

function b64encode(text: string): string {
    return Buffer.from(text, "utf8").toString("base64url");
}

function b64decode(token: string): string {
    if (!/^[A-Za-z0-9_-]*$/.test(token)) throw new InvalidPath("bad file token");
    return Buffer.from(token, "base64url").toString("utf8");
}

function checkTail(tail: string): void {
    if (tail && tail[0] !== "/" && tail[0] !== "?") throw new InvalidPath("path must start with '/'");
    const path = tail.split("?", 1)[0] ?? "";
    let decoded: string;
    try {
        decoded = decodeURIComponent(path);
    } catch {
        throw new InvalidPath("bad percent-encoding");
    }
    // The proxy authenticates with the upstream's credentials, so it must never
    // be steerable outside the OPDS subtree (e.g. /api/v1/opds/../admin).
    for (const segment of decoded.replaceAll("\\", "/").split("/")) {
        if (segment === "." || segment === "..") throw new InvalidPath("dot segments are not allowed");
    }
}

export class UrlMapper {
    readonly upstreamOrigin: string;
    readonly upstreamBasePath: string;
    readonly publicBase: string;

    constructor(upstreamUrl: string, publicBase: string) {
        const u = new URL(upstreamUrl);
        this.upstreamOrigin = u.origin;
        this.upstreamBasePath = u.pathname.replace(/\/+$/, "");
        this.publicBase = publicBase.replace(/\/+$/, "");
    }

    // --- upstream -> public ---------------------------------------------------

    /** Part of an absolute upstream URL below the OPDS base path, or null if outside it. */
    tailOf(absoluteUrl: string): string | null {
        let u: URL;
        try {
            u = new URL(absoluteUrl);
        } catch {
            return null;
        }
        if (u.origin !== this.upstreamOrigin || !u.pathname.startsWith(this.upstreamBasePath)) return null;
        const rest = u.pathname.slice(this.upstreamBasePath.length);
        if (rest && !rest.startsWith("/")) return null; // e.g. /api/v1/opdsfoo
        return rest + u.search;
    }

    feedUrl(tail: string): string {
        return this.publicBase + (tail.startsWith("/") ? tail : "/" + tail);
    }

    fileUrl(tail: string, filename: string): string {
        return `${this.publicBase}${FILE_PREFIX}${b64encode(tail)}/${encodeURIComponent(filename)}`;
    }

    // --- public -> upstream ---------------------------------------------------

    /** Upstream URL for a request path (already stripped of the token prefix); `search` includes the "?". */
    upstreamUrl(publicPath: string, search = ""): string {
        let tail: string;
        if (publicPath.startsWith(FILE_PREFIX)) {
            tail = b64decode(publicPath.slice(FILE_PREFIX.length).split("/", 1)[0] ?? "");
        } else {
            tail = (publicPath === "" || publicPath === "/" ? "" : publicPath) + search;
        }
        checkTail(tail);
        return this.upstreamOrigin + this.upstreamBasePath + tail;
    }
}
