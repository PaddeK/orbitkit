import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checker } from "../../src/epub-check/check.ts";
import type { Config } from "../../src/epub-check/config.ts";
import { Replacer, ReplaceError } from "../../src/epub-check/replace.ts";
import { repair, SERIES_FIX } from "../../src/epub-check/repairer.ts";
import { State } from "../../src/epub-check/state.ts";
import { validateEpub } from "../../src/epub-check/validator.ts";
import { brokenEpub, epub2, repairableEpub, validEpub } from "./epub.ts";
import { addBook, makeConfig, placeInLibrary, startFakeBookOrbit, type FakeBookOrbit } from "./helpers.ts";

let fake: FakeBookOrbit;
let config: Config;
let library: string;
let state: State;
let checker: Checker;
let replacer: Replacer;

async function setUp(overrides: Partial<Config> = {}) {
    config = await makeConfig(fake, { replaceInLibrary: true, ownFixes: true, ...overrides });
    state = await State.open(config.dataDir);
    checker = new Checker(config, state);
    await checker.cycle();
    replacer = new Replacer(config, state, checker, 0);
}

beforeEach(async () => {
    fake = startFakeBookOrbit();
    library = await mkdtemp(join(tmpdir(), "orbitkit-library-"));
});
afterEach(() => fake.stop());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a repaired book replaces the file in the library, keeping a backup and asking BookOrbit to scan", async () => {
    const [fileId] = addBook(fake, { id: 1, title: "Moby Dick", epubs: [epub2()] });
    const path = await placeInLibrary(fake, library, fileId!);
    await chmod(path, 0o640);
    await setUp();
    const original = await Bun.file(path).bytes();
    const repaired = (await repair(original, [SERIES_FIX], { ownFixes: true }))!.bytes;

    const replaced = await replacer.replace(1, fileId!, "Moby Dick", original, repaired);

    expect(replaced.path).toBe(path);
    expect(Buffer.from(await Bun.file(path).bytes()).equals(Buffer.from(repaired))).toBe(true);
    expect(Buffer.from(await Bun.file(replaced.backup).bytes()).equals(Buffer.from(original))).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    // No temporary file is left next to the book
    expect(await readdir(library)).toEqual([`book-${fileId}.epub`]);
    // The report shows the new state right away
    expect(state.data.files[fileId!]?.counts).toEqual({ fatal: 0, error: 0, warning: 0 });
    await sleep(20);
    expect(fake.scans).toEqual([1]);
});

test("a file that changed on disk since it was repaired is left alone", async () => {
    const [fileId] = addBook(fake, { id: 1, title: "Moby Dick", epubs: [epub2()] });
    const path = await placeInLibrary(fake, library, fileId!);
    await setUp();
    const original = await Bun.file(path).bytes();
    const repaired = (await repair(original, [SERIES_FIX], { ownFixes: true }))!.bytes;
    await Bun.write(path, validEpub("Moby Dick, edited elsewhere"));

    await expect(replacer.replace(1, fileId!, "Moby Dick", original, repaired)).rejects.toThrow("changed in the meantime");
    expect(validateEpub(await Bun.file(path).bytes()).findings).toEqual([]);
    expect(fake.scans).toEqual([]);
});

test("a library that is not mounted, or not writable, is a clear error and changes nothing", async () => {
    const [fileId] = addBook(fake, { id: 1, title: "Moby Dick", epubs: [epub2()] });
    await setUp();
    const original = epub2();
    const repaired = (await repair(original, [SERIES_FIX], { ownFixes: true }))!.bytes;
    await expect(replacer.replace(1, fileId!, "Moby Dick", original, repaired)).rejects.toThrow("Mount the library");

    const path = await placeInLibrary(fake, library, fileId!);
    await chmod(library, 0o555);
    try {
        const error = await replacer.replace(1, fileId!, "Moby Dick", original, repaired).catch((err) => err);
        // Root may write anyway; everyone else gets the hint
        if (process.getuid?.() !== 0) {
            expect(error).toBeInstanceOf(ReplaceError);
            expect((error as Error).message).toContain("may not write to");
            expect(Buffer.from(await Bun.file(path).bytes()).equals(Buffer.from(original))).toBe(true);
            expect(await readdir(library)).toEqual([`book-${fileId}.epub`]);
        }
    } finally {
        await chmod(library, 0o755);
    }
});

test("a library already being scanned is asked again", async () => {
    const [fileId] = addBook(fake, { id: 1, title: "Moby Dick", epubs: [epub2()] });
    const path = await placeInLibrary(fake, library, fileId!);
    await setUp();
    fake.busyScans = 1;
    const original = await Bun.file(path).bytes();
    await replacer.replace(1, fileId!, "Moby Dick", original, (await repair(original, [SERIES_FIX], { ownFixes: true }))!.bytes);
    await sleep(20);
    expect(fake.scans).toEqual([]);
    await replacer.flushScans(2);
    expect(fake.scans).toEqual([1]);
});

test("replace all: the books whose safe fixes remove errors, with only those fixes", async () => {
    const [series] = addBook(fake, { id: 1, title: "Moby Dick (EPUB 2)", epubs: [epub2()] });
    const [repairable] = addBook(fake, { id: 2, title: "Moby Dick (scripted)", epubs: [repairableEpub()] });
    const [broken] = addBook(fake, { id: 3, title: "Moby Dick (broken)", epubs: [brokenEpub()] });
    const [valid] = addBook(fake, { id: 4, title: "Moby Dick", epubs: [validEpub()] });
    for (const id of [series, repairable, broken, valid]) await placeInLibrary(fake, library, id!);
    await setUp();

    // The broken book only has a fix to confirm, the valid one none
    expect(replacer.candidates().map((c) => [c.title, c.errors, c.errorsAfterSafeFixes])).toEqual([
        ["Moby Dick (EPUB 2)", 11, 0],
        ["Moby Dick (scripted)", 2, 1],
    ]);
    expect(replacer.startReplaceAll()).toBe(true);
    expect(replacer.startReplaceAll()).toBe(false);
    await replacer.job!.done;

    expect(replacer.job!.items.map((i) => [i.title, i.outcome])).toEqual([["Moby Dick (EPUB 2)", "replaced"], ["Moby Dick (scripted)", "replaced"]]);
    expect(validateEpub(await Bun.file(fake.paths[series!]!).bytes()).counts.error).toBe(0);
    // Only the safe fix: the missing image (to confirm) is still declared
    expect(validateEpub(await Bun.file(fake.paths[repairable!]!).bytes()).findings.map((f) => f.code)).toContain("RSC-001");
    expect(Buffer.from(await Bun.file(fake.paths[broken!]!).bytes()).equals(Buffer.from(brokenEpub()))).toBe(true);
    expect(replacer.candidates()).toEqual([]);
    await sleep(20);
    expect(fake.scans).toEqual([1]);
});

test("replace all reports books that fail and goes on with the rest", async () => {
    const [first] = addBook(fake, { id: 1, title: "Moby Dick 1", epubs: [epub2()] });
    const [second] = addBook(fake, { id: 2, title: "Moby Dick 2", epubs: [epub2()] });
    await placeInLibrary(fake, library, second!);
    await setUp();
    replacer.startReplaceAll();
    await replacer.job!.done;
    expect(replacer.job!.items.map((i) => [i.fileId, i.outcome])).toEqual([[first!, "failed"], [second!, "replaced"]]);
    expect(replacer.job!.items[0]!.message).toContain("Mount the library");
});
