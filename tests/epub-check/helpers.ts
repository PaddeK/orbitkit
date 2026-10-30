import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Book, Field, FieldType } from "../../src/bookorbit.ts";
import type { Config } from "../../src/epub-check/config.ts";

export const USER = "reader";
export const PASSWORD = "bo-secret";

interface FakeBook extends Book {
    /** File contents by file ID */
    contents: Record<number, Uint8Array>;
}

/** A fake BookOrbit with just the API orbitkit uses, and records of what it was sent. */
export function startFakeBookOrbit() {
    let tokenCounter = 0;
    const fake = {
        books: [] as FakeBook[],
        fields: [] as Field[],
        /** Custom field values per book ID and field ID */
        values: {} as Record<number, Record<number, unknown>>,
        valueWrites: 0,
        logins: 0,
        refreshes: 0,
        downloads: 0,
        accessToken: "",
        refreshToken: "",
        /** May BookOrbit's user create and change custom fields */
        canManageFields: true,
        /** Where files are on disk, by file ID: such files are served from there, like BookOrbit does */
        paths: {} as Record<number, string>,
        /** Libraries BookOrbit was asked to scan */
        scans: [] as number[],
        /** Answer this many scan requests with "already running" first */
        busyScans: 0,
        url: "",
        stop: () => {},
        /** BookOrbit permissions of the user */
        permissions: ["manage_libraries"] as string[],
        /** Make the current access token invalid, as after a server restart with a new secret */
        revokeAccessToken() {
            fake.accessToken = "revoked";
        },
        /** Issue a new access token, as for a new login */
        loginAgain() {
            issue();
        },
    };

    const issue = () => {
        tokenCounter++;
        fake.accessToken = `access-${tokenCounter}`;
        fake.refreshToken = tokenCounter.toString(16).padStart(64, "0");
        return {
            accessToken: fake.accessToken,
            accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
            refreshToken: fake.refreshToken,
            refreshTokenExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
            sessionId: 1,
        };
    };
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    const findField = (id: string) => fake.fields.find((f) => f.id === Number(id));

    const server = Bun.serve({
        port: 0,
        async fetch(req) {
            const url = new URL(req.url);
            const path = url.pathname.replace(/^\/api\/v1/, "");
            const body = req.method === "GET" ? null : ((await req.json().catch(() => null)) as Record<string, any> | null);

            if (path === "/auth/login" && req.method === "POST") {
                if (body?.username !== USER || body?.password !== PASSWORD) return json({ message: "Invalid credentials" }, 401);
                if (body.clientKind !== "native") return json({ message: "expected a native client" }, 400);
                fake.logins++;
                return json({ ...issue(), user: { username: USER } });
            }
            if (path === "/auth/refresh" && req.method === "POST") {
                if (body?.refreshToken !== fake.refreshToken) return json({ message: "Unauthorized" }, 401);
                fake.refreshes++;
                return json(issue());
            }
            if (req.headers.get("authorization") !== `Bearer ${fake.accessToken}`) return json({ message: "Unauthorized" }, 401);

            if (path === "/auth/me") return json({ id: 1, username: USER, isSuperuser: false, permissions: fake.permissions });
            if (path === "/libraries") return json([{ id: 1, name: "Books" }, { id: 2, name: "Comics" }]);
            if (path === "/books/query" && req.method === "POST") {
                const { page, size } = body!.pagination;
                const items = fake.books.slice(page * size, (page + 1) * size).map(({ contents: _, ...book }) => book);
                return json({ items, total: fake.books.length });
            }
            if (path === "/custom-metadata/fields/active") return json(fake.fields);
            if (path === "/custom-metadata/fields" && req.method === "POST") {
                if (!fake.canManageFields) return json({ message: "Forbidden" }, 403);
                const field: Field = { id: fake.fields.length + 10, label: body!.label, type: body!.type, enabledLibraryIds: body!.enabledLibraryIds ?? [] };
                fake.fields.push(field);
                return json(field);
            }
            let match = path.match(/^\/custom-metadata\/fields\/(\d+)$/);
            if (match && req.method === "PATCH") {
                if (!fake.canManageFields) return json({ message: "Forbidden" }, 403);
                const field = findField(match[1]!)!;
                field.enabledLibraryIds = body!.enabledLibraryIds;
                return json(field);
            }
            match = path.match(/^\/books\/files\/(\d+)\/download$/);
            if (match) {
                const fileId = Number(match[1]);
                const book = fake.books.find((b) => b.contents[fileId]);
                if (!book) return json({ message: "Not found" }, 404);
                fake.downloads++;
                const bytes = fake.paths[fileId] ? await Bun.file(fake.paths[fileId]).bytes() : book.contents[fileId]!;
                // Like BookOrbit: an ASCII fallback and the real name in UTF-8
                return new Response(new Uint8Array(bytes), {
                    headers: {
                        "content-type": "application/epub+zip",
                        "content-disposition": `attachment; filename="Moby-Dick - Herman Melville.epub"; filename*=UTF-8''${encodeURIComponent("Moby-Dick – Herman Melville.epub")}`,
                    },
                });
            }
            match = path.match(/^\/books\/(\d+)$/);
            if (match && req.method === "GET") {
                const book = fake.books.find((b) => b.id === Number(match![1]));
                if (!book) return json({ message: "Not found" }, 404);
                return json({
                    id: book.id, libraryId: book.libraryId,
                    files: book.files.map((f) => ({ ...f, absolutePath: fake.paths[f.id] ?? `/books/missing-${f.id}.epub` })),
                });
            }
            match = path.match(/^\/scanner\/libraries\/(\d+)\/scan$/);
            if (match && req.method === "POST") {
                if (fake.busyScans > 0) {
                    fake.busyScans--;
                    return json({ message: "A scan is already running" }, 409);
                }
                fake.scans.push(Number(match[1]));
                return json({ started: true }, 202);
            }
            match = path.match(/^\/books\/(\d+)\/metadata$/);
            if (match && req.method === "PATCH") {
                const book = fake.books.find((b) => b.id === Number(match![1]));
                if (!book) return json({ message: "Not found" }, 404);
                for (const { fieldId, value } of body!.customMetadata) {
                    const field = fake.fields.find((f) => f.id === fieldId);
                    if (!field?.enabledLibraryIds.includes(book.libraryId)) {
                        return json({ message: `Custom metadata field ${fieldId} is not enabled for this book` }, 400);
                    }
                    fake.values[book.id] ??= {};
                    if (value === null) delete fake.values[book.id]![fieldId];
                    else fake.values[book.id]![fieldId] = value;
                }
                fake.valueWrites++;
                return json({ id: book.id });
            }
            return json({ message: `no fake for ${req.method} ${path}` }, 404);
        },
    });
    fake.url = server.url.origin;
    fake.stop = () => server.stop(true);
    return fake;
}

