import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { eventsSettings } from "../shared/events";
import { SubscriptionManager } from "./manager";
import { aikidoGroup, messageText, SlackSource } from "./sources/slack";

const dir = mkdtempSync(path.join(tmpdir(), "slack-"));
const tokenFile = path.join(dir, "token");
writeFileSync(tokenFile, "xoxb-test\n");

const alert = {
  ts: "1793254097.509929",
  bot_id: "B0BQV2NRCEL",
  text: "",
  blocks: [
    { type: "section", text: { type: "mrkdwn", text: ":warning: A new *high* severity *open-source issue* was detected in *@modelcontextprotocol/node* that affects *graph-api*." } },
    { type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "More info" }, url: "https://app.aikido.dev/queue?groupId=1" },
      { type: "button", text: { type: "plain_text", text: "Open In Aikido" }, url: "https://app.aikido.dev/issues/12345/detail?sidebarIssue=9" },
    ] },
  ],
};

function fakeSlack(messages: any[], calls: string[] = []) {
  return (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push(url);
    expect(init.headers.authorization).toBe("Bearer xoxb-test");
    const u = new URL(url);
    const method = u.pathname.split("/").pop();
    let body: any = { ok: true };
    if (method === "conversations.history") {
      const oldest = Number(u.searchParams.get("oldest") ?? 0);
      body = { ok: true, messages: messages.filter((m) => Number(m.ts) > oldest).reverse().slice(0, Number(u.searchParams.get("limit"))) };
    }
    if (method === "chat.getPermalink") body = { ok: true, permalink: `https://anyshift.slack.com/archives/C098F6E0AD6/p${u.searchParams.get("message_ts")!.replace(".", "")}` };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("slack source", () => {
  it("reads the message text, its block text and button links, and the Aikido issue group", () => {
    const { text, links } = messageText(alert);
    expect(text).toContain("@modelcontextprotocol/node");
    expect(text).toContain("Open In Aikido");
    expect(links).toContain("https://app.aikido.dev/issues/12345/detail?sidebarIssue=9");
    expect(aikidoGroup(links)).toBe("12345");
    expect(aikidoGroup(["https://example.com/x"])).toBeNull();
  });

  it("emits new top-level messages of the bot, with the group as identity and the permalink, and moves its baseline", async () => {
    const old = { ts: "1793254000.000001", bot_id: "B0BQV2NRCEL", text: "old" };
    const messages: any[] = [old];
    const src = new SlackSource(() => tokenFile, fakeSlack(messages));
    const filter = await src.parseFilter({ channel: "C098F6E0AD6", bot_id: "B0BQV2NRCEL" });
    const { baseline } = await src.init(filter);
    messages.push({ ts: "1793254050.000001", user: "U1", text: "a person" }, alert, { ts: "1793254099.000001", bot_id: "B0BQV2NRCEL", text: "reply", thread_ts: alert.ts });
    const r = await src.poll(filter, baseline);
    expect(r.events.map((e) => e.id)).toEqual(["aikido:12345"]);
    expect(r.events[0]!.data).toMatchObject({ channel: "C098F6E0AD6", thread_ts: alert.ts, incident_id: "aikido:12345", permalink: "https://anyshift.slack.com/archives/C098F6E0AD6/p1793254097509929" });
    expect((r.baseline as { oldest: string }).oldest).toBe("1793254099.000001");
    expect(src.describe(r.events[0]!)).toContain("> ");
  });

  it("is not configured without a token file, and says so", async () => {
    const src = new SlackSource(() => path.join(dir, "missing"));
    expect(src.status().state).toBe("not_configured");
    await expect(src.init({ channel: "C098F6E0AD6" })).rejects.toThrow(/No Slack bot token/);
  });
});

describe("standing subscriptions", () => {
  it("are created from settings, never expire, deliver to the Factory, survive agent archival, and follow definition changes", async () => {
    const messages: any[] = [{ ts: "1.0", text: "x", bot_id: "B0BQV2NRCEL" }];
    const slack = new SlackSource(() => tokenFile, fakeSlack(messages));
    const started: { blueprint: string; vars: Record<string, unknown>; key: string }[] = [];
    const factory = { available: async () => true, start: async (blueprint: string, vars: Record<string, unknown>, key: string) => (started.push({ blueprint, vars, key }), "bp-1") };
    const settings = eventsSettings.schema.parse({ batchSeconds: 0 });
    const m = new SubscriptionManager({ sources: () => [slack], settings: async () => settings, send: async () => undefined, factory, file: path.join(dir, "subs.json"), tickMs: 1_000_000 });
    const def = { id: "security-alerts", source: "slack", filter: { channel: "C098F6E0AD6", bot_id: "B0BQV2NRCEL" }, deliver: { kind: "factory", blueprint: "incident", vars_map: { incident_id: "data.incident_id", alert_url: "data.permalink", alert_text: "data.text", slack_channel: "data.channel", slack_thread_ts: "data.thread_ts" } } };
    expect(await m.ensureStanding([def])).toEqual([]);
    expect(await m.ensureStanding([def])).toEqual([]); // idempotent
    let active = m.list().filter((s) => s.status === "active");
    expect(active).toHaveLength(1);
    m.dropAgent("standing:security-alerts"); // an archive hook never matches a real agent, but even so:
    expect(await m.ensureStanding([def])).toEqual([]);
    active = m.list().filter((s) => s.status === "active");
    expect(active).toHaveLength(1);
    messages.push(alert);
    await (m as unknown as { check(id: string): Promise<void> }).check(active[0]!.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ blueprint: "incident", vars: { incident_id: "aikido:12345", slack_thread_ts: alert.ts, slack_channel: "C098F6E0AD6" } });
    expect(started[0]!.key).toContain("aikido:12345");
    expect(await m.ensureStanding([{ ...def, deliver: { kind: "agent" } }])).toEqual([expect.stringContaining("factory or mail")]);
    expect(await m.ensureStanding([])).toEqual([]);
    expect(m.list().filter((s) => s.status === "active")).toHaveLength(0);
    m.stop();
  });
});
