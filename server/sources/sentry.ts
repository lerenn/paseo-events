import { z } from "zod";
import type { EventObject, SourceView } from "../../shared/events";
import type { TokenStore } from "../tokens";
import { fetchJson } from "./http";
import { quote, UsageError, type PollResult, type Source } from "./types";

export const SENTRY_TYPES = ["issue_new"] as const;

export const sentryFilterSchema = z.object({
  types: z.array(z.enum(SENTRY_TYPES)).default(["issue_new"]),
  org: z.string().describe("Organization slug."),
  project: z.string().describe("Project slug."),
  level: z.array(z.string()).optional().describe("Only these levels, for example [\"error\",\"fatal\"]."),
  query: z.string().optional().describe("Sentry issue search query, for example \"is:unresolved environment:production\"."),
});

export class SentrySource implements Source {
  id = "sentry";
  name = "Sentry";
  types = SENTRY_TYPES;
  private lastError: string | null = null;

  constructor(private readonly secrets: TokenStore, private readonly baseUrl: () => string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async get(path: string, key = this.secrets.get("sentry")): Promise<any> {
    if (!key) throw new UsageError("No Sentry auth token. Add one in the Events screen.");
    try {
      const r = await fetchJson(this.fetchImpl, `${this.baseUrl().replace(/\/$/, "")}/api/0${path}`, { headers: { authorization: `Bearer ${key}` } }, key);
      this.lastError = null;
      return r;
    } catch (err) {
      this.lastError = (err as Error).message;
      throw err;
    }
  }

  async validate(secret: string) {
    await this.get("/organizations/", secret);
  }

  async parseFilter(raw: unknown) {
    const p = sentryFilterSchema.safeParse(raw);
    if (!p.success) throw new UsageError(`Invalid sentry filter: ${z.prettifyError(p.error)}`);
    return { ...p.data, level: p.data.level ?? [] };
  }

  async init(filter: Record<string, any>) {
    await this.get(`/projects/${filter.org}/${filter.project}/`);
    return { baseline: { since: new Date().toISOString(), seen: [] as string[] } };
  }

  async poll(filter: Record<string, any>, raw: unknown): Promise<PollResult> {
    const b = raw as { since: string; seen: string[] };
    const q = new URLSearchParams({ sort: "new", limit: "25", query: filter.query ?? "is:unresolved" });
    const issues = (await this.get(`/projects/${filter.org}/${filter.project}/issues/?${q}`)) as any[];
    const seen = new Set(b.seen);
    const events: EventObject[] = [];
    for (const i of issues) {
      if (i.firstSeen <= b.since || seen.has(i.id)) continue;
      if (filter.level.length && !filter.level.includes(i.level)) continue;
      events.push({ id: `sentry:${i.id}`, source: "sentry", type: "issue_new", subject: i.shortId ?? i.id, time: i.firstSeen, data: { id: i.id, shortId: i.shortId, title: i.title, level: i.level, culprit: i.culprit, url: i.permalink, count: i.count } });
    }
    return { events, baseline: { since: b.since, seen: [...b.seen, ...events.map((e) => e.data.id)].slice(-500) } };
  }

  describe(e: EventObject): string {
    const d = e.data;
    return `New Sentry issue ${d.shortId} (${d.level}) ${d.url}\n${quote(`${d.title}${d.culprit ? `\nin ${d.culprit}` : ""}`)}`;
  }

  label(filter: Record<string, any>) {
    return `sentry ${filter.org}/${filter.project}`;
  }

  status(): SourceView {
    if (!this.secrets.get("sentry")) return { id: this.id, name: this.name, state: "not_configured", detail: "No auth token yet." };
    if (this.lastError) return { id: this.id, name: this.name, state: "error", detail: this.lastError };
    return { id: this.id, name: this.name, state: "connected", detail: this.baseUrl() };
  }
}