export type FakeBookOrbit = ReturnType<typeof startFakeBookOrbit>;

let nextFileId = 100;

/** Add a book with one EPUB file (or several), as BookOrbit lists it. Returns the file IDs. */
export function addBook(fake: FakeBookOrbit, book: { id: number; title: string; libraryId?: number; epubs: Uint8Array[]; otherFormats?: string[] }) {
    const contents: Record<number, Uint8Array> = {};
    const files = book.epubs.map((bytes) => {
        const id = nextFileId++;
        contents[id] = bytes;
        return { id, format: "epub", role: "primary", sizeBytes: bytes.length };
    });
    for (const format of book.otherFormats ?? []) files.push({ id: nextFileId++, format, role: "alternate", sizeBytes: 1234 });
    fake.books.push({ id: book.id, libraryId: book.libraryId ?? 1, title: book.title, authors: ["Herman Melville"], files, contents });
    return files.filter((f) => f.format === "epub").map((f) => f.id);
}

/** Replace the contents of a file, as when a new version of the book is uploaded. */
export function replaceFile(fake: FakeBookOrbit, fileId: number, bytes: Uint8Array) {
    const book = fake.books.find((b) => b.contents[fileId])!;
    book.contents[fileId] = bytes;
    book.files.find((f) => f.id === fileId)!.sizeBytes = bytes.length;
}

export function valueOf(fake: FakeBookOrbit, bookId: number, label: string): unknown {
    const field = fake.fields.find((f) => f.label === label);
    return field ? fake.values[bookId]?.[field.id] : undefined;
}

export function addField(fake: FakeBookOrbit, label: string, type: FieldType, enabledLibraryIds: number[]) {
    const field = { id: fake.fields.length + 10, label, type, enabledLibraryIds };
    fake.fields.push(field);
    return field;
}

export async function makeConfig(fake: FakeBookOrbit, overrides: Partial<Config> = {}): Promise<Config> {
    return {
        bookorbitUrl: fake.url,
        bookorbitUser: USER,
        bookorbitPassword: PASSWORD,
        bookorbitPublicUrl: "https://books.example.org",
        reportUrl: "http://192.168.1.139:8080",
        port: 8080,
        basePath: "",
        requireLogin: false,
        checkInterval: 300,
        maxFileSize: 200 * 1024 * 1024,
        dataDir: await mkdtemp(join(tmpdir(), "orbitkit-test-")),
        dryRun: false,
        ownFixes: false,
        epublift: false,
        epubliftPath: "epublift",
        replaceInLibrary: false,
        ...overrides,
    };
}

/** Put a book's file into a library folder on disk, where the fake serves it from, as BookOrbit's library would. */
export async function placeInLibrary(fake: FakeBookOrbit, libraryDir: string, fileId: number, name = `book-${fileId}.epub`): Promise<string> {
    const book = fake.books.find((b) => b.contents[fileId])!;
    const path = join(libraryDir, name);
    await Bun.write(path, book.contents[fileId]!);
    fake.paths[fileId] = path;
    return path;
}
