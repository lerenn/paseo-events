import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EventObject, SourceView } from "../../shared/events";
import { quote, UsageError, type PollResult, type Source } from "./types";

export interface ExternalConfig {
  id: string;
  name: string;
  url: string;
  /** Header that carries the secret. Default `authorization`. */
  authHeader: string;
}

const eventSchema = z.object({ id: z.string(), type: z.string(), subject: z.string().default(""), time: z.string().optional(), data: z.record(z.string(), z.any()).default({}) });
const listSchema = z.object({ events: z.array(z.object({ name: z.string(), description: z.string().optional() })).default([]) });
const subscribeSchema = z.object({ subscriptionId: z.string(), cursor: z.any().optional(), satisfied: z.string().optional() });
const pollSchema = z.object({ events: z.array(eventSchema).default([]), cursor: z.any().optional() });

/**
 * A native event server speaking a small SEP-3415 style contract over JSON-RPC 2.0 on HTTP POST:
 *
 *   events/list        {}                          -> {events:[{name, description?}]}
 *   events/subscribe   {filter, callback?}         -> {subscriptionId, cursor?, satisfied?}
 *   events/poll        {subscriptionId, cursor?}   -> {events:[{id,type,subject?,time?,data?}], cursor?}
 *   events/unsubscribe {subscriptionId}            -> {}
 *
 * Delivery is polled. A server may also push: POST to the `callback.url` given at subscribe time
 * (Events' /events/push/<source id>, authorized with `callback.token`) with {subscriptionId, events}.
 * Pushed events wait in memory and are returned by the next poll, together with polled ones.
 */
export class ExternalSource implements Source {
  types: readonly string[] = [];
  private readonly pushed = new Map<string, EventObject[]>();
  private lastError: string | null = null;
  readonly pushToken = randomUUID();

  constructor(
    private readonly cfg: ExternalConfig,
    private readonly secret: () => string | null,
    private readonly callbackBase: () => string | null = () => null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get id() {
    return this.cfg.id;
  }
  get name() {
    return this.cfg.name;
  }

  private async rpc<T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T> {
    const secret = this.secret();
    const res = await this.fetchImpl(this.cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret ? { [this.cfg.authHeader]: secret } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
      signal: AbortSignal.timeout(15_000) as any,
    });
    if (!res.ok) throw new Error(`${this.cfg.name} answered ${res.status} to ${method}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`${this.cfg.name}: ${body.error.message ?? "error"} (${method})`);
    return schema.parse(body.result ?? {});
  }

  /** Learn the event types the server offers. Failures show up in the source status. */
  async refreshTypes() {
    try {
      this.types = (await this.rpc("events/list", {}, listSchema)).events.map((e) => e.name);
      this.lastError = null;
    } catch (err) {
      this.lastError = (err as Error).message;
    }
  }

  async parseFilter(raw: unknown) {
    if (!raw || typeof raw !== "object") throw new UsageError("filter must be an object");
    return raw as Record<string, any>;
  }

  async init(filter: Record<string, any>) {
    const base = this.callbackBase();
    const r = await this.rpc("events/subscribe", { filter, ...(base ? { callback: { url: `${base}/events/push/${this.cfg.id}`, token: this.pushToken } } : {}) }, subscribeSchema);
    return { baseline: { remoteId: r.subscriptionId, cursor: r.cursor ?? null }, satisfied: r.satisfied };
  }

  /** Called by the push endpoint. */
  push(subscriptionId: string, events: unknown): number {
    const parsed = z.array(eventSchema).safeParse(events);
    if (!parsed.success) return 0;
    const list = this.pushed.get(subscriptionId) ?? [];
    list.push(...parsed.data.map((e) => this.toEvent(e)));
    this.pushed.set(subscriptionId, list.slice(-200));
    return parsed.data.length;
  }

  hasRemote(subscriptionId: string) {
    return this.pushed.has(subscriptionId);
  }

  private toEvent(e: z.infer<typeof eventSchema>): EventObject {
    return { id: `${this.cfg.id}:${e.id}`, source: this.cfg.id, type: e.type, subject: e.subject, time: e.time ?? new Date().toISOString(), data: e.data };
  }

  async poll(_filter: Record<string, any>, raw: unknown): Promise<PollResult> {
    const b = raw as { remoteId: string; cursor: unknown };
    const out = this.pushed.get(b.remoteId) ?? [];
    this.pushed.delete(b.remoteId);
    let cursor = b.cursor;
    try {
      const r = await this.rpc("events/poll", { subscriptionId: b.remoteId, cursor: b.cursor }, pollSchema);
      out.push(...r.events.map((e) => this.toEvent(e)));
      cursor = r.cursor ?? cursor;
      this.lastError = null;
    } catch (err) {
      // A push-only server may not implement events/poll; surface other failures in the status.
      this.lastError = (err as Error).message;
      if (!out.length) throw err;
    }
    return { events: out, baseline: { remoteId: b.remoteId, cursor } };
  }

  async close(_filter: Record<string, any>, raw: unknown) {
    const b = raw as { remoteId?: string };
    if (!b?.remoteId) return;
    this.pushed.delete(b.remoteId);
    await this.rpc("events/unsubscribe", { subscriptionId: b.remoteId }, z.any()).catch(() => {});
  }

  describe(e: EventObject): string {
    return `${this.cfg.name} event ${e.type}${e.subject ? ` on ${e.subject}` : ""}:\n${quote(JSON.stringify(e.data))}`;
  }

  label(filter: Record<string, any>) {
    return `${this.cfg.name} ${JSON.stringify(filter).slice(0, 80)}`;
  }

  status(): SourceView {
    if (!this.secret() && this.cfg.authHeader) return { id: this.id, name: this.name, state: "not_configured", detail: "No secret set." };
    if (this.lastError) return { id: this.id, name: this.name, state: "error", detail: this.lastError };
    return { id: this.id, name: this.name, state: "connected", detail: this.cfg.url };
  }
}
