import type { Upstream } from "../store.ts";
import { fetchUpstream } from "./handler.ts";
import { localName, parseXml, textContent } from "./rewrite.ts";

export interface CheckResult {
    ok: boolean;
    message: string;
    at: string;
}

/** Fetch the root feed as the given account and describe what came back. */
export async function checkUpstream(upstream: Upstream, timeoutMs = 10_000): Promise<CheckResult> {
    const at = new Date().toISOString();
    const fail = (message: string): CheckResult => ({ ok: false, message, at });
    let res: Response;
    try {
        res = await fetchUpstream(upstream, upstream.upstreamUrl, { headers: { accept: "application/atom+xml" } }, timeoutMs);
    } catch (err) {
        return fail(`Could not reach ${upstream.upstreamUrl}: ${(err as Error).message}. Is the URL reachable from inside this container?`);
    }
    if (res.status === 401 || res.status === 403) {
        await res.body?.cancel();
        return fail(upstream.username
            ? `The server rejected the login (HTTP ${res.status}). Check username and password.`
            : `The server requires a login (HTTP ${res.status}). Enter a username and password.`);
    }
    if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        return fail(`The upstream redirects to ${res.headers.get("location")}. Use that URL instead.`);
    }
    if (!res.ok) {
        await res.body?.cancel();
        return fail(`The upstream answered HTTP ${res.status}. Is this the OPDS root URL?`);
    }
    try {
        const root = parseXml(await res.text());
        if (localName(root) !== "feed") return fail("The upstream answered, but not with an OPDS (Atom) feed. Is this the OPDS root URL?");
        let title = "";
        let entries = 0;
        for (const n of root.children) {
            if (typeof n !== "object" || !("name" in n)) continue;
            if (localName(n) === "title" && !title) title = textContent(n).trim();
            if (localName(n) === "entry") entries++;
        }
        const who = upstream.username ? ` as ${upstream.username}` : " anonymously";
        return { ok: true, message: `Connected${who} to “${title || "untitled feed"}” (${entries} entries).`, at };
    } catch {
        return fail("The upstream answered, but the response is not valid XML. Is this the OPDS root URL?");
    }
}
