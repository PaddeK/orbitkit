/** Minimal auto-escaping HTML templates: html`<p>${userInput}</p>` */

export class SafeHtml {
    constructor(readonly value: string) {}
    toString(): string {
        return this.value;
    }
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

function render(value: unknown): string {
    if (value === null || value === undefined || value === false) return "";
    if (value instanceof SafeHtml) return value.value;
    if (Array.isArray(value)) return value.map(render).join("");
    return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
    let out = strings[0]!;
    values.forEach((value, i) => {
        out += render(value) + strings[i + 1];
    });
    return new SafeHtml(out);
}
