import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { MailDelivery } from "./manager";

export const defaultMailEndpointFile = () => process.env.EVENTS_MAIL_ENDPOINT ?? path.join(homedir(), ".paseo", "agents-mail", "endpoint.json");

const timeout = (ms: number) => {
  const c = new AbortController();
  (setTimeout(() => c.abort(), ms) as any).unref?.();
  return c.signal as any;
};

/**
 * Agents Mail, found at runtime like Factory: it writes `{url, token}` to a file, and a missing file or a failed health
 * check means it is not installed. No import dependency: `POST /api/mails` over loopback with a bearer token.
 * A health result (up or down) is reused for `ttlMs`; a failed send marks it down for that long.
 */
export class HttpMail implements MailDelivery {
  private cached: { at: number; endpoint: { url: string; token: string } | null } | null = null;

  constructor(
    private readonly file: () => string = defaultMailEndpointFile,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 60_000,
  ) {}

  private async endpoint() {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.endpoint;
    let found: { url: string; token: string } | null = null;
    try {
      const raw = JSON.parse(readFileSync(this.file(), "utf8")) as { url?: string; token?: string };
      if (raw.url && raw.token) {
        const url = raw.url.replace(/\/$/, "");
        const res = await this.fetchImpl(`${url}/api/health`, { headers: { authorization: `Bearer ${raw.token}` }, signal: timeout(2000) });
        if (res.ok) found = { url, token: raw.token };
      }
    } catch {
      found = null;
    }
    this.cached = { at: this.now(), endpoint: found };
    return found;
  }

  async available() {
    return (await this.endpoint()) !== null;
  }

  async send(to: string, subject: string, body: string): Promise<void> {
    const e = await this.endpoint();
    if (!e) throw new Error("Agents Mail is not installed or not answering.");
    try {
      const res = await this.fetchImpl(`${e.url}/api/mails`, {
        method: "POST",
        headers: { authorization: `Bearer ${e.token}`, "content-type": "application/json" },
        body: JSON.stringify({ to, subject: subject.slice(0, 200), body, kind: "info", asAgent: { agentId: "events", name: "Events" } }),
        signal: timeout(10_000),
      });
      if (!res.ok) throw new Error(`Agents Mail answered ${res.status}: ${(await res.text()).slice(0, 200).split(e.token).join("***")}`);
    } catch (err) {
      this.cached = { at: this.now(), endpoint: null };
      throw err;
    }
  }
}
