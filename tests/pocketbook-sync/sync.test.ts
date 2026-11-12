import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { koreaderHash } from "../../src/pocketbook-sync/fingerprint.ts";
import { STATE_FILE, type StateData } from "../../src/pocketbook-sync/state.ts";
import { readingPercent } from "../../src/pocketbook-sync/sync.ts";
import { type FakeServices, type TestEnv, makeEnv, startFakeServices } from "./helpers.ts";

let fake: FakeServices;
let env: TestEnv;

beforeAll(() => {
    fake = startFakeServices();
});
afterAll(() => fake.stop());
beforeEach(async () => {
    Object.assign(fake, { books: [], accessToken: undefined, logins: 0, renewals: 0, downloads: 0, matchRequests: [], progress: [] });
    fake.files.clear();
    fake.library.clear();
    fake.providers = [{ alias: "pocketbook_de", name: "Pocketbook.de", shop_id: "1" }];
    env = await makeEnv(fake);
});
afterEach(() => env.cleanup());

/** Add a book that BookOrbit knows; returns it and its KOReader hash. */
function libraryBook(title: string, percent: number) {
    const book = fake.addBook(title, { read_percent: percent });
    const hash = koreaderHash(fake.files.get(book.fast_hash)!);
    fake.library.add(hash);
    return { book, hash };
}

test("sends the progress of books BookOrbit knows", async () => {
    const { hash } = libraryBook("Moby Dick", 26);
    fake.addBook("Not in BookOrbit", { read_percent: 50 });

    expect(await (await env.bridge()).cycle()).toBe(1);

    expect(fake.progress).toEqual([{
        document: hash,
        percentage: 0.26,
        timestamp: 1793229329, // 2026-10-28T23:15:29Z
        device: "PocketBook Era Color",
        device_id: expect.stringMatching(/^pocketorbit-[0-9a-f]{16}$/),
    }]);
    // Unknown books are offered to BookOrbit's review list with their metadata
    const offered = fake.matchRequests[0]!.books.find((b) => b.title === "Not in BookOrbit");
    expect(offered).toMatchObject({ authors: "Some Author", source: "file", lastOpen: 1793229329 });
});

test("sends only changes and downloads each book once", async () => {
    const { book } = libraryBook("Moby Dick", 26);
    const bridge = await env.bridge();
    await bridge.cycle();
    expect(await bridge.cycle()).toBe(0);
    Object.assign(book, { read_percent: 40, mtime: "2026-10-29T08:00:00Z" });
    expect(await bridge.cycle()).toBe(1);
    expect(fake.progress.map((p) => p.percentage)).toEqual([0.26, 0.4]);
    expect(fake.downloads).toBe(1);
});

test("picks up books linked in BookOrbit later", async () => {
    const book = fake.addBook("Calibre copy", { read_percent: 10 });
    const bridge = await env.bridge();
    await bridge.cycle();
    expect(fake.progress).toHaveLength(0);
    fake.library.add(koreaderHash(fake.files.get(book.fast_hash)!)); // linked under "KOReader Books to Review"
    expect(await bridge.cycle()).toBe(1);
});

test("matches a book again when its link is removed in BookOrbit", async () => {
    const { book } = libraryBook("Moby Dick", 26);
    const bridge = await env.bridge();
    await bridge.cycle();
    fake.library.clear();
    book.read_percent = 30;
    expect(await bridge.cycle()).toBe(0);
    const state = (await Bun.file(`${env.dir}/${STATE_FILE}`).json()) as StateData;
    expect(state.books[book.fast_hash]!.matched).toBe(false);
});

test("skips unread books and audiobooks", async () => {
    libraryBook("Unread", 0);
    fake.addBook("Audio", { read_percent: 30, format: "m4b" });
    expect(await (await env.bridge()).cycle()).toBe(0);
    expect(fake.matchRequests[0]!.books.map((b) => b.title)).toEqual(["Unread"]);
    expect(fake.downloads).toBe(1);
});

