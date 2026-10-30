import { expect, test } from "bun:test";
import { SetupCodeError, resolveSetupCode } from "../../src/opds-proxy/setup.ts";

test("no setup code once an admin password exists, even if SETUP_CODE is set", () => {
    expect(resolveSetupCode(true, undefined)).toBeUndefined();
    expect(resolveSetupCode(true, "7f3a9c1e5b2d8a40")).toBeUndefined();
});

test("generates a random code when SETUP_CODE is not set", () => {
    const a = resolveSetupCode(false, undefined)!;
    const b = resolveSetupCode(false, "  ")!;
    expect(a.source).toBe("generated");
    expect(a.code).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(b.source).toBe("generated");
    expect(a.code).not.toBe(b.code);
});

test("uses SETUP_CODE, trimmed and case-insensitive", () => {
    expect(resolveSetupCode(false, "  7F3A9C1E5B2D8A40 ")).toEqual({ code: "7f3a9c1e5b2d8a40", source: "env" });
});

test.each(["short", "12345678901", "change-me-please", "CHANGEME12345", "example-setup-123", "your-code-goes-here",
    "aaaaaaaaaaaaaaaa", "my-setup-code-1"])("rejects weak SETUP_CODE %p", (value) => {
    expect(() => resolveSetupCode(false, value)).toThrow(SetupCodeError);
});
