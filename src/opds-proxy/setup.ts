import { newSetupCode, normalizeToken } from "./tokens.ts";

export const MIN_SETUP_CODE_LENGTH = 12;
// Values people copy from examples. A guessable code would let anyone on the network claim the admin account.
const PLACEHOLDERS = /change.?me|change.?it|example|placeholder|your.?code|setup.?code/i;

export class SetupCodeError extends Error {}

export interface SetupCode {
    code: string;
    /** "env": from SETUP_CODE; "generated": random, printed in the log */
    source: "env" | "generated";
}

/**
 * The one-time code that protects the setup page, or undefined once an admin password exists.
 * Throws SetupCodeError for a SETUP_CODE that is too weak to rely on.
 */
export function resolveSetupCode(adminConfigured: boolean, fromEnv: string | undefined): SetupCode | undefined {
    if (adminConfigured) return undefined;
    const value = fromEnv?.trim();
    if (!value) return { code: newSetupCode(), source: "generated" };
    if (value.length < MIN_SETUP_CODE_LENGTH) {
        throw new SetupCodeError(`SETUP_CODE must have at least ${MIN_SETUP_CODE_LENGTH} characters.`);
    }
    if (PLACEHOLDERS.test(value) || /^(.)\1+$/.test(value)) {
        throw new SetupCodeError("SETUP_CODE looks like a placeholder. Use a random value, e.g. from: openssl rand -hex 8");
    }
    // Compared case-insensitively, like reader tokens
    return { code: normalizeToken(value), source: "env" };
}
