import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import type { Book } from "../../src/bookorbit.ts";
import { koreaderHash } from "../../src/pocketbook-sync/fingerprint.ts";
import { cloudFileName, pickFile } from "../../src/pocketbook-sync/collection.ts";
import { State } from "../../src/pocketbook-sync/state.ts";
import { API_KEY, type FakeServices, type TestEnv, makeEnv, startFakeServices } from "./helpers.ts";

let fake: FakeServices;
let env: TestEnv;

beforeAll(() => {
    fake = startFakeServices();
});
afterAll(() => fake.stop());
beforeEach(async () => {
    Object.assign(fake, {
        books: [], accessToken: undefined, logins: 0, renewals: 0, downloads: 0, matchRequests: [], progress: [],
        uploads: [], storageFull: false, boCollections: [], boBooks: [], boDownloads: 0,
    });
    fake.files.clear();
    fake.library.clear();
    fake.collections.clear();
    fake.boFiles.clear();
    env = await makeEnv(fake);
});
afterEach(() => env.cleanup());

const COLLECTION = { name: "PocketBook", apiKey: API_KEY, cloudCollection: "PocketBook" };
const collectionBridge = (overrides = {}) => env.bridge({ collection: COLLECTION, ...overrides });

/** Make these BookOrbit books the collection "PocketBook". */
function collect(...books: Book[]) {
    fake.boCollections = [{ id: 7, name: "Favourites", bookIds: [] }, { id: 9, name: "PocketBook", bookIds: books.map((b) => b.id) }];
}

test("uploads the books of the collection and puts them into a cloud collection", async () => {
    const { book, bytes } = fake.addBoBook("Moby Dick");
    collect(book);
    const bridge = await collectionBridge();
    await bridge.cycle();

    expect(fake.uploads).toEqual([{ name: "Moby-Dick.epub", source: "bookorbit", bytes: 50_000 }]);
    const uploaded = fake.books.find((b) => b.title === "Moby-Dick")!;
    expect(fake.files.get(uploaded.fast_hash)).toEqual(new Uint8Array(bytes.epub!));
    expect(fake.collections.get("PocketBook")).toEqual([uploaded.fast_hash]);

    // The progress sync knows the book without downloading it from the cloud
    await bridge.cycle();
    expect(fake.downloads).toBe(0);
    expect((await State.open(env.dir)).data.books[uploaded.fast_hash]).toMatchObject({ koreaderHash: koreaderHash(bytes.epub!), title: "Moby Dick" });
    // Sent once
    expect(fake.uploads).toHaveLength(1);
    expect(fake.boDownloads).toBe(1);
});

test("does not upload a book the cloud has already", async () => {
    const { book, bytes } = fake.addBoBook("Moby Dick");
    // The listing has no usable checksum: a book of the same size is compared by content
    fake.addBook("same size, other content", {}, new Uint8Array(bytes.epub!.length));
    const cloudBook = fake.addBook("moby-dick-from-opds", {}, bytes.epub);
    collect(book);
    await (await collectionBridge()).cycle();

    expect(fake.uploads).toEqual([]);
    expect(fake.collections.get("PocketBook")).toEqual([cloudBook.fast_hash]);
});

test("sends the preferred format and skips books without one PocketBook reads", async () => {
    const warn = spyOn(console, "warn");
    warn.mockClear();
    const both = fake.addBoBook("Both", ["pdf", "epub"]);
    const audio = fake.addBoBook("Audio", ["m4b"]);
    collect(both.book, audio.book);
    const bridge = await collectionBridge();
    await bridge.cycle();
    await bridge.cycle();

    expect(fake.uploads.map((u) => u.name)).toEqual(["Both.epub"]);
    expect(fake.uploads[0]!.bytes).toBe(both.bytes.epub!.length);
    // Said once, not every cycle
    expect(warn.mock.calls.filter(([line]) => String(line).includes('not sending "Audio"'))).toHaveLength(1);
});

