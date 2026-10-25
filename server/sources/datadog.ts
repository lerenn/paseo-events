import { z } from "zod";
import type { EventObject, SourceView } from "../../shared/events";
import type { TokenStore } from "../tokens";
import { fetchJson } from "./http";
import { quote, UsageError, type PollResult, type Source } from "./types";

export const DATADOG_TYPES = ["alert_triggered", "alert_resolved"] as const;

export const datadogFilterSchema = z.object({
  types: z.array(z.enum(DATADOG_TYPES)).min(1),
  monitor_tags: z.array(z.string()).optional().describe("Only monitors with all these tags, for example [\"service:api\"]."),
  monitor_id: z.number().int().optional(),
});

/**
 * Datadog monitors. The secret is stored as `<api key>:<application key>`. alert_triggered fires
 * when a monitor goes to Alert (or Warn), alert_resolved when it returns to OK.
 */
export class DatadogSource implements Source {
  id = "datadog";
  name = "Datadog";
  types = DATADOG_TYPES;
  private lastError: string | null = null;

  constructor(private readonly secrets: TokenStore, private readonly site: () => string, private readonly fetchImpl: typeof fetch = fetch) {}

  private keys(secret = this.secrets.get("datadog")): { api: string; app: string; raw: string } {
    if (!secret) throw new UsageError("No Datadog keys. Add \"<api key>:<application key>\" in the Events screen.");
    const [api, app] = secret.split(":");
    if (!api || !app) throw new UsageError("The Datadog secret must be \"<api key>:<application key>\".");
    return { api, app, raw: secret };
  }

  private async get(path: string, secret?: string): Promise<any> {
    const k = this.keys(secret);
    try {
      const r = await fetchJson(this.fetchImpl, `https://${this.site()}${path}`, { headers: { "DD-API-KEY": k.api, "DD-APPLICATION-KEY": k.app } }, k.api);
      this.lastError = null;
      return r;
    } catch (err) {
      this.lastError = (err as Error).message.split(k.app).join("***");
      throw err;
    }
  }

  async validate(secret: string) {
    await this.get("/api/v1/validate", secret);
  }

  async parseFilter(raw: unknown) {
    const p = datadogFilterSchema.safeParse(raw);
    if (!p.success) throw new UsageError(`Invalid datadog filter: ${z.prettifyError(p.error)}`);
    return { types: [...new Set(p.data.types)], monitor_tags: p.data.monitor_tags ?? [], monitor_id: p.data.monitor_id };
  }

  private async monitors(filter: Record<string, any>): Promise<any[]> {
    const q = new URLSearchParams({ page_size: "100", ...(filter.monitor_tags.length ? { monitor_tags: filter.monitor_tags.join(",") } : {}) });
    const list = (await this.get(`/api/v1/monitor?${q}`)) as any[];
    return filter.monitor_id ? list.filter((m) => m.id === filter.monitor_id) : list;
  }

  async init(filter: Record<string, any>) {
    const states: Record<string, string> = {};
    for (const m of await this.monitors(filter)) states[m.id] = m.overall_state;
    return { baseline: { states } };
  }

  async poll(filter: Record<string, any>, raw: unknown): Promise<PollResult> {
    const b = raw as { states: Record<string, string> };
    const states = { ...b.states };
    const events: EventObject[] = [];
    const bad = (s: string) => s === "Alert" || s === "Warn";
    for (const m of await this.monitors(filter)) {
      const prev = b.states[m.id];
      const now: string = m.overall_state;
      states[m.id] = now;
      if (prev === now) continue;
      const data = { id: m.id, name: m.name, state: now, previous: prev ?? "unknown", url: `https://${this.site().replace(/^api\./, "app.")}/monitors/${m.id}`, tags: m.tags ?? [], message: m.message ?? "" };
      const base = { source: "datadog", subject: String(m.id), time: m.overall_state_modified ?? new Date().toISOString(), data };
      if ((filter.types as string[]).includes("alert_triggered") && bad(now) && !bad(prev ?? "")) events.push({ ...base, id: `datadog:${m.id}:${now}:${m.overall_state_modified}`, type: "alert_triggered" });
      if ((filter.types as string[]).includes("alert_resolved") && now === "OK" && bad(prev ?? "")) events.push({ ...base, id: `datadog:${m.id}:OK:${m.overall_state_modified}`, type: "alert_resolved" });
    }
    return { events, baseline: { states } };
  }

  describe(e: EventObject): string {
    const d = e.data;
    return `Datadog monitor ${d.name} (#${d.id}) ${e.type === "alert_triggered" ? `is now ${d.state}` : "recovered (OK)"} ${d.url}${d.message ? `\n${quote(String(d.message))}` : ""}`;
  }

  label(filter: Record<string, any>) {
    return `datadog ${filter.monitor_id ?? filter.monitor_tags.join(",") ?? "all monitors"}`;
  }

  status(): SourceView {
    if (!this.secrets.get("datadog")) return { id: this.id, name: this.name, state: "not_configured", detail: "No keys yet." };
    if (this.lastError) return { id: this.id, name: this.name, state: "error", detail: this.lastError };
    return { id: this.id, name: this.name, state: "connected", detail: this.site() };
  }
}
