#!/usr/bin/env bun
/**
 * Crawl a running opds-proxy like an e-reader would and report anything broken.
 * The reader token is masked in the output, so it can be shared in a bug report.
 *
 *   bun scripts/crawl.ts http://192.168.0.10:8601/<token>/ [--max-feeds 200] [--search whale]
 */
import { XmlError, elements, localName, parseXml, textContent } from "../src/opds-proxy/proxy/rewrite.ts";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: { "max-feeds": { type: "string", default: "200" }, search: { type: "string", default: "a" } },
    allowPositionals: true,
});
const root = positionals[0];
if (!root) {
    console.error("usage: bun scripts/crawl.ts <reader-url> [--max-feeds N] [--search term]");
    process.exit(2);
}

const prefix = root.replace(/\/+$/, ""); // every proxied link must stay below the reader URL
// The token is the last path segment of the reader URL (there may be a path before it behind a reverse proxy)
const token = new URL(prefix).pathname.split("/").pop();
const tokenPattern = token ? new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi") : null;
const print = (line: string) => console.log(tokenPattern ? line.replace(tokenPattern, "***") : line);
const maxFeeds = Number(values["max-feeds"]);
const failures: string[] = [];
const seen = new Set<string>();
const queue = [root];
let feeds = 0;
let files = 0;

while (queue.length && feeds < maxFeeds) {
    const url = queue.shift()!.replaceAll("{searchTerms}", encodeURIComponent(values.search!));
    // Tokens match case-insensitively, so compare the reader URL part in lower case
    const key = url.slice(0, prefix.length).toLowerCase() + url.slice(prefix.length);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!key.startsWith(prefix.toLowerCase())) {
        failures.push(`LEAK  ${url} (points outside the proxy)`);
        continue;
    }
    const r = await fetch(url);
    const type = r.headers.get("content-type") ?? "";
    if (r.status !== 200) {
        failures.push(`${r.status}   ${url}`);
        await r.body?.cancel();
        continue;
    }
    if (!type.includes("xml")) {
        files++;
        const reader = r.body!.getReader();
        const first = await reader.read(); // don't download whole books
        await reader.cancel();
        const empty = first.done || !first.value?.byteLength;
        if (empty) failures.push(`EMPTY ${url}`);
        print(`file  200 ${type.padEnd(28)} ${(r.headers.get("content-length") ?? "?").padStart(9)}B ${empty ? "empty! " : ""}${url}`);
        continue;
    }
    feeds++;
    let root;
    try {
        root = parseXml(await r.text());
    } catch (err) {
        if (!(err instanceof XmlError)) throw err;
        failures.push(`XML   ${url}: ${err.message}`);
        continue;
    }
    const all = [...elements(root)];
    const titleEl = all.find((e) => localName(e) === "title");
    const title = titleEl ? textContent(titleEl) : "";
    const links = [
        ...all.filter((e) => localName(e) === "link").map((e) => e.attributes.href),
        ...all.filter((e) => localName(e) === "Url").map((e) => e.attributes.template),
    ].filter((h): h is string => !!h);
    print(`feed  200 ${type.padEnd(28)} ${String(links.length).padStart(3)} links  ${JSON.stringify(title)} ${url}`);
    queue.push(...links);
}

print(`\n${feeds} feeds, ${files} files checked, ${failures.length} problems`);
for (const f of failures) print("  " + f);
process.exit(failures.length ? 1 : 0);
