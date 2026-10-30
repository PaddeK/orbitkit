import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Checker } from "../../src/epub-check/check.ts";
import type { Config } from "../../src/epub-check/config.ts";
import { planId, planRepair, SERIES_FIX } from "../../src/epub-check/repairer.ts";
import { Replacer } from "../../src/epub-check/replace.ts";
import { page, serveReports } from "../../src/epub-check/report.ts";
import { Login } from "../../src/login.ts";
import { State } from "../../src/epub-check/state.ts";
import { validateEpub } from "../../src/epub-check/validator.ts";
import { brokenEpub, epub2, MISSING_IMAGE, repairableEpub, validEpub } from "./epub.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addBook, makeConfig, placeInLibrary, replaceFile, startFakeBookOrbit, type FakeBookOrbit } from "./helpers.ts";

let fake: FakeBookOrbit;
let config: Config;
let server: ReturnType<typeof serveReports>;
let repairableFile: number;
let replacer: Replacer | undefined;

async function start(overrides: Partial<Config> = {}) {
    config = await makeConfig(fake, { port: 0, ...overrides });
    const state = await State.open(config.dataDir);
    const checker = new Checker(config, state);
    await checker.cycle();
    replacer = config.replaceInLibrary ? new Replacer(config, state, checker, 0) : undefined;
    server = serveReports(config, state, checker, replacer);
}

