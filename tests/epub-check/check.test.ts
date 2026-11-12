import { afterEach, beforeEach, expect, test } from "bun:test";
import { Checker, FIELDS, reportPath, type FileReport } from "../../src/epub-check/check.ts";
import type { Config } from "../../src/epub-check/config.ts";
import { State } from "../../src/epub-check/state.ts";
import { brokenEpub, repairableEpub, validEpub } from "./epub.ts";
import { API_KEY, addBook, addField, makeConfig, replaceFile, startFakeBookOrbit, valueOf, type FakeBookOrbit } from "./helpers.ts";

let fake: FakeBookOrbit;
let config: Config;

beforeEach(async () => {
    fake = startFakeBookOrbit();
    config = await makeConfig(fake);
});
afterEach(() => fake.stop());

async function run(cfg = config) {
    const state = await State.open(cfg.dataDir);
    await new Checker(cfg, state).cycle();
    return state;
}

test("checks every EPUB and writes the verdict to custom fields it creates", async () => {
    addBook(fake, { id: 1, title: "Moby Dick", epubs: [validEpub()] });
    const [brokenId] = addBook(fake, { id: 2, title: "Moby Dick (broken)", epubs: [brokenEpub()] });
    const state = await run();

    expect(fake.fields.map((f) => [f.label, f.type, f.enabledLibraryIds])).toEqual([
        ["EPUB check", "text", [1]],
        ["EPUB errors", "number", [1]],
        ["EPUB warnings", "number", [1]],
        ["EPUB report", "url", [1]],
    ]);
    expect(valueOf(fake, 1, "EPUB check")).toBe("valid");
    expect(valueOf(fake, 1, "EPUB errors")).toBe(0);
    expect(valueOf(fake, 2, "EPUB check")).toBe("errors");
    expect(valueOf(fake, 2, "EPUB errors")).toBe(1);
    expect(valueOf(fake, 2, "EPUB warnings")).toBe(0);
    expect(valueOf(fake, 2, "EPUB report")).toBe("http://192.168.1.139:8080/books/2");
    expect(state.data.lastSuccess).toBeGreaterThan(0);

    const report = (await Bun.file(reportPath(config.dataDir, brokenId!)).json()) as FileReport;
    expect(report.findings.find((f) => f.severity === "error")?.code).toBe("RSC-001");
});

test("books with findings get epubsana's repair plan; valid ones don't", async () => {
    const [validId] = addBook(fake, { id: 1, title: "Moby Dick", epubs: [validEpub()] });
    const [repairableId] = addBook(fake, { id: 2, title: "Moby Dick", epubs: [repairableEpub()] });
    const state = await run();

    expect(state.data.files[repairableId!]?.repair).toEqual({ fixes: 2, safeFixes: 1, errorsAfterSafeFixes: 1 });
    expect(state.data.files[validId!]?.repair).toBeUndefined();
    const report = (await Bun.file(reportPath(config.dataDir, repairableId!)).json()) as FileReport;
    expect(report.repair?.fixes.map((f) => f.code)).toEqual(["OPF-014", "RSC-001"]);
    expect(report.epubsana).toMatch(/^\d+\.\d+\.\d+/);
    // The verdict in BookOrbit is about the book as it is, not as it could be
    expect(valueOf(fake, 2, "EPUB errors")).toBe(2);
});

test("a new epubveri or epubsana version checks every book again", async () => {
    addBook(fake, { id: 1, title: "Moby Dick", epubs: [validEpub()] });
    const state = await run();
    for (const file of Object.values(state.data.files)) file.checkedWith = "epubveri 0.1.0, epubsana 0.1.0";
    await state.save();
    const { downloads } = fake;
    await run();
    expect(fake.downloads).toBe(downloads + 1);
});

test("unchanged books are neither downloaded nor written again", async () => {
    addBook(fake, { id: 1, title: "Moby Dick", epubs: [validEpub()] });
    await run();
    const { downloads, valueWrites } = fake;
    await run();
    expect(fake.downloads).toBe(downloads);
    expect(fake.valueWrites).toBe(valueWrites);
});

test("a replaced file is checked again and its fields updated", async () => {
    const [fileId] = addBook(fake, { id: 1, title: "Moby Dick", epubs: [brokenEpub()] });
    await run();
    expect(valueOf(fake, 1, "EPUB check")).toBe("errors");

    replaceFile(fake, fileId!, validEpub());
    await run();
    expect(valueOf(fake, 1, "EPUB check")).toBe("valid");
    expect(valueOf(fake, 1, "EPUB errors")).toBe(0);
});

test("only EPUB files are checked; books without one are ignored", async () => {
    addBook(fake, { id: 1, title: "Moby Dick", epubs: [], otherFormats: ["pdf"] });
    addBook(fake, { id: 2, title: "Moby Dick", epubs: [validEpub()], otherFormats: ["mobi"] });
    const state = await run();
    expect(fake.downloads).toBe(1);
    expect(Object.keys(state.data.books)).toEqual(["2"]);
});

test("several EPUBs of one book: worst status, summed counts", async () => {
    addBook(fake, { id: 1, title: "Moby Dick", epubs: [validEpub(), brokenEpub(), brokenEpub()] });
    await run();
    expect(valueOf(fake, 1, "EPUB check")).toBe("errors");
    expect(valueOf(fake, 1, "EPUB errors")).toBe(2);
});

