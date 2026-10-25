import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export const defaultTokensPath = path.join(homedir(), ".paseo", "events", "tokens.json");

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function normalizeOwner(owner: string): string {
  const trimmed = owner.trim();
  if (!OWNER.test(trimmed)) throw new Error(`Not a GitHub owner or organization name: ${JSON.stringify(owner)}`);
  return trimmed.toLowerCase();
}

/**
 * GitHub tokens, one per owner or organization. Write-only from the UI's point of view: nothing
 * here is returned to the client, which only learns which owners have a token. Stored mode 0600.
 */
export class TokenStore {
  constructor(private readonly file: string = defaultTokensPath) {}

  private read(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  private write(tokens: Record<string, string>) {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(tokens), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  owners(): string[] {
    return Object.keys(this.read()).sort();
  }

  has(owner: string): boolean {
    return Boolean(this.read()[normalizeOwner(owner)]);
  }

  get(owner: string): string | null {
    return this.read()[normalizeOwner(owner)] ?? null;
  }

  set(owner: string, token: string) {
    const clean = token.trim();
    if (!clean) throw new Error("Token is empty");
    if (/\s/.test(clean)) throw new Error("Tokens cannot contain whitespace");
    this.write({ ...this.read(), [normalizeOwner(owner)]: clean });
  }

  clear(owner: string) {
    const { [normalizeOwner(owner)]: _removed, ...rest } = this.read();
    this.write(rest);
  }
}

/** Stable, non-reversible id of a token: owners that share a token share one rate-limit budget. */
export function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/** Remove a secret from a message before it reaches the UI or logs. */
export function scrub(message: string, secret: string | null): string {
  return secret ? message.split(secret).join("***") : message;
}
