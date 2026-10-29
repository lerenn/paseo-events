import { readFileSync } from "node:fs";
import { z } from "zod";
import type { EventObject, SourceView } from "../../shared/events";
import { fetchJson } from "./http";
import { quote, UsageError, type PollResult, type Source } from "./types";

export const SLACK_TYPES = ["message_created"] as const;

export const slackFilterSchema = z.object({
  types: z.array(z.enum(SLACK_TYPES)).default(["message_created"]),
  channel: z.string().regex(/^[CG][A-Z0-9]{6,}$/).describe("Channel id, for example C098F6E0AD6. The bot must be a member."),
  bot_id: z.string().optional().describe("Only messages posted by this bot (bot_id, for example B0BQV2NRCEL)."),
  user: z.string().optional().describe("Only messages posted by this user id."),
});

const AIKIDO_GROUP = /aikido\.dev\/[^\s"'<>|]*?(?:issue[-_]?groups?|issues?|groups?)[/=](\d+)/i;
const URL_RE = /https?:\/\/[^\s"'<>|]+/g;

/** The text of a Slack message for people and agents: its text, the text of its blocks and attachments, and the URLs of its buttons. */
export function messageText(m: any): { text: string; links: string[] } {
  const parts: string[] = [];
  const links = new Set<string>();
  const walk = (v: any) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v.url === "string") links.add(v.url);
    if (v.type === "plain_text" || v.type === "mrkdwn") {
      if (typeof v.text === "string") parts.push(v.text);
      return;
    }
    for (const [k, x] of Object.entries(v)) if (k !== "url") walk(x);
  };
  if (typeof m.text === "string" && m.text) parts.push(m.text);
  walk(m.blocks);
  walk(m.attachments);
  for (const p of parts) for (const u of p.match(URL_RE) ?? []) links.add(u.replace(/[>)]+$/, ""));
  return { text: [...new Set(parts)].join("\n"), links: [...links] };
}

/** The Aikido issue group a message is about, from its links; null when it names none. */
export function aikidoGroup(links: readonly string[]): string | null {
  for (const l of links) {
    const m = AIKIDO_GROUP.exec(l);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * New messages in one Slack channel, read with the Web API (conversations.history) using a bot token read from a file
 * (a Kubernetes Secret mounted by the host; never stored by this plugin). An Aikido alert's issue group becomes the
 * event's identity (`aikido:<group>`), so several alerts about one group are one event and one Factory run.
 */
export class SlackSource implements Source {
  id = "slack";
  name = "Slack";
  types = SLACK_TYPES;
  private lastError: string | null = null;

  constructor(private readonly tokenFile: () => string, private readonly fetchImpl: typeof fetch = fetch, private readonly api = "https://slack.com/api") {}

  private token(): string | null {
    try {
      return readFileSync(this.tokenFile(), "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  private async call(method: string, params: Record<string, string>): Promise<any> {
    const token = this.token();
    if (!token) throw new UsageError(`No Slack bot token in ${this.tokenFile()} (a mounted Kubernetes Secret).`);
    try {
      const r = await fetchJson(this.fetchImpl, `${this.api}/${method}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` } }, token);
      if (!r?.ok) throw new Error(`Slack ${method}: ${r?.error ?? "no answer"}${r?.needed ? ` (needs ${r.needed})` : ""}`);
      this.lastError = null;
      return r;
    } catch (err) {
      this.lastError = (err as Error).message;
      throw err;
    }
  }

  async parseFilter(raw: unknown) {
    const p = slackFilterSchema.safeParse(raw);
    if (!p.success) throw new UsageError(`Invalid slack filter: ${z.prettifyError(p.error)}`);
    return p.data;
  }

  async init(filter: Record<string, any>) {
    const r = await this.call("conversations.history", { channel: filter.channel, limit: "1" });
    const latest = r.messages?.[0]?.ts ?? String(Date.now() / 1000);
    return { baseline: { oldest: latest } };
  }

  async poll(filter: Record<string, any>, raw: unknown): Promise<PollResult> {
    const b = raw as { oldest: string };
    const r = await this.call("conversations.history", { channel: filter.channel, oldest: b.oldest, limit: "50", inclusive: "false" });
    const all = ((r.messages ?? []) as any[]).sort((x, y) => Number(x.ts) - Number(y.ts));
    let oldest = b.oldest;
    for (const m of all) if (Number(m.ts) > Number(oldest)) oldest = m.ts;
    const events: EventObject[] = [];
    for (const m of all.filter((x) => !x.thread_ts || x.thread_ts === x.ts)) {
      if (filter.bot_id && m.bot_id !== filter.bot_id) continue;
      if (filter.user && m.user !== filter.user) continue;
      const { text, links } = messageText(m);
      const group = aikidoGroup(links);
      const permalink = await this.call("chat.getPermalink", { channel: filter.channel, message_ts: m.ts }).then((p) => p.permalink as string, () => `https://slack.com/archives/${filter.channel}/p${m.ts.replace(".", "")}`);
      const incident = group ? `aikido:${group}` : `slack:${filter.channel}:${m.ts}`;
      events.push({
        id: incident,
        source: "slack",
        type: "message_created",
        subject: permalink,
        time: new Date(Number(m.ts) * 1000).toISOString(),
        data: { channel: filter.channel, ts: m.ts, thread_ts: m.ts, text, links, bot_id: m.bot_id ?? null, user: m.user ?? null, permalink, aikido_group: group, incident_id: incident },
      });
    }
    return { events, baseline: { oldest } };
  }

  describe(e: EventObject): string {
    return `New Slack message in ${e.data.channel}: ${e.data.permalink}\n${quote(e.data.text)}`;
  }

  label(filter: Record<string, any>) {
    return `slack ${filter.channel}${filter.bot_id ? ` from ${filter.bot_id}` : ""}`;
  }

  status(): SourceView {
    if (!this.token()) return { id: this.id, name: this.name, state: "not_configured", detail: `No bot token in ${this.tokenFile()}.` };
    if (this.lastError) return { id: this.id, name: this.name, state: "error", detail: this.lastError };
    return { id: this.id, name: this.name, state: "connected", detail: "Web API, bot token from a mounted Secret" };
  }
}
