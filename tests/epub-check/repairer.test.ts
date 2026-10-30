import { describe, expect, test } from "bun:test";
import { epubsanaVersion, planId, planRepair, repair, SERIES_FIX } from "../../src/epub-check/repairer.ts";
import { validateEpub } from "../../src/epub-check/validator.ts";
import { brokenEpub, epub2, MISSING_IMAGE, repairableEpub, validEpub } from "./epub.ts";

test("epubsana loads and reports its version", () => {
    expect(epubsanaVersion).toMatch(/^\d+\.\d+\.\d+/);
});

test("the plan lists safe fixes and fixes to confirm, and tries the safe ones", async () => {
    const plan = (await planRepair(repairableEpub()))!;
    expect(plan.fixes.map((f) => [f.index, f.safe, f.code])).toEqual([[0, true, "OPF-014"], [1, false, "RSC-001"]]);
    expect(plan.fixes[1]!.title).toContain("whale.jpg");
    expect(plan.fixes[1]!.changes[0]!.path).toBe("OEBPS/content.opf");
    expect(plan.safe.before.error).toBe(2);
    expect(plan.safe.after.error).toBe(1);
    expect(plan.safe.outcomes).toEqual({ 0: { outcome: "applied" }, 1: { outcome: "skipped" } });
});

test("applying every fix makes the book valid", async () => {
    const result = (await repair(repairableEpub(), [0, 1]))!;
    expect(result.result.after).toEqual({ fatal: 0, error: 0, warning: 0 });
    expect(result.remaining).toEqual([]);
    expect(validateEpub(result.bytes).counts).toEqual({ fatal: 0, error: 0, warning: 0 });
});

test("only the chosen fixes are applied; unknown indices are ignored", async () => {
    const result = (await repair(repairableEpub(), [1, 7, -1]))!;
    expect(result.result.outcomes[0]?.outcome).toBe("skipped");
    expect(result.result.outcomes[1]?.outcome).toBe("applied");
    expect(result.remaining.filter((f) => f.severity === "error").map((f) => f.code)).toEqual(["OPF-014"]);
});

test("nothing to plan for a valid book or one epubsana cannot read", async () => {
    expect(await planRepair(validEpub())).toBeNull();
    expect(await planRepair(new TextEncoder().encode("Call me Ishmael."))).toBeNull();
});

test("a plan's ID changes with its fixes", async () => {
    const repairable = (await planRepair(repairableEpub()))!.fixes;
    expect(planId(repairable)).toBe(planId((await planRepair(repairableEpub()))!.fixes));
    expect(planId(repairable)).not.toBe(planId((await planRepair(brokenEpub()))!.fixes));
});

describe("with EPUB_CHECK_FIXES: the series fix", () => {
    const own = { ownFixes: true };

    test("BookOrbit's series metas get orbitkit's own fix, safe here, tried with the other safe ones", async () => {
        expect(await planRepair(epub2())).toBeNull();
        const plan = (await planRepair(epub2(), own))!;
        expect(plan.fixes.map((f) => [f.index, f.source, f.safe, f.code])).toEqual([[SERIES_FIX, "orbitkit", true, "RSC-005"]]);
        expect(plan.safe.after).toEqual({ fatal: 0, error: 0, warning: 0 });
        expect(plan.safe.outcomes[SERIES_FIX]).toEqual({ outcome: "applied" });
    });

    test("it is applied only when chosen", async () => {
        const skipped = (await repair(epub2(), [], own))!;
        expect(skipped.result.outcomes[SERIES_FIX]?.outcome).toBe("skipped");
        expect(skipped.remaining.filter((f) => f.code === "RSC-005").length).toBeGreaterThan(0);
        expect((await repair(epub2(), [SERIES_FIX], own))!.remaining).toEqual([]);
    });

    test("together with epubsana's fixes: epubsana's first, then orbitkit's, counted from the original", async () => {
        const book = epub2(undefined, {}, MISSING_IMAGE);
        const plan = (await planRepair(book, own))!;
        expect(plan.fixes.map((f) => [f.source, f.code, f.safe])).toEqual([["orbitkit", "RSC-005", true], ["epubsana", "RSC-001", false]]);
        const before = validateEpub(book).counts;
        expect(plan.safe.before).toEqual(before);
        expect(plan.safe.after.error).toBe(1);

        const all = (await repair(book, plan.fixes.map((f) => f.index), own))!;
        expect(all.result.outcomes).toEqual({ [SERIES_FIX]: { outcome: "applied" }, 0: { outcome: "applied" } });
        expect(all.result.before).toEqual(before);
        expect(all.result.after).toEqual({ fatal: 0, error: 0, warning: 0 });
        expect(validateEpub(all.bytes).counts).toEqual({ fatal: 0, error: 0, warning: 0 });
    });
});
