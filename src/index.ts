import { version } from "../package.json";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import type { Feature } from "./feature.ts";
import { problems } from "./health.ts";
import { log } from "./log.ts";

const args = process.argv.slice(2);

if (args.includes("--version")) {
    console.log(version);
    process.exit(0);
}

let config: Config;
try {
    config = loadConfig();
} catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    log.error(err.message);
    process.exit(args.includes("--healthcheck") ? 1 : 2);
}

// The container image has no shell, so Docker's HEALTHCHECK runs the binary itself: orbitkit --healthcheck
if (args.includes("--healthcheck")) {
    const found = await problems(config);
    for (const problem of found) console.error(problem);
    process.exit(found.length ? 1 : 0);
}
const once = args.includes("--once");

for (const setting of config.legacy) log.warn(`${setting} is a setting of the separate tools orbitkit replaces and is ignored`);

// Each feature is loaded only when it is on: the EPUB Check brings large WebAssembly modules
const features: Feature[] = [];
try {
    if (config.epubCheck) features.push(await (await import("./epub-check/index.ts")).createEpubCheck(config.epubCheck));
    if (config.pocketbookSync) features.push(await (await import("./pocketbook-sync/index.ts")).createPocketbookSync(config.pocketbookSync));
    if (config.opdsProxy) features.push(await (await import("./opds-proxy/index.ts")).createOpdsProxy(config.opdsProxy));
} catch (err) {
    if (err instanceof ConfigError) {
        log.error(err.message);
        process.exit(2);
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw err;
    const uid = process.getuid?.() ?? "?";
    const gid = process.getgid?.() ?? "?";
    log.error(`Cannot write to ${config.dataDir} as uid ${uid}. If it is a bind mount, create the directory on the host`
        + ` and give it to this user, e.g.:\n\n  mkdir -p /path/on/host && sudo chown ${uid}:${gid} /path/on/host\n`);
    process.exit(1);
}

log.info(`orbitkit ${version} with ${features.map((f) => f.name).join(", ")}`);

if (once) {
    let ok = true;
    for (const feature of features) ok = (await feature.once()) && ok;
    for (const feature of features) await feature.stop();
    process.exit(ok ? 0 : 1);
}

// A feature's failure stays its own: log what escaped it instead of taking the others down
process.on("unhandledRejection", (reason) => log.error(`unexpected error: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`));

for (const feature of features) feature.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
        await Promise.allSettled(features.map((f) => f.stop()));
        process.exit(0);
    });
}
