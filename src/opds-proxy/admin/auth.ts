import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "opds_admin";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 8;

function signature(secret: string, expires: number): string {
    return createHmac("sha256", secret).update(`admin:${expires}`).digest("base64url");
}

/** Stateless session: "<expiry>.<hmac>". Rotating the secret logs everyone out. */
export function newSession(secret: string, now = Date.now()): string {
    const expires = now + SESSION_TTL_MS;
    return `${expires}.${signature(secret, expires)}`;
}

export function verifySession(secret: string, value: string | undefined, now = Date.now()): boolean {
    const [expires, sig] = (value ?? "").split(".");
    if (!expires || !sig || !/^\d+$/.test(expires) || Number(expires) < now) return false;
    const expected = Buffer.from(signature(secret, Number(expires)));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
}

export function sessionCookie(value: string, secure: boolean): string {
    return `${SESSION_COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`;
}

export function clearedSessionCookie(): string {
    return `${SESSION_COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function getCookie(req: Request, name: string): string | undefined {
    for (const part of (req.headers.get("cookie") ?? "").split(";")) {
        const [key, ...rest] = part.trim().split("=");
        if (key === name) return rest.join("=");
    }
    return undefined;
}

/** Reject cross-site form posts (CSRF), on top of the SameSite=Strict cookie. */
export function isSameOrigin(req: Request, allowedHosts: string[]): boolean {
    // Modern browsers state directly whether a request comes from our own pages. Prefer that over Origin,
    // which can legitimately be "null" (e.g. under a strict Referrer-Policy).
    const site = req.headers.get("sec-fetch-site");
    if (site) return site === "same-origin" || site === "none";
    const origin = req.headers.get("origin");
    if (!origin) return true; // non-browser client; it has no ambient cookies to abuse
    if (origin === "null") return false;
    try {
        return allowedHosts.includes(new URL(origin).host);
    } catch {
        return false;
    }
}

/** Per-client brute-force protection for the login and setup forms. */
export class Throttle {
    private failures = new Map<string, { count: number; until: number }>();

    constructor(private readonly freeAttempts = 5, private readonly lockMs = 60_000) {}

    /** Milliseconds this client still has to wait, 0 if it may try. */
    blockedFor(key: string, now = Date.now()): number {
        const entry = this.failures.get(key);
        return entry && entry.until > now ? entry.until - now : 0;
    }

    fail(key: string, now = Date.now()): void {
        if (this.failures.size > 10_000) this.failures.clear();
        const entry = this.failures.get(key) ?? { count: 0, until: 0 };
        entry.count++;
        if (entry.count >= this.freeAttempts) {
            entry.until = now + this.lockMs * 2 ** Math.min(entry.count - this.freeAttempts, 4);
        }
        this.failures.set(key, entry);
    }

    succeed(key: string): void {
        this.failures.delete(key);
    }
}
