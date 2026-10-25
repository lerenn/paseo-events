import { z } from "zod";
import type { EventObject, SourceView } from "../../shared/events";
import type { TokenStore } from "../tokens";
import { fetchJson } from "./http";
import { quote, UsageError, type PollResult, type Source } from "./types";

export const LINEAR_TYPES = ["issue_created", "state_changed"] as const;

export const linearFilterSchema = z.object({
  types: z.array(z.enum(LINEAR_TYPES)).min(1),
  team: z.string().optional().describe("Team key, for example ANY. Default: all teams."),
  issue: z.string().optional().describe("Issue identifier, for example ANY-123. Default: any issue of the team."),
  states: z.array(z.string()).optional().describe("state_changed: only moves into these state names."),
});

const QUERY = `query($filter: IssueFilter, $first: Int) {
  issues(filter: $filter, first: $first, orderBy: updatedAt) {
    nodes { id identifier title url createdAt updatedAt team { key } state { name } creator { name } history(first: 10) { nodes { id createdAt fromState { name } toState { name } actor { name } } } }
  }
}`;

interface Baseline {
  since: string;
}

export class LinearSource implements Source {
  id = "linear";
  name = "Linear";
  types = LINEAR_TYPES;
  private lastError: string | null = null;

  constructor(private readonly secrets: TokenStore, private readonly fetchImpl: typeof fetch = fetch, private readonly url = "https://api.linear.app/graphql") {}

  private async gql(query: string, variables: unknown, key = this.secrets.get("linear")): Promise<any> {
    if (!key) throw new UsageError("No Linear API key. Add one in the Events screen.");
    try {
      const r = await fetchJson(this.fetchImpl, this.url, { method: "POST", headers: { authorization: key }, body: { query, variables } }, key);
      if (r.errors?.length) throw new Error(`Linear: ${r.errors.map((e: any) => e.message).join("; ")}`);
      this.lastError = null;
      return r.data;
    } catch (err) {
      this.lastError = (err as Error).message;
      throw err;
    }
  }

  async validate(secret: string) {
    await this.gql("{ viewer { id } }", {}, secret);
  }

  async parseFilter(raw: unknown) {
    const p = linearFilterSchema.safeParse(raw);
    if (!p.success) throw new UsageError(`Invalid linear filter: ${z.prettifyError(p.error)}`);
    return { types: [...new Set(p.data.types)], team: p.data.team, issue: p.data.issue, states: p.data.states ?? [] };
  }

  async init(): Promise<{ baseline: Baseline }> {
    await this.gql("{ viewer { id } }", {});
    return { baseline: { since: new Date().toISOString() } };
  }

  async poll(filter: Record<string, any>, raw: unknown): Promise<PollResult> {
    const b = raw as Baseline;
    const f: Record<string, any> = { updatedAt: { gt: b.since } };
    if (filter.team) f.team = { key: { eq: filter.team } };
    if (filter.issue) f.number = { eq: Number(String(filter.issue).split("-").pop()) };
    const data = await this.gql(QUERY, { filter: f, first: 50 });
    const events: EventObject[] = [];
    let since = b.since;
    for (const i of data.issues.nodes as any[]) {
      if (filter.issue && i.identifier.toLowerCase() !== String(filter.issue).toLowerCase()) continue;
      if (i.updatedAt > since) since = i.updatedAt;
      const base = { subject: i.identifier, time: i.updatedAt };
      if ((filter.types as string[]).includes("issue_created") && i.createdAt > b.since) {
        events.push({ id: `linear:${i.id}:created`, source: "linear", type: "issue_created", ...base, data: { identifier: i.identifier, title: i.title, url: i.url, team: i.team?.key, state: i.state?.name, creator: i.creator?.name ?? null } });
      }
      if ((filter.types as string[]).includes("state_changed")) {
        for (const h of i.history.nodes as any[]) {
          if (h.createdAt <= b.since || !h.fromState || !h.toState) continue;
          if (filter.states.length && !filter.states.includes(h.toState.name)) continue;
          events.push({ id: `linear:${i.id}:${h.id}`, source: "linear", type: "state_changed", ...base, time: h.createdAt, data: { identifier: i.identifier, title: i.title, url: i.url, from: h.fromState.name, to: h.toState.name, actor: h.actor?.name ?? null } });
        }
      }
    }
    return { events, baseline: { since } };
  }

  describe(e: EventObject): string {
    const d = e.data;
    return e.type === "issue_created"
      ? `New Linear issue ${d.identifier} (${d.team}) ${d.url}\n${quote(String(d.title))}`
      : `Linear issue ${d.identifier} moved ${d.from} → ${d.to}${d.actor ? ` by ${d.actor}` : ""} ${d.url}\n${quote(String(d.title))}`;
  }

  label(filter: Record<string, any>) {
    return `linear ${filter.issue ?? filter.team ?? "all teams"}`;
  }

  status(): SourceView {
    if (!this.secrets.get("linear")) return { id: this.id, name: this.name, state: "not_configured", detail: "No API key yet." };
    if (this.lastError) return { id: this.id, name: this.name, state: "error", detail: this.lastError };
    return { id: this.id, name: this.name, state: "connected", detail: null };
  }
}