test("uploads big files in one request", async () => {
    const { book, bytes } = fake.addBoBook("Atlas", ["pdf"], 6 * 1024 * 1024 + 1000);
    collect(book);
    const bridge = await collectionBridge();
    await bridge.cycle();

    expect(fake.uploads).toEqual([{ name: "Atlas.pdf", source: "bookorbit", bytes: bytes.pdf!.length }]);
    const uploaded = fake.books.find((b) => b.title === "Atlas")!;
    expect(fake.files.get(uploaded.fast_hash)).toEqual(new Uint8Array(bytes.pdf!));
    expect(fake.collections.get("PocketBook")).toEqual([uploaded.fast_hash]);
});

test("books taken out of the collection stay in the cloud, and are sent again when put back", async () => {
    const { book } = fake.addBoBook("Moby Dick");
    collect(book);
    const bridge = await collectionBridge();
    await bridge.cycle();
    collect();
    await bridge.cycle();
    expect(fake.books.map((b) => b.title)).toEqual(["Moby-Dick"]);
    expect((await State.open(env.dir)).data.collection).toEqual({});

    // Back in the collection: found in the cloud, not uploaded twice
    collect(book);
    await bridge.cycle();
    expect(fake.uploads).toHaveLength(1);
    expect(fake.collections.get("PocketBook")).toHaveLength(1);
});

test("a dry run uploads nothing", async () => {
    const { book } = fake.addBoBook("Moby Dick");
    collect(book);
    await (await collectionBridge({ dryRun: true })).cycle();
    expect(fake.uploads).toEqual([]);
    expect(fake.collections.size).toBe(0);
});

test("a full cloud stops the round, and the books follow once there is room", async () => {
    const first = fake.addBoBook("First");
    const second = fake.addBoBook("Second");
    collect(first.book, second.book);
    fake.storageFull = true;
    const bridge = await collectionBridge();
    await bridge.cycle();
    expect(fake.boDownloads).toBe(1);

    fake.storageFull = false;
    await bridge.cycle();
    expect(fake.uploads.map((u) => u.name)).toEqual(["First.epub", "Second.epub"]);
});

test("the progress sync goes on without the collection", async () => {
    const { book } = fake.addBoBook("Moby Dick");
    fake.boCollections = [{ id: 1, name: "Other", bookIds: [book.id] }];
    const cloudBook = fake.addBook("Read on the reader", { read_percent: 30 });
    fake.library.add(koreaderHash(fake.files.get(cloudBook.fast_hash)!));

    expect(await (await collectionBridge()).cycle()).toBe(1);
    expect(fake.uploads).toEqual([]);

    // A refused key doesn't stop it either
    expect(await (await collectionBridge({ collection: { ...COLLECTION, apiKey: "bok_revoked" } })).cycle()).toBe(0);
});

test("pickFile and cloudFileName", () => {
    const book: Book = {
        id: 3, libraryId: 1, title: "A/B", authors: [],
        files: [
            { id: 1, format: "EPUB", role: "supplement", sizeBytes: 1 },
            { id: 2, format: "PDF", role: "content", sizeBytes: 1 },
            { id: 3, format: null, role: "primary", sizeBytes: 1 },
            { id: 4, format: "jpg", role: "cover", sizeBytes: 1 },
        ],
    };
    expect(pickFile(book)?.id).toBe(2);
    expect(pickFile({ ...book, files: [...book.files, { id: 5, format: "epub", role: "primary", sizeBytes: 1 }] })?.id).toBe(5);
    expect(cloudFileName(book, book.files[1]!)).toBe("A_B.pdf");
    expect(cloudFileName(book, book.files[1]!, "From BookOrbit.PDF")).toBe("From BookOrbit.PDF");
    expect(cloudFileName({ ...book, title: "" }, book.files[1]!)).toBe("Book 3.pdf");
    expect(cloudFileName(book, book.files[1]!, "x")).toBe("x.pdf");
    expect(cloudFileName(book, book.files[1]!, "a")).toBe("a.pdf");
    expect(cloudFileName(book, book.files[1]!, "")).toBe("A_B.pdf");
});
