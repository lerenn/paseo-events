import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { EventObject, SourceView } from "../../shared/events";
import { matches, validateMatch, type MatchSpec } from "../jsonpath";
import type { TokenStore } from "../tokens";
import { quote, UsageError, type PollResult, type Source } from "./types";

const RING = 200;

export const webhookFilterSchema = z.object({
  name: z.string().describe("Webhook name, the <name> in /events/webhook/<name>."),
  match: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))])).optional()
    .describe("JSONPath -> value (or list of accepted values) the payload must match, for example {\"$.action\":\"opened\",\"$.repository.name\":[\"a\",\"b\"]}."),
  types: z.array(z.string()).optional().describe("Only these event types. The type is the payload's `type` field or the x-event-type header."),
});

interface Stored {
  seq: number;
  event: EventObject;
  payload: unknown;
}

/** Verify `sha256=<hex>` (or bare hex) of HMAC-SHA256(secret, raw body) in constant time. */
export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const given = Buffer.from(header.replace(/^sha256=/i, "").trim(), "hex");
  const want = createHmac("sha256", secret).update(body).digest();
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * Any system POSTs JSON to /events/webhook/<name>, signed with an HMAC secret. Deliveries go into
 * a small per-name ring; a subscription's baseline is the sequence number at subscribe time, and
 * its filter (JSONPath matches) picks the deliveries it wants.
 */
export class WebhookSource implements Source {
  id = "webhook";
  name = "Webhook";
  types = [] as readonly string[];
  private readonly rings = new Map<string, { seq: number; items: Stored[] }>();
  private listenerState: () => { url: string | null; error: string | null } = () => ({ url: null, error: null });

  constructor(private readonly secrets: TokenStore, private readonly names: () => string[], private readonly onIngest: (name: string) => void = () => {}) {}

  setListener(state: () => { url: string | null; error: string | null }) {
    this.listenerState = state;
  }

  /** Called by the HTTP listener. Returns an HTTP status. */
  ingest(name: string, body: Buffer, headers: Record<string, string | string[] | undefined>): { status: number; message: string } {
    if (!this.names().includes(name)) return { status: 404, message: "unknown webhook" };
    const secret = this.secrets.get(name);
    if (!secret) return { status: 404, message: "unknown webhook" };
    const sig = headers["x-events-signature"] ?? headers["x-hub-signature-256"];
    if (!verifySignature(secret, body, Array.isArray(sig) ? sig[0] : sig)) return { status: 401, message: "bad signature" };
    let payload: any;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      return { status: 400, message: "body must be JSON" };
    }
    const header = (k: string) => (Array.isArray(headers[k]) ? (headers[k] as string[])[0] : (headers[k] as string | undefined));
    const type = String(header("x-event-type") ?? payload?.type ?? "webhook");
    const id = header("x-event-id") ?? header("x-github-delivery") ?? createHash("sha256").update(body).digest("hex").slice(0, 24);
    const ring = this.rings.get(name) ?? { seq: 0, items: [] };
    this.rings.set(name, ring);
    if (ring.items.some((i) => i.event.id === `webhook:${name}:${id}`)) return { status: 200, message: "duplicate" };
    ring.seq++;
    ring.items.push({ seq: ring.seq, payload, event: { id: `webhook:${name}:${id}`, source: "webhook", type, subject: name, time: new Date().toISOString(), data: payload } });
    if (ring.items.length > RING) ring.items.splice(0, ring.items.length - RING);
    this.onIngest(name);
    return { status: 202, message: "accepted" };
  }

  async parseFilter(raw: unknown) {
    const parsed = webhookFilterSchema.safeParse(raw);
    if (!parsed.success) throw new UsageError(`Invalid webhook filter: ${z.prettifyError(parsed.error)}`);
    const f = parsed.data;
    if (!this.names().includes(f.name)) throw new UsageError(`Unknown webhook ${f.name}. Configured: ${this.names().join(", ") || "none"}.`);
    try {
      validateMatch(f.match as MatchSpec | undefined);
    } catch (err) {
      throw new UsageError((err as Error).message);
    }
    return { name: f.name, match: f.match ?? {}, types: f.types ?? [] };
  }

  async init(filter: Record<string, any>) {
    return { baseline: { seq: this.rings.get(filter.name)?.seq ?? 0 } };
  }

  async poll(filter: Record<string, any>, raw: unknown): Promise<PollResult> {
    const b = raw as { seq: number };
    const ring = this.rings.get(filter.name);
    const fresh = (ring?.items ?? []).filter((i) => i.seq > b.seq);
    const events = fresh
      .filter((i) => (!filter.types.length || filter.types.includes(i.event.type)) && matches(i.payload, filter.match))
      .map((i) => i.event);
    return { events, baseline: { seq: ring?.seq ?? b.seq } };
  }

  describe(e: EventObject): string {
    return `Webhook ${e.subject} delivered ${e.type}:\n${quote(JSON.stringify(e.data))}`;
  }

  label(filter: Record<string, any>) {
    return `webhook ${filter.name}`;
  }

  status(): SourceView {
    const names = this.names();
    const l = this.listenerState();
    if (!names.length) return { id: this.id, name: this.name, state: "not_configured", detail: "No webhook configured. Add a name and a secret in settings." };
    if (l.error) return { id: this.id, name: this.name, state: "error", detail: l.error };
    if (!l.url) return { id: this.id, name: this.name, state: "not_configured", detail: "The webhook listener is off. Set a webhook port in settings." };
    return { id: this.id, name: this.name, state: "connected", detail: `${names.map((n) => `${l.url}/events/webhook/${n}`).join(", ")}` };
  }
}