test("a book marked as read counts as 100%", () => {
    expect(readingPercent({ id: "1", title: "x", fast_hash: "x", read_status: "read", read_percent: 97 })).toBe(100);
    expect(readingPercent({ id: "1", title: "x", fast_hash: "x", read_percent: "26" })).toBe(26);
    expect(readingPercent({ id: "1", title: "x", fast_hash: "x", read_percent: null })).toBe(0);
});

test("dry run sends nothing", async () => {
    libraryBook("Moby Dick", 26);
    expect(await (await env.bridge({ dryRun: true })).cycle()).toBe(0);
    expect(fake.progress).toHaveLength(0);
});

test("retries a download that isn't the file listed", async () => {
    const { book } = libraryBook("Moby Dick", 26);
    const bridge = await env.bridge();
    book.bytes = 12;
    expect(await bridge.cycle()).toBe(0);
    // md5_hash in its old form, a raw MD5, is checked too
    book.bytes = fake.files.get(book.fast_hash)!.length;
    book.md5_hash = createHash("md5").update("something else").digest("base64");
    expect(await bridge.cycle()).toBe(0);
    book.md5_hash = createHash("md5").update(fake.files.get(book.fast_hash)!).digest("base64");
    expect(await bridge.cycle()).toBe(1);
    expect(fake.downloads).toBe(3);
});

test("md5_hash holding the fast hash, as the cloud sends it now, is no reason to retry", async () => {
    const { book } = libraryBook("Mona Lisa Overdrive", 12);
    expect(Buffer.from(book.md5_hash!, "base64").toString()).toBe(book.fast_hash);
    expect(await (await env.bridge()).cycle()).toBe(1);
});

test("forgets books removed from the cloud", async () => {
    fake.addBook("Gone", { read_percent: 5 });
    const bridge = await env.bridge();
    await bridge.cycle();
    fake.books.length = 0;
    await bridge.cycle();
    const state = (await Bun.file(`${env.dir}/${STATE_FILE}`).json()) as StateData;
    expect(state.books).toEqual({});
});

test("state survives a restart and is only readable by its owner", async () => {
    libraryBook("Moby Dick", 26);
    await (await env.bridge({ deviceId: "my-device" })).cycle();
    expect((await stat(`${env.dir}/${STATE_FILE}`)).mode & 0o777).toBe(0o600);

    const restarted = await env.bridge({ deviceId: "ignored-after-first-start" });
    expect(await restarted.cycle()).toBe(0);
    expect(restarted.bookorbit.device.id).toBe("my-device");
    expect(fake.logins).toBe(1); // stored token reused
    expect(fake.downloads).toBe(1);
});

test("renews an expired PocketBook token", async () => {
    fake.addBook("Moby Dick", { read_percent: 26 });
    await (await env.bridge()).cycle();
    const state = (await Bun.file(`${env.dir}/${STATE_FILE}`).json()) as StateData;
    await Bun.write(`${env.dir}/${STATE_FILE}`, JSON.stringify({ ...state, pocketbook: { ...state.pocketbook, expiresAt: 0 } }));
    await (await env.bridge()).cycle();
    expect([fake.logins, fake.renewals]).toEqual([1, 1]);
});

test("logs in again when the token is revoked", async () => {
    fake.addBook("Moby Dick", { read_percent: 26 });
    const bridge = await env.bridge();
    await bridge.cycle();
    fake.accessToken = "rotated-elsewhere";
    await bridge.cycle();
    expect(fake.logins).toBe(2);
});

test("explains an unknown PocketBook email", async () => {
    await expect((await env.bridge({ pbEmail: "nobody@example.com" })).cycle()).rejects.toThrow("no account for this email");
});

test("PB_SHOP picks the shop", async () => {
    fake.providers = [{ alias: "pocketbook_de", name: "Pocketbook.de", shop_id: "1" }, { alias: "bookland", name: "Bookland", shop_id: "2" }];
    await (await env.bridge({ pbShop: "bookland" })).cycle();
    expect(fake.logins).toBe(1);
    const fresh = await makeEnv(fake); // without the token saved by the first login
    await expect((await fresh.bridge({ pbShop: "nope" })).cycle()).rejects.toThrow('shop "nope" not found');
    await fresh.cleanup();
});
