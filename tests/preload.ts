import { spyOn } from "bun:test";

// The bridge logs every step; in tests that would bury the results
for (const method of ["log", "warn", "error"] as const) spyOn(console, method).mockImplementation(() => {});
