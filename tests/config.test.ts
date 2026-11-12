import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/config.ts";
import { STATE_FILE } from "../src/epub-check/state.ts";

const EPUB_CHECK = {
    EPUB_CHECK_ENABLED: "true",
    BOOKORBIT_URL: "https://books.example.org/",
    BOOKORBIT_USER: "reader",
    BOOKORBIT_PASSWORD: "bo-secret",
};
const POCKETBOOK_SYNC = {
    POCKETBOOK_SYNC_ENABLED: "true",
    BOOKORBIT_URL: "https://books.example.org",
    POCKETBOOK_SYNC_EMAIL: "reader@example.com",
    POCKETBOOK_SYNC_PASSWORD: "pb-secret",
    POCKETBOOK_SYNC_KOREADER_USER: "reader",
    POCKETBOOK_SYNC_KOREADER_PASSWORD: "ko-secret",
};

test("nothing runs unless a feature is turned on", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ EPUB_CHECK_ENABLED: "false" })).toThrow("EPUB_CHECK_ENABLED");
    expect(() => loadConfig({ EPUB_CHECK_ENABLED: "maybe" })).toThrow("true or false");
});

test("EPUB Check: an API key makes user and password unnecessary", () => {
    const epubCheck = loadConfig({ EPUB_CHECK_ENABLED: "true", BOOKORBIT_URL: "https://books.example.org", BOOKORBIT_API_KEY: "bok_abc" }).epubCheck!;
    expect(epubCheck).toMatchObject({ bookorbitApiKey: "bok_abc", bookorbitUser: "", bookorbitPassword: "" });
});

test("EPUB Check: defaults", () => {
    const config = loadConfig(EPUB_CHECK);
    expect(config.pocketbookSync).toBeUndefined();
    expect(config.opdsProxy).toBeUndefined();
    expect(config.epubCheck).toEqual({
        bookorbitUrl: "https://books.example.org",
        bookorbitApiKey: undefined,
        bookorbitUser: "reader",
        bookorbitPassword: "bo-secret",
        bookorbitPublicUrl: "https://books.example.org",
        reportUrl: undefined,
        port: 8602,
        basePath: "",
        requireLogin: true,
        checkInterval: 300,
        maxFileSize: 200 * 1024 * 1024,
        dataDir: "/data/epub-check",
        dryRun: false,
        ownFixes: false,
        epublift: false,
        epubliftPath: "epublift",
        replaceInLibrary: false,
    });
});

test("EPUB Check: optional settings", () => {
    const check = loadConfig({
        ...EPUB_CHECK, EPUB_CHECK_REPORT_URL: "http://192.168.1.139:8602/", EPUB_CHECK_PORT: "9000", EPUB_CHECK_INTERVAL: "3600", EPUB_CHECK_MAX_FILE_SIZE_MB: "50",
        EPUB_CHECK_DRY_RUN: "yes", DATA_DIR: "/srv/orbitkit/", EPUB_CHECK_FIXES: "true", EPUB_CHECK_EPUBLIFT: "true", EPUB_CHECK_EPUBLIFT_PATH: "/usr/local/bin/epublift",
        EPUB_CHECK_REPLACE_IN_LIBRARY: "1", EPUB_CHECK_BASE_PATH: "/api/orbitkit/", EPUB_CHECK_REQUIRE_LOGIN: "false",
    }).epubCheck!;
    expect(check).toMatchObject({
        reportUrl: "http://192.168.1.139:8602", port: 9000, checkInterval: 3600, maxFileSize: 50 * 1024 * 1024, dryRun: true,
        dataDir: "/srv/orbitkit/epub-check", ownFixes: true, epublift: true, epubliftPath: "/usr/local/bin/epublift", replaceInLibrary: true,
        basePath: "/api/orbitkit", requireLogin: false,
    });
});

test("every missing required setting is named at once", () => {
    expect(() => loadConfig({ EPUB_CHECK_ENABLED: "true", POCKETBOOK_SYNC_ENABLED: "true" }))
        .toThrow("Missing required settings: BOOKORBIT_URL, BOOKORBIT_USER, BOOKORBIT_PASSWORD, POCKETBOOK_SYNC_EMAIL, POCKETBOOK_SYNC_PASSWORD, POCKETBOOK_SYNC_KOREADER_USER, POCKETBOOK_SYNC_KOREADER_PASSWORD");
});

