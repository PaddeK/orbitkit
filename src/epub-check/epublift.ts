import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./log.ts";

const TIMEOUT_MS = 120_000;

/**
 * epublift (github.com/ePubLift/epublift) upgrades EPUB 2 books to EPUB 3. It runs as its own program, on a copy in a
 * temporary folder; orbitkit offers its result as a fix to confirm, and only where it removes errors.
 */
export class Epublift {
    private constructor(readonly command: string, readonly version: string, private readonly tmpRoot: string) {}

    /** The epublift program, or null if it cannot be run. */
    static async find(command: string, tmpRoot: string): Promise<Epublift | null> {
        const path = command.includes("/") ? command : Bun.which(command);
        if (!path) return null;
        try {
            const proc = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "pipe" });
            const output = (await new Response(proc.stdout).text()).trim();
            if ((await proc.exited) !== 0) return null;
            await mkdir(tmpRoot, { recursive: true });
            return new Epublift(path, output.replace(/^epublift\s+/, ""), tmpRoot);
        } catch {
            return null;
        }
    }

    /** The book upgraded to EPUB 3, or null if epublift failed on it. */
    async lift(bytes: Uint8Array): Promise<Uint8Array | null> {
        const dir = await mkdtemp(join(this.tmpRoot, "lift-"));
        try {
            const input = join(dir, "book.epub");
            const output = join(dir, "lifted.epub");
            await Bun.write(input, bytes);
            const proc = Bun.spawn([this.command, "-i", input, "-o", output, "--report", join(dir, "report.txt"), "-f"], {
                // epublift unpacks into the temporary directory; keep it in the data volume, not in a read-only image
                env: { ...process.env, TMPDIR: dir },
                stdout: "ignore",
                stderr: "pipe",
                timeout: TIMEOUT_MS,
            });
            const stderr = await new Response(proc.stderr).text();
            if ((await proc.exited) !== 0) {
                log.warn(`epublift failed: ${stderr.trim().split("\n").slice(-2).join(" ")}`);
                return null;
            }
            return await Bun.file(output).bytes();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }
}
