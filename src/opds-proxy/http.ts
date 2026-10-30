import type { SafeHtml } from "./admin/html.ts";

/** Externally visible origin, e.g. http://192.168.0.10:8601 (PUBLIC_URL wins over the Host header). */
export function publicOrigin(req: Request, publicUrl?: string): string {
    if (publicUrl) return publicUrl.replace(/\/+$/, "");
    const url = new URL(req.url);
    return `${url.protocol}//${req.headers.get("host") ?? url.host}`;
}

export function redirect(location: string, headers: Record<string, string> = {}): Response {
    return new Response(null, { status: 303, headers: { location, ...headers } });
}

const ADMIN_SECURITY_HEADERS = {
    "content-security-policy": "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "cache-control": "no-store",
};

export function htmlResponse(body: SafeHtml, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(body.value, {
        status,
        headers: { "content-type": "text/html; charset=utf-8", ...ADMIN_SECURITY_HEADERS, ...headers },
    });
}

export function textResponse(body: string, status: number): Response {
    return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