test("settings can come from files (Docker secrets)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbitkit-config-"));
    await writeFile(join(dir, "password"), "from-file\n");
    expect(loadConfig({ ...EPUB_CHECK, BOOKORBIT_PASSWORD: undefined, BOOKORBIT_PASSWORD_FILE: join(dir, "password") }).epubCheck!.bookorbitPassword).toBe("from-file");
    expect(() => loadConfig({ ...EPUB_CHECK, BOOKORBIT_PASSWORD_FILE: join(dir, "missing") })).toThrow("Cannot read BOOKORBIT_PASSWORD_FILE");
});

test("BOOKORBIT_PUBLIC_URL is for links, when BOOKORBIT_URL is an internal address", () => {
    const check = loadConfig({ ...EPUB_CHECK, BOOKORBIT_URL: "http://app:3000", BOOKORBIT_PUBLIC_URL: "https://books.example.org/" }).epubCheck!;
    expect(check.bookorbitUrl).toBe("http://app:3000");
    expect(check.bookorbitPublicUrl).toBe("https://books.example.org");
    expect(() => loadConfig({ ...EPUB_CHECK, BOOKORBIT_PUBLIC_URL: "books.example.org" })).toThrow("BOOKORBIT_PUBLIC_URL");
});

test("invalid values are rejected", () => {
    expect(() => loadConfig({ ...EPUB_CHECK, BOOKORBIT_URL: "books.example.org" })).toThrow("BOOKORBIT_URL");
    expect(() => loadConfig({ ...EPUB_CHECK, EPUB_CHECK_REPORT_URL: "192.168.1.139:8602" })).toThrow("EPUB_CHECK_REPORT_URL");
    expect(() => loadConfig({ ...EPUB_CHECK, EPUB_CHECK_INTERVAL: "30" })).toThrow("at least 60");
    expect(() => loadConfig({ ...EPUB_CHECK, EPUB_CHECK_MAX_FILE_SIZE_MB: "lots" })).toThrow("whole number");
    expect(() => loadConfig({ ...EPUB_CHECK, EPUB_CHECK_BASE_PATH: "api/orbitkit" })).toThrow("EPUB_CHECK_BASE_PATH");
    expect(() => loadConfig({ ...EPUB_CHECK, EPUB_CHECK_BASE_PATH: "/api/../x" })).toThrow("EPUB_CHECK_BASE_PATH");
    expect(() => loadConfig({ ...EPUB_CHECK, EPUB_CHECK_BASE_PATH: "/api/<x>" })).toThrow("EPUB_CHECK_BASE_PATH");
    expect(() => loadConfig({ ...POCKETBOOK_SYNC, POCKETBOOK_SYNC_INTERVAL: "5" })).toThrow("at least 30");
    expect(() => loadConfig({ ...EPUB_CHECK, BOOKORBIT_API_KEY: "secret" })).toThrow("starts with bok_");
    expect(() => loadConfig({ ...POCKETBOOK_SYNC, POCKETBOOK_SYNC_DEVICE_ID: "my device!" })).toThrow("letters, digits and hyphens");
    expect(() => loadConfig({ ...POCKETBOOK_SYNC, POCKETBOOK_SYNC_COLLECTION: "PocketBook" })).toThrow("Missing required settings: POCKETBOOK_SYNC_BOOKORBIT_API_KEY");
    expect(() => loadConfig({ ...POCKETBOOK_SYNC, POCKETBOOK_SYNC_COLLECTION: "PocketBook", POCKETBOOK_SYNC_BOOKORBIT_API_KEY: "secret" })).toThrow("starts with bok_");
    expect(() => loadConfig({ ...POCKETBOOK_SYNC, POCKETBOOK_SYNC_COLLECTION: "PB", POCKETBOOK_SYNC_BOOKORBIT_API_KEY: "bok_x" })).toThrow("3 to 255 characters");
    expect(() => loadConfig({ ...EPUB_CHECK, OPDS_PROXY_ENABLED: "true", OPDS_PROXY_PORT: "8602" })).toThrow("each feature needs its own port");
});

test("PocketBook Sync: uses the KOReader login, not the web login", () => {
    const pocketbook = loadConfig(POCKETBOOK_SYNC).pocketbookSync!;
    expect(pocketbook).toEqual({
        pbEmail: "reader@example.com",
        pbPassword: "pb-secret",
        pbShop: undefined,
        pbUrl: "https://cloud.pocketbook.digital/api/v1.0",
        bookorbitUrl: "https://books.example.org",
        koreaderUser: "reader",
        koreaderPassword: "ko-secret",
        deviceName: "PocketBook",
        deviceId: undefined,
        syncInterval: 300,
        dataDir: "/data/pocketbook-sync",
        dryRun: false,
        collection: undefined,
    });
});

