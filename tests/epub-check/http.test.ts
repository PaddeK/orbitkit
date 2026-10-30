import { expect, test } from "bun:test";
import { dispositionFilename } from "../../src/http.ts";

test("file names from Content-Disposition, preferring the UTF-8 form", () => {
    expect(dispositionFilename(`attachment; filename="Moby Dick.epub"; filename*=UTF-8''Moby-Dick%20%E2%80%93%20Melville.epub`))
        .toBe("Moby-Dick – Melville.epub");
    expect(dispositionFilename('attachment; filename="Moby Dick.epub"')).toBe("Moby Dick.epub");
    expect(dispositionFilename("attachment; filename=moby.epub")).toBe("moby.epub");
    expect(dispositionFilename(`attachment; filename="Moby Dick.epub"; filename*=UTF-8''%E0%A4%A`)).toBe("Moby Dick.epub");
    expect(dispositionFilename("attachment")).toBeUndefined();
    expect(dispositionFilename(null)).toBeUndefined();
});
