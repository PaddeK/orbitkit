// Lowercase, no look-alikes (0/o, 1/l/i, u/v): easy to type on an e-reader keyboard.
const ALPHABET = "abcdefghjkmnpqrstwxyz23456789"; // 29 chars, ~4.86 bits each

function randomChars(count: number): string {
    let out = "";
    while (out.length < count) {
        for (const byte of crypto.getRandomValues(new Uint8Array(count * 2))) {
            // Rejection sampling keeps the distribution uniform
            if (byte < 256 - (256 % ALPHABET.length)) out += ALPHABET[byte % ALPHABET.length];
            if (out.length === count) break;
        }
    }
    return out;
}

function grouped(chars: string): string {
    return chars.match(/.{1,4}/g)!.join("-");
}

/** Reader access token, e.g. "k7m2-x9qp-4rtw-b8nd" (~78 bits). */
export function newAccessToken(): string {
    return grouped(randomChars(16));
}

/** One-time code for claiming the admin account, e.g. "k7m2-x9qp". */
export function newSetupCode(): string {
    return grouped(randomChars(8));
}

/** Tokens are matched case-insensitively, since reader keyboards like to auto-capitalize. */
export function normalizeToken(token: string): string {
    return token.trim().toLowerCase();
}