test("PocketBook Sync: a collection to send needs an API key; its cloud collection is named after it", () => {
    const env = { ...POCKETBOOK_SYNC, POCKETBOOK_SYNC_COLLECTION: "PocketBook", POCKETBOOK_SYNC_BOOKORBIT_API_KEY: "bok_abc" };
    expect(loadConfig(env).pocketbookSync!.collection).toEqual({ name: "PocketBook", apiKey: "bok_abc", cloudCollection: "PocketBook" });
    expect(loadConfig({ ...env, POCKETBOOK_SYNC_CLOUD_COLLECTION: "From BookOrbit" }).pocketbookSync!.collection!.cloudCollection).toBe("From BookOrbit");
});

test("OPDS Proxy: needs no BookOrbit settings", () => {
    expect(loadConfig({ OPDS_PROXY_ENABLED: "true" }).opdsProxy).toEqual({
        port: 8601,
        publicUrl: undefined,
        adminPassword: undefined,
        setupCode: undefined,
        upstreamTimeoutMs: 60_000,
        dataDir: "/data/opds-proxy",
    });
    expect(loadConfig({ OPDS_PROXY_ENABLED: "true", OPDS_PROXY_PUBLIC_URL: "https://opds.example.org/", OPDS_PROXY_UPSTREAM_TIMEOUT: "10" }).opdsProxy)
        .toMatchObject({ publicUrl: "https://opds.example.org", upstreamTimeoutMs: 10_000 });
});

test("each feature has a dry run of its own", () => {
    const both = { ...EPUB_CHECK, ...POCKETBOOK_SYNC };
    expect(loadConfig({ ...both, EPUB_CHECK_DRY_RUN: "true" })).toMatchObject({ epubCheck: { dryRun: true }, pocketbookSync: { dryRun: false } });
    expect(loadConfig({ ...both, POCKETBOOK_SYNC_DRY_RUN: "true" })).toMatchObject({ epubCheck: { dryRun: false }, pocketbookSync: { dryRun: true } });
    // The old shared one does nothing, so a dry run is never assumed where none was asked for
    const old = loadConfig({ ...both, DRY_RUN: "true" });
    expect(old).toMatchObject({ epubCheck: { dryRun: false }, pocketbookSync: { dryRun: false } });
    expect(old.legacy).toEqual(["DRY_RUN (now EPUB_CHECK_DRY_RUN or POCKETBOOK_SYNC_DRY_RUN)"]);
});

test("settings of the separate tools are reported, not used", () => {
    const config = loadConfig({ ...EPUB_CHECK, REPORT_PASSWORD: "x", PB_EMAIL: "reader@example.com", PORT: "8080" });
    expect(config.legacy).toEqual([
        "PORT (now EPUB_CHECK_PORT or OPDS_PROXY_PORT)",
        "REPORT_PASSWORD (now the BookOrbit login (EPUB_CHECK_REQUIRE_LOGIN))",
        "PB_EMAIL (now POCKETBOOK_SYNC_EMAIL)",
    ]);
    expect(config.epubCheck!.port).toBe(8602);
});

async function healthcheck(state: object | null): Promise<number> {
    const dir = await mkdtemp(join(tmpdir(), "orbitkit-health-"));
    await mkdir(join(dir, "epub-check"));
    if (state) await writeFile(join(dir, "epub-check", STATE_FILE), JSON.stringify(state));
    // A port nothing listens on: only the state file is judged here
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const proc = Bun.spawn([process.execPath, `${import.meta.dir}/../src/index.ts`, "--healthcheck"], {
        env: { ...process.env, ...EPUB_CHECK, DATA_DIR: dir, EPUB_CHECK_PORT: String(server.port) },
        stderr: "pipe",
    });
    const code = await proc.exited;
    await server.stop(true);
    return code;
}

test("healthcheck: healthy after a recent cycle or while a long first run makes progress", async () => {
    expect(await healthcheck({ lastSuccess: Date.now() })).toBe(0);
    expect(await healthcheck({ lastProgress: Date.now() })).toBe(0);
    expect(await healthcheck({ lastSuccess: Date.now() - 3_600_000 })).toBe(1);
    expect(await healthcheck(null)).toBe(1);
});

test("healthcheck: unhealthy when a feature's port does not answer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbitkit-health-"));
    const unused = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = String(unused.port);
    await unused.stop(true);
    const proc = Bun.spawn([process.execPath, `${import.meta.dir}/../src/index.ts`, "--healthcheck"], {
        env: { ...process.env, OPDS_PROXY_ENABLED: "true", OPDS_PROXY_PORT: port, DATA_DIR: dir },
        stderr: "pipe",
    });
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain(`opds-proxy: port ${port} does not answer`);
});
