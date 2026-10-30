import { readFileSync } from "node:fs";

export class ConfigError extends Error {}

export type Env = Record<string, string | undefined>;

/**
 * Reads settings from environment variables. Every setting NAME can also be read from the file in NAME_FILE (Docker
 * secrets). Missing required settings are collected, so they can all be reported at once.
 */
export class Settings {
    readonly missing: string[] = [];

    constructor(private readonly env: Env) {}

    get(name: string, required = false): string | undefined {
        const file = this.env[`${name}_FILE`];
        let value: string | undefined;
        if (file) {
            try {
                value = readFileSync(file, "utf8").trim();
            } catch (err) {
                throw new ConfigError(`Cannot read ${name}_FILE: ${(err as Error).message}`);
            }
        } else {
            value = this.env[name]?.trim();
        }
        if (!value && required) this.missing.push(name);
        return value || undefined;
    }

    has(name: string): boolean {
        return this.env[name] !== undefined || this.env[`${name}_FILE`] !== undefined;
    }

    /** true for 1/true/yes, false for 0/false/no or nothing */
    flag(name: string, fallback = false): boolean {
        const value = this.get(name)?.toLowerCase();
        if (value === undefined) return fallback;
        if (["1", "true", "yes", "on"].includes(value)) return true;
        if (["0", "false", "no", "off"].includes(value)) return false;
        throw new ConfigError(`${name} must be true or false, got "${value}"`);
    }

    whole(name: string, fallback: number, min: number): number {
        const value = this.get(name);
        if (value === undefined) return fallback;
        const number = Number(value);
        if (!Number.isInteger(number)) throw new ConfigError(`${name} must be a whole number, got "${value}"`);
        if (number < min) throw new ConfigError(`${name} must be at least ${min}`);
        return number;
    }

    /** An http(s) URL without trailing slashes */
    url(name: string, required = false): string | undefined {
        const value = this.get(name, required)?.replace(/\/+$/, "");
        if (value !== undefined && !/^https?:\/\/[^/]/.test(value)) throw new ConfigError(`${name} must start with http:// or https://`);
        return value;
    }
}
