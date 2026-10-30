import { expect, test } from "bun:test";
import { epubveriVersion, validateEpub } from "../../src/epub-check/validator.ts";
import { brokenEpub, validEpub } from "./epub.ts";

test("epubveri loads and reports its version", () => {
    expect(epubveriVersion).toMatch(/^\d+\.\d+\.\d+/);
});

test("a valid EPUB has no findings", () => {
    const result = validateEpub(validEpub());
    expect(result.findings).toEqual([]);
    expect(result.counts).toEqual({ fatal: 0, error: 0, warning: 0 });
});

test("a missing resource is an error with code and location", () => {
    const result = validateEpub(brokenEpub());
    expect(result.counts.error).toBeGreaterThan(0);
    expect(result.counts.fatal).toBe(0);
    const finding = result.findings.find((f) => f.severity === "error")!;
    expect(finding.code).toMatch(/^[A-Z]{3}-\d{3}/);
    expect(finding.message).toContain("whale.jpg");
});

test("a file that is no EPUB at all is fatal", () => {
    const result = validateEpub(new TextEncoder().encode("Call me Ishmael."));
    expect(result.counts.fatal).toBeGreaterThan(0);
});
