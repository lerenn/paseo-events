import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { FactoryDelivery } from "./manager";

export const defaultEndpointFile = path.join(homedir(), ".paseo", "factory", "endpoint.json");

/**
 * Paseo Factory, found at runtime. Factory writes `{url, token}` to a file; its absence means
 * Factory is not installed. No import dependency: the entry point is loopback HTTP with a bearer
 * token, `POST /blueprints/start` -> {runId}, idempotent per idempotencyKey.
 */
export class HttpFactory implements FactoryDelivery {
  constructor(private readonly file = defaultEndpointFile, private readonly fetchImpl: typeof fetch = fetch) {}

  private endpoint(): { url: string; token: string } | null {
    try {
      const { url, token } = JSON.parse(readFileSync(this.file, "utf8"));
      return typeof url === "string" && typeof token === "string" ? { url: url.replace(/\/$/, ""), token } : null;
    } catch {
      return null;
    }
  }

  async available() {
    return this.endpoint() !== null;
  }

  async start(blueprint: string, vars: Record<string, unknown>, idempotencyKey: string): Promise<string> {
    const e = this.endpoint();
    if (!e) throw new Error("Paseo Factory is not installed (no endpoint file).");
    const res = await this.fetchImpl(`${e.url}/blueprints/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${e.token}`, "content-type": "application/json" },
      body: JSON.stringify({ blueprint, vars, requestedBy: "events", idempotencyKey }),
      signal: AbortSignal.timeout(20_000) as any,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Factory answered ${res.status}: ${text.slice(0, 200).split(e.token).join("***")}`);
    return JSON.parse(text).runId as string;
  }

  /** Blueprint names and required vars, to validate vars_map at subscribe time. Null when unavailable. */
  async blueprints(): Promise<unknown[] | null> {
    const e = this.endpoint();
    if (!e) return null;
    try {
      const res = await this.fetchImpl(`${e.url}/blueprints`, { headers: { authorization: `Bearer ${e.token}` }, signal: AbortSignal.timeout(10_000) as any });
      return res.ok ? ((await res.json()) as unknown[]) : null;
    } catch {
      return null;
    }
  }
}