test("books removed from BookOrbit are forgotten with their reports", async () => {
    const [fileId] = addBook(fake, { id: 1, title: "Moby Dick", epubs: [brokenEpub()] });
    await run();
    expect(await Bun.file(reportPath(config.dataDir, fileId!)).exists()).toBe(true);

    fake.books = [];
    const state = await run();
    expect(state.data.books).toEqual({});
    expect(state.data.files).toEqual({});
    expect(await Bun.file(reportPath(config.dataDir, fileId!)).exists()).toBe(false);
});

test("without REPORT_URL there is no report field", async () => {
    addBook(fake, { id: 1, title: "Moby Dick", epubs: [validEpub()] });
    await run({ ...config, reportUrl: undefined });
    expect(fake.fields.map((f) => f.label)).not.toContain("EPUB report");
});

test("files over EPUB_CHECK_MAX_FILE_SIZE_MB are not checked", async () => {
    addBook(fake, { id: 1, title: "Moby Dick", epubs: [validEpub()] });
    const state = await run({ ...config, maxFileSize: 100 });
    expect(valueOf(fake, 1, "EPUB check")).toBe("not checked");
    expect(Object.values(state.data.files)[0]?.problem).toMatch(/^larger than/);

    // Raising the limit checks it
    await run();
    expect(valueOf(fake, 1, "EPUB check")).toBe("valid");
});

test("existing fields are used; one not enabled for a library is left alone", async () => {
    const check = addField(fake, "epub check", "text", [1]);
    addField(fake, "EPUB errors", "number", [1, 2]);
    addField(fake, "EPUB warnings", "number", [1, 2]);
    addBook(fake, { id: 1, title: "Moby Dick", epubs: [brokenEpub()] });
    addBook(fake, { id: 2, title: "Moby Dick", libraryId: 2, epubs: [brokenEpub()] });
    await run({ ...config, reportUrl: undefined });

    expect(fake.fields).toHaveLength(3);
    expect(check.enabledLibraryIds).toEqual([1]);
    expect(valueOf(fake, 1, "epub check")).toBe("errors");
    expect(valueOf(fake, 2, "epub check")).toBeUndefined();
    expect(valueOf(fake, 2, "EPUB errors")).toBe(1);
});

test("fields orbitkit created are enabled for libraries added later", async () => {
    addBook(fake, { id: 1, title: "Moby Dick", epubs: [validEpub()] });
    await run();
    addBook(fake, { id: 2, title: "Moby Dick", libraryId: 2, epubs: [validEpub()] });
    await run();
    expect(fake.fields.every((f) => f.enabledLibraryIds.join() === "1,2")).toBe(true);
    expect(valueOf(fake, 2, "EPUB check")).toBe("valid");
});

test("a field recreated in BookOrbit gets its values again", async () => {
    addBook(fake, { id: 1, title: "Moby Dick", epubs: [validEpub()] });
    await run();
    fake.fields = fake.fields.filter((f) => f.label !== "EPUB check");
    await run();
    expect(valueOf(fake, 1, "EPUB check")).toBe("valid");
});

test("without permission to create fields the error says what to do", async () => {
    fake.canManageFields = false;
    addBook(fake, { id: 1, title: "Moby Dick", epubs: [validEpub()] });
    await expect(run()).rejects.toThrow(/Manage libraries.*"EPUB check" \(text\)/);
});

test("a field with the right label but another type is reported", async () => {
    addField(fake, "EPUB errors", "text", [1]);
    addBook(fake, { id: 1, title: "Moby Dick", epubs: [validEpub()] });
    await expect(run()).rejects.toThrow(/"EPUB errors" of type text/);
});

test("dry run checks books but changes nothing in BookOrbit", async () => {
    addBook(fake, { id: 1, title: "Moby Dick", epubs: [brokenEpub()] });
    const state = await run({ ...config, dryRun: true });
    expect(fake.fields).toEqual([]);
    expect(fake.valueWrites).toBe(0);
    expect(Object.values(state.data.files)[0]?.counts?.error).toBe(1);
});

test("the session is kept: refreshed instead of logging in again, also after a restart", async () => {
    addBook(fake, { id: 1, title: "Moby Dick", epubs: [validEpub()] });
    await run();
    expect(fake.logins).toBe(1);

    fake.revokeAccessToken();
    const state = await run();
    expect(fake.logins).toBe(1);
    expect(fake.refreshes).toBe(1);
    expect(state.data.session.refreshToken).toBe(fake.refreshToken);
});

test("a lost session falls back to the password", async () => {
    addBook(fake, { id: 1, title: "Moby Dick", epubs: [validEpub()] });
    await run();
    fake.revokeAccessToken();
    fake.refreshToken = "f".repeat(64);
    await run();
    expect(fake.logins).toBe(2);
});

test("an API key replaces the login", async () => {
    addBook(fake, { id: 1, title: "Moby Dick", epubs: [validEpub()] });
    await run({ ...config, bookorbitApiKey: API_KEY, bookorbitUser: "", bookorbitPassword: "" });
    expect(fake.logins).toBe(0);
    expect(valueOf(fake, 1, "EPUB check")).toBe("valid");
});

test("a refused API key is a clear error, without falling back to a login", async () => {
    await expect(run({ ...config, bookorbitApiKey: "bok_revoked" })).rejects.toThrow("BookOrbit refused the API key");
    expect(fake.logins).toBe(0);
});

test("a wrong password is a clear error", async () => {
    await expect(run({ ...config, bookorbitPassword: "wrong" })).rejects.toThrow("check BOOKORBIT_USER and BOOKORBIT_PASSWORD");
});

test("the field labels are the documented ones", () => {
    expect(Object.values(FIELDS).map((f) => f.label)).toEqual(["EPUB check", "EPUB errors", "EPUB warnings", "EPUB report"]);
});