beforeEach(async () => {
    fake = startFakeBookOrbit();
    addBook(fake, { id: 1, title: "Moby Dick", epubs: [validEpub()] });
    addBook(fake, { id: 2, title: "Moby Dick <i>broken</i>", epubs: [brokenEpub()] });
    [repairableFile] = addBook(fake, { id: 3, title: "Moby Dick", epubs: [repairableEpub()] }) as [number];
});
afterEach(() => {
    server.stop(true);
    fake.stop();
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(new URL(path, server.url), { headers });

async function postRepair(fixes: number[], action: "preview" | "download" | "replace", plan?: string) {
    plan ??= planId((await planRepair(repairableEpub()))!.fixes);
    const form = new FormData();
    form.set("plan", plan);
    form.set("action", action);
    for (const fix of fixes) form.append("fix", String(fix));
    return fetch(new URL(`/books/3/files/${repairableFile}/repair`, server.url), { method: "POST", body: form });
}

test("the overview lists books with problems and hides valid ones", async () => {
    await start();
    const res = await get("/");
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('href="books/2"');
    expect(html).not.toContain('href="books/1"');
    expect(html).toContain("1 valid book(s) not listed");
    // Titles come from BookOrbit and are escaped
    expect(html).toContain("Moby Dick &lt;i&gt;broken&lt;/i&gt;");
    expect(html).not.toContain("<i>broken</i>");
    // What the safe fixes do for book 3
    expect(html).toContain("errors 2 → 1 with safe fixes");
    expect(html).toContain("2 fixes proposed");
});

test("?all also lists valid books", async () => {
    await start();
    expect(await (await get("/?all")).text()).toContain('href="books/1"');
});

test("a book page shows each finding with code and place", async () => {
    await start();
    const html = await (await get("/books/2")).text();
    expect(html).toContain("RSC-001");
    expect(html).toContain("OEBPS/content.opf:13:5");
    expect(html).toContain("images/whale.jpg");
    // Links go to the public address, not to the one orbitkit uses (an internal one in a Docker stack)
    expect(html).toContain('href="https://books.example.org/book/2"');
});

test("a book page offers epubsana's fixes: safe ones ticked, the others to confirm", async () => {
    await start();
    const html = await (await get("/books/3")).text();
    expect(html).toContain(`action="3/files/${repairableFile}/repair"`);
    expect(html).toContain('value="0" id="fix-0" checked');
    expect(html).toMatch(/value="1" id="fix-1">/);
    expect(html).toContain("The 1 safe fix alone: errors 2 → 1.");
    expect(html).toContain("1 more needs your confirmation");
});

test("a valid book says so", async () => {
    await start();
    expect(await (await get("/books/1")).text()).toContain("No problems found.");
});

test("checking a selection shows the result and keeps the selection", async () => {
    await start();
    const res = await postRepair([0, 1], "preview");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<strong>errors 2 → 0</strong>");
    expect(html).toContain('value="1" id="fix-1" checked');
    expect(html).toContain('action="repair"');
    expect(html).toMatch(/Remaining findings<\/h2>\s*<p><span class="badge valid">valid<\/span> None\./);
});

test("downloading returns the repaired book under BookOrbit's file name", async () => {
    await start();
    const res = await postRepair([0, 1], "download");
    expect(res.headers.get("content-type")).toBe("application/epub+zip");
    const disposition = res.headers.get("content-disposition")!;
    expect(disposition).toContain('filename="Moby-Dick - Herman Melville_fixed.epub"');
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent("Moby-Dick – Herman Melville_fixed.epub")}`);
    const repaired = new Uint8Array(await res.arrayBuffer());
    expect(validateEpub(repaired).counts).toEqual({ fatal: 0, error: 0, warning: 0 });
});

test("a selection made for an older version of the book is refused", async () => {
    await start();
    replaceFile(fake, repairableFile, brokenEpub());
    const res = await postRepair([0], "download");
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("The book changed since this page was made");
});

test("unknown books and paths are 404", async () => {
    await start();
    expect((await get("/books/99")).status).toBe(404);
    expect((await get("/nope")).status).toBe(404);
    expect((await fetch(new URL("/books/1/files/999/repair", server.url), { method: "POST", body: new FormData() })).status).toBe(404);
    expect((await get("/healthz")).status).toBe(200);
});

describe("with a login", () => {
    async function startWithLogin(basePath = "") {
        await start({ requireLogin: true, basePath });
        server.stop(true);
        const state = await State.open(config.dataDir);
        const login = await Login.open({
            bookorbitUrl: fake.url, bookorbitPublicUrl: config.bookorbitPublicUrl, file: join(config.dataDir, "sessions.json"),
            cookie: "orbitkit_epub_check", permission: "manage_libraries", permissionLabel: "Manage libraries", title: "orbitkit EPUB Check",
            basePath, log: { info() {}, warn() {}, error() {} }, page,
        });
        server = serveReports(config, state, new Checker(config, state), undefined, login);
    }
    // What a browser signed in to BookOrbit sends along to pages under BookOrbit's address
    const bookorbitCookie = () => ({ cookie: `access_token=${fake.accessToken}` });
    const noRedirect = (path: string, headers: Record<string, string> = {}) => fetch(new URL(path, server.url), { headers, redirect: "manual" });

    test("pages lead to the login page; /login and /healthz stay open", async () => {
        await startWithLogin();
        const res = await noRedirect("/books/3?x=1");
        expect(res.status).toBe(303);
        expect(res.headers.get("location")).toBe("/login?next=%2Fbooks%2F3%3Fx%3D1");
        expect((await get("/login")).status).toBe(200);
        expect(await (await get("/login")).text()).toContain("Manage libraries");
        expect((await get("/healthz")).status).toBe(200);
        expect((await noRedirect("/nope")).status).toBe(303);
        expect((await fetch(new URL(`/books/3/files/${repairableFile}/repair`, server.url), { method: "POST", body: new FormData(), headers: { origin: server.url.origin } })).status).toBe(401);
    });

    test("BookOrbit's own login cookie lets its users with the permission in", async () => {
        await startWithLogin();
        expect((await get("/", bookorbitCookie())).status).toBe(200);
        expect((await get("/books/3", bookorbitCookie())).status).toBe(200);
        expect((await noRedirect("/", { cookie: "access_token=forged" })).status).toBe(303);
        fake.permissions = ["library_download"];
        // Answers about the cookie are kept for a minute; a new token is asked about
        fake.revokeAccessToken();
        await fake.loginAgain();
        expect((await get("/", bookorbitCookie())).status).toBe(403);
    });

    test("forms from other sites are refused", async () => {
        await startWithLogin();
        const post = (headers: Record<string, string>) =>
            fetch(new URL(`/books/3/files/${repairableFile}/repair`, server.url), { method: "POST", body: new FormData(), headers: { ...bookorbitCookie(), ...headers } });
        expect((await post({ origin: "https://evil.example" })).status).toBe(403);
        expect((await post({})).status).toBe(403);
        // Same site: on to the handler, which finds the form incomplete
        expect((await post({ origin: server.url.origin })).status).not.toBe(403);
        expect((await post({ "sec-fetch-site": "same-origin" })).status).not.toBe(403);
    });

    test("below EPUB_CHECK_BASE_PATH, as under BookOrbit's address", async () => {
        await startWithLogin("/api/orbitkit");
        const root = await noRedirect("/api/orbitkit");
        expect(root.status).toBe(308);
        expect(root.headers.get("location")).toBe("/api/orbitkit/");
        expect((await get("/api/orbitkit/", bookorbitCookie())).status).toBe(200);
        expect(await (await get("/api/orbitkit/books/3", bookorbitCookie())).text()).toContain('href="../"');
        expect((await noRedirect("/api/orbitkit/books/3")).headers.get("location")).toBe("/api/orbitkit/login?next=%2Fapi%2Forbitkit%2Fbooks%2F3");
        expect(await (await get("/api/orbitkit/login")).text()).toContain('action="/api/orbitkit/login"');
        // Still at the root too, e.g. on a LAN port
        expect((await get("/books/3", bookorbitCookie())).status).toBe(200);
    });
});

test("with EPUB_CHECK_FIXES, the series fix is offered as orbitkit's own and repairs the download", async () => {
    const [fileId] = addBook(fake, { id: 4, title: "Moby Dick", epubs: [epub2()] });
    await start({ ownFixes: true });
    const html = await (await get("/books/4")).text();
    expect(html).toContain(`value="${SERIES_FIX}" id="fix-${SERIES_FIX}" checked`);
    expect(html).toContain('<span class="badge own">orbitkit</span>');
    expect(html).toContain("stays as calibre:series");

    const form = new FormData();
    form.set("plan", planId((await planRepair(epub2(), { ownFixes: true }))!.fixes));
    form.set("action", "download");
    form.append("fix", String(SERIES_FIX));
    const res = await fetch(new URL(`/books/4/files/${fileId}/repair`, server.url), { method: "POST", body: form });
    expect(validateEpub(new Uint8Array(await res.arrayBuffer())).counts).toEqual({ fatal: 0, error: 0, warning: 0 });
});

test("without EPUB_CHECK_FIXES, there is no fix for BookOrbit's series metas", async () => {
    addBook(fake, { id: 4, title: "Moby Dick", epubs: [epub2()] });
    await start();
    expect(await (await get("/books/4")).text()).toContain("No fix is known for these findings.");
});

function upload(bytes: Uint8Array, name = "Moby Dick fixed.epub") {
    const form = new FormData();
    form.set("epub", new File([new Uint8Array(bytes)], name));
    return fetch(new URL(`/books/3/files/${repairableFile}/upload`, server.url), { method: "POST", body: form });
}

function confirmUpload(token: string, bookId = 3) {
    const form = new FormData();
    form.set("token", token);
    return fetch(new URL(`/books/${bookId}/files/${repairableFile}/upload/confirm`, server.url), { method: "POST", body: form });
}

const tokenIn = (html: string) => /name="token" value="([^"]+)"/.exec(html)?.[1] ?? "";

test("without EPUB_CHECK_REPLACE_IN_LIBRARY, books cannot be replaced", async () => {
    await start();
    const page = await (await get("/books/3")).text();
    expect(page).not.toContain("Replace in BookOrbit");
    expect(page).not.toContain("Your own fixed version");
    expect((await get(`/books/3/files/${repairableFile}/original`)).status).toBe(404);
    expect((await upload(validEpub())).status).toBe(404);
    expect(await (await get("/")).text()).not.toContain("replace-safe");
    expect((await get("/replace-safe")).status).toBe(404);
    expect((await postRepair([0], "replace")).status).toBe(403);
});

describe("with EPUB_CHECK_REPLACE_IN_LIBRARY", () => {
    let library: string;
    beforeEach(async () => {
        library = await mkdtemp(join(tmpdir(), "orbitkit-library-"));
        await placeInLibrary(fake, library, repairableFile);
        await start({ replaceInLibrary: true });
    });

    test("a book page offers to replace the book, and doing so puts the repaired version in the library", async () => {
        expect(await (await get("/books/3")).text()).toContain('value="replace"');
        const res = await postRepair([0, 1], "replace");
        const html = await res.text();
        expect(res.status).toBe(200);
        expect(html).toContain("Replaced Moby Dick");
        expect(html).toContain("<strong>errors 2 → 0</strong>");
        expect(validateEpub(await Bun.file(fake.paths[repairableFile]!).bytes()).counts).toEqual({ fatal: 0, error: 0, warning: 0 });
        // The report already knows
        expect(await (await get("/books/3")).text()).toContain("No problems found.");
    });

    test("a selection that applies nothing replaces nothing", async () => {
        expect((await postRepair([], "replace")).status).toBe(422);
    });

    test("replace all: overview link, confirmation page, job, result", async () => {
        expect(await (await get("/")).text()).toContain('href="replace-safe">Replace 1 book in BookOrbit with their safe fixes');
        const confirm = await (await get("/replace-safe")).text();
        expect(confirm).toContain("errors 2 → 1");
        expect(confirm).toContain("Replace 1 book(s) in BookOrbit</button>");

        const started = await fetch(new URL("/replace-safe", server.url), { method: "POST", redirect: "manual" });
        expect(started.status).toBe(303);
        expect(started.headers.get("location")).toBe("replace-safe");
        await replacer!.job!.done;
        const done = await (await get("/replace-safe")).text();
        expect(done).toContain("Done: 1 of 1 replaced");
        expect(done).not.toContain("http-equiv");
        expect(done).toContain("No book has safe fixes that would remove errors.");
    });
});

describe("uploading a version fixed by hand (EPUB_CHECK_REPLACE_IN_LIBRARY)", () => {
    beforeEach(async () => {
        await placeInLibrary(fake, await mkdtemp(join(tmpdir(), "orbitkit-library-")), repairableFile);
        await start({ replaceInLibrary: true });
    });

    test("the book page links the current file and offers the upload", async () => {
        const html = await (await get("/books/3")).text();
        expect(html).toContain("Your own fixed version");
        expect(html).toContain(`href="3/files/${repairableFile}/original"`);
        expect(html).toContain(`action="3/files/${repairableFile}/upload" enctype="multipart/form-data"`);
        const original = await get(`/books/3/files/${repairableFile}/original`);
        expect(original.headers.get("content-disposition")).toContain("Moby-Dick - Herman Melville.epub");
        expect(Buffer.from(await original.arrayBuffer()).equals(Buffer.from(repairableEpub()))).toBe(true);
    });

    test("an upload is checked first, then replaces the book once confirmed", async () => {
        const res = await upload(validEpub());
        const html = await res.text();
        expect(res.status).toBe(200);
        expect(html).toContain("<td>0 errors, 0 warnings</td>");
        expect(html).toContain("<td>2 errors, 0 warnings</td>");
        expect(html).not.toContain("differs from the book in the library");
        // Nothing changed yet
        expect(Buffer.from(await Bun.file(fake.paths[repairableFile]!).bytes()).equals(Buffer.from(repairableEpub()))).toBe(true);

        const done = await confirmUpload(tokenIn(html));
        expect(await done.text()).toContain("<strong>errors 2 → 0</strong>");
        expect(Buffer.from(await Bun.file(fake.paths[repairableFile]!).bytes()).equals(Buffer.from(validEpub()))).toBe(true);
        expect(await (await get("/books/3")).text()).toContain("No problems found.");
        // An upload is used once
        expect((await confirmUpload(tokenIn(html))).status).toBe(404);
    });

    test("a different title or more errors are pointed out", async () => {
        const html = await (await upload(brokenEpub("Bartleby, the Scrivener"))).text();
        expect(html).toContain("<td>Bartleby, the Scrivener</td>");
        expect(html).toContain("The title inside your upload differs");
        const worse = await (await upload(epub2(undefined, {}, MISSING_IMAGE))).text();
        expect(worse).toContain("Your upload has more errors than the book in the library.");
    });

    test("what is not an EPUB, the same file, or a token for another book is refused", async () => {
        expect((await upload(new TextEncoder().encode("Call me Ishmael."), "moby.txt")).status).toBe(422);
        const same = tokenIn(await (await upload(repairableEpub())).text());
        expect((await confirmUpload(same)).status).toBe(409);
        const other = tokenIn(await (await upload(validEpub())).text());
        expect((await confirmUpload(other, 2)).status).toBe(404);
        expect((await confirmUpload("not-a-token")).status).toBe(404);
    });
});
