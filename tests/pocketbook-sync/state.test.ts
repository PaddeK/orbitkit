import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { STATE_FILE, State } from "../../src/pocketbook-sync/state.ts";

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(`${tmpdir()}/orbitkit-pocketbook-`);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

test("migrates the state file of the Python version", async () => {
    await Bun.write(`${dir}/${STATE_FILE}`, JSON.stringify({
        device_id: "pb-bridge-0123456789abcdef",
        pocketbook: { access_token: "a", refresh_token: "r", expires_at: 1793236000.5 },
        books: { abc: { koreader: "1e87cd74d66b28aa30656f4ac6fe2312", title: "Moby Dick", matched: true, pushed: [26, 1793229329] } },
        last_success: 1793229496,
    }));
    const state = await State.open(dir);
    expect(state.data).toEqual({
        version: 1,
        deviceId: "pb-bridge-0123456789abcdef",
        pocketbook: { accessToken: "a", refreshToken: "r", expiresAt: 1793236000500 },
        books: { abc: { koreaderHash: "1e87cd74d66b28aa30656f4ac6fe2312", title: "Moby Dick", matched: true, sent: { percent: 26, mtime: 1793229329 } } },
        lastSuccess: 1793229496000,
    });
    expect(((await Bun.file(`${dir}/${STATE_FILE}`).json()) as { version?: number }).version).toBe(1);
});

test("keeps the state file of pocketorbit as it is", async () => {
    const data = { version: 1 as const, deviceId: "pb-bridge-9f888d61d3bf2852", pocketbook: {}, books: {}, lastSuccess: 1793229496000 };
    await Bun.write(`${dir}/${STATE_FILE}`, JSON.stringify(data));
    expect((await State.open(dir)).data).toEqual(data);
});
