import wasmPath from "@veripublica/epubveri-wasm/epubveri_bg.wasm" with { type: "file" };
import * as bindings from "@veripublica/epubveri-wasm/epubveri_bg.js";
import type { Report } from "@veripublica/epubveri-wasm";
import { loadWasm } from "./wasm.ts";

await loadWasm(wasmPath, bindings);

/** epubveri's version, e.g. "0.35.0+16d7735". A new version re-checks every book. */
export const epubveriVersion: string = bindings.version();

export type Severity = "fatal" | "error" | "warning" | "info" | "usage";

export interface Finding {
    severity: Severity;
    /** epubcheck-compatible message ID, e.g. "RSC-005" */
    code: string;
    message: string;
    /** Path inside the EPUB */
    location?: string;
    line?: number;
    column?: number;
}

export interface Counts {
    fatal: number;
    error: number;
    warning: number;
}

export interface CheckResult {
    counts: Counts;
    findings: Finding[];
}

/** Validate an EPUB with epubveri. Never throws for a broken book: that is a finding. */
export function validateEpub(bytes: Uint8Array): CheckResult {
    let report: Report;
    try {
        report = bindings.validate(bytes, undefined);
    } catch (err) {
        return {
            counts: { fatal: 1, error: 0, warning: 0 },
            findings: [{ severity: "fatal", code: "VALIDATOR", message: `epubveri could not read the file: ${(err as Error).message}` }],
        };
    }
    return {
        counts: { fatal: report.summary.fatal ?? 0, error: report.summary.error, warning: report.summary.warning },
        findings: report.items.map((item) => ({
            severity: item.severity as Severity,
            code: item.code,
            message: item.message,
            location: item.location,
            line: item.position?.line,
            column: item.position?.column,
        })),
    };
}
