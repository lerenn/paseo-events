import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { eventsSettings } from "../shared/events";
import { GitHubClient } from "./github";
import { SubscriptionManager } from "./manager";
import { GitHubSource } from "./sources/github";
import { TokenStore } from "./tokens";

function setup(pr: () => any, extra: Record<string, () => any> = {}, codexLogins?: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "events-"));
  const tokens = new TokenStore(path.join(dir, "tokens.json"));
  tokens.set("lerenn", "tok");
  const routes: Record<string, () => any> = {
    "/repos/lerenn/x/pulls/1": pr,
    "/repos/lerenn/x/commits/aaa/check-runs?per_page=100": () => ({ check_runs: [] }),
    "/repos/lerenn/x/commits/aaa/status": () => ({ statuses: [] }),
    ...extra,
  };
  const fetchImpl = (async (url: string) => {
    const p = url.replace("https://api.github.com", "");
    const body = routes[p]?.();
    if (body === undefined) return new Response(JSON.stringify({ message: `no route ${p}` }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "x-ratelimit-remaining": "4000" } });
  }) as unknown as typeof fetch;
  const github = new GitHubClient(tokens, fetchImpl);
  const source = new GitHubSource(github, tokens, 0, codexLogins ? () => codexLogins : undefined);
  const send = vi.fn(async () => {});
  const manager = new SubscriptionManager({ sources: () => [source], settings: async () => eventsSettings.schema.parse({}), send, file: path.join(dir, "subs.json") });
  return { manager, send, routes };
}

const open = (over: any = {}) => ({ state: "open", merged: false, head: { sha: "aaa" }, ...over });

describe("github subscriptions", () => {
  it("answers immediately when already merged", async () => {
    const { manager } = setup(() => open({ state: "closed", merged_at: "x" }));
    const r = await manager.subscribe({ agentId: "a1" }, { source: "github", filter: { repo: "lerenn/x", number: 1, types: ["pr_merged"] } });
    expect(r).toEqual({ satisfied: "lerenn/x#1 is already merged." });
  });

  it("wakes the agent once when the PR is merged, then ends", async () => {
    let pr = open();
    const { manager, send } = setup(() => pr);
    const r = await manager.subscribe({ agentId: "a1" }, { source: "github", filter: { repo: "lerenn/x", number: 1, types: ["pr_merged", "pr_closed"] } });
    expect("subscription" in r).toBe(true);
    await (manager as any).check((r as any).subscription.id);
    expect(send).not.toHaveBeenCalled();
    pr = open({ state: "closed", merged_at: "x", merged_by: { login: "louis" } });
    await (manager as any).check((r as any).subscription.id);
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as any)[1]).toContain("merged by louis");
    expect(manager.list()[0].status).toBe("fired");
    expect(manager.recentDeliveries()[0].ok).toBe(true);
  });

  it("fires checks_completed when pending checks finish, and ignores authors", async () => {
    let runs: any[] = [{ name: "ci", status: "in_progress", conclusion: null }];
    let comments: any[] = [];
    const { manager, send } = setup(() => open(), {
      "/repos/lerenn/x/commits/aaa/check-runs?per_page=100": () => ({ check_runs: runs }),
      "/repos/lerenn/x/issues/1/comments?per_page=100": () => comments,
      "/repos/lerenn/x/pulls/1/comments?per_page=100": () => [],
    });
    const r: any = await manager.subscribe({ agentId: "a1" }, { source: "github", filter: { repo: "lerenn/x", number: 1, types: ["checks_completed", "comment_created"], ignore_authors: ["me"] } });
    comments = [{ id: 5, user: { login: "me" }, body: "mine" }];
    await (manager as any).check(r.subscription.id);
    expect(send).not.toHaveBeenCalled();
    runs = [{ name: "ci", status: "completed", conclusion: "success" }];
    await (manager as any).check(r.subscription.id);
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as any)[1]).toContain("all passed");
  });

  it("drops subscriptions of an archived agent and refuses factory without Factory", async () => {
    const { manager } = setup(() => open());
    const r: any = await manager.subscribe({ agentId: "a1" }, { source: "github", filter: { repo: "lerenn/x", number: 1, types: ["pr_merged"] } });
    manager.dropAgent("a1");
    expect(manager.list()[0]).toMatchObject({ id: r.subscription.id, status: "cancelled", outcome: "agent archived" });
    await expect(
      manager.subscribe({ agentId: "a1" }, { source: "github", filter: { repo: "lerenn/x", number: 1, types: ["pr_merged"] }, deliver: { kind: "factory", blueprint: "b", vars_map: {} } }),
    ).rejects.toThrow(/Factory is not installed/);
  });

  it("persistent mode dedupes and batches", async () => {
    let comments: any[] = [];
    const { manager, send } = setup(() => open(), {
      "/repos/lerenn/x/issues/1/comments?per_page=100": () => comments,
      "/repos/lerenn/x/pulls/1/comments?per_page=100": () => [],
    });
    (manager as any).d.settings = async () => eventsSettings.schema.parse({ batchSeconds: 0 });
    const r: any = await manager.subscribe({ agentId: "a1" }, { source: "github", filter: { repo: "lerenn/x", number: 1, types: ["comment_created"] }, mode: "persistent" });
    comments = [{ id: 1, user: { login: "u" }, body: "a" }];
    await (manager as any).check(r.subscription.id);
    await (manager as any).check(r.subscription.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(send).toHaveBeenCalledTimes(1);
    expect(manager.list()[0].status).toBe("active");
  });
});

describe("github review filters", () => {
  const routesFor = (state: { reviews: any[]; comments: any[]; reviewComments?: any[] }) => ({
    "/repos/lerenn/x/pulls/1/reviews?per_page=100": () => state.reviews,
    "/repos/lerenn/x/issues/1/comments?per_page=100": () => state.comments,
    "/repos/lerenn/x/pulls/1/comments?per_page=100": () => state.reviewComments ?? [],
  });
  const body = (i: number) => (send.mock?.calls ?? [])[i];
  let send: any;
  const subscribe = (manager: SubscriptionManager, filter: any, mode?: "once" | "persistent") =>
    manager.subscribe({ agentId: "a1" }, { source: "github", filter: { repo: "lerenn/x", number: 1, ...filter }, mode }) as Promise<any>;

  it("authors keeps only reviews and comments by those logins", async () => {
    const state = { reviews: [] as any[], comments: [] as any[] };
    const m = setup(() => open(), routesFor(state));
    send = m.send;
    const r = await subscribe(m.manager, { types: ["review_submitted", "comment_created"], authors: ["Codecov-Bot", "sjourdan"] });
    state.comments = [{ id: 1, user: { login: "linear[bot]" }, body: "linked" }];
    state.reviews = [{ id: 2, user: { login: "someone" }, state: "COMMENTED", body: "x" }];
    await (m.manager as any).check(r.subscription.id);
    expect(send).not.toHaveBeenCalled();
    state.reviews.push({ id: 3, user: { login: "sjourdan" }, state: "APPROVED", body: "lgtm", commit_id: "aaa" });
    await (m.manager as any).check(r.subscription.id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(body(0)[1]).toContain("Review on lerenn/x#1 by sjourdan: APPROVED");
    expect(body(0)[1]).not.toContain("someone");
  });

  it("head_sha limits review_submitted to reviews of that commit", async () => {
    const state = { reviews: [] as any[], comments: [] as any[] };
    const m = setup(() => open(), routesFor(state));
    send = m.send;
    const r = await subscribe(m.manager, { types: ["review_submitted"], head_sha: "bbb" });
    state.reviews = [{ id: 1, user: { login: "u" }, state: "COMMENTED", body: "old head", commit_id: "aaa" }];
    await (m.manager as any).check(r.subscription.id);
    expect(send).not.toHaveBeenCalled();
    state.reviews.push({ id: 2, user: { login: "u" }, state: "COMMENTED", body: "new head", commit_id: "bbb" });
    await (m.manager as any).check(r.subscription.id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(body(0)[1]).toContain("new head");
  });

  it("comment_created ignores edits by default and reports them with include_edits", async () => {
    const state = { reviews: [] as any[], comments: [{ id: 1, user: { login: "u" }, body: "v1", created_at: "t0", updated_at: "t0" }] };
    const m = setup(() => open(), routesFor(state));
    send = m.send;
    (m.manager as any).d.settings = async () => eventsSettings.schema.parse({ batchSeconds: 0 });
    const plain = await subscribe(m.manager, { types: ["comment_created"] });
    const edits = await subscribe(m.manager, { types: ["comment_created"], include_edits: true }, "persistent");
    state.comments = [{ id: 1, user: { login: "u" }, body: "v2", created_at: "t0", updated_at: "t1" }];
    await (m.manager as any).check(plain.subscription.id);
    expect(send).not.toHaveBeenCalled();
    await (m.manager as any).check(edits.subscription.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(send).toHaveBeenCalledTimes(1);
    expect(body(0)[1]).toContain("Comment edited on lerenn/x#1 by u");
    expect(body(0)[1]).toContain("v2");
    // The same version is not reported twice; a further edit is.
    await (m.manager as any).check(edits.subscription.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(send).toHaveBeenCalledTimes(1);
    state.comments = [{ id: 1, user: { login: "u" }, body: "v3", created_at: "t0", updated_at: "t2" }];
    await (m.manager as any).check(edits.subscription.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(send).toHaveBeenCalledTimes(2);
    expect(body(1)[1]).toContain("v3");
  });

  const CODEX = "chatgpt-codex-connector[bot]";
  const summary = (sha: string, status: string, unresolved: boolean, updated: string) => ({
    id: 10,
    user: { login: CODEX },
    created_at: "t0",
    updated_at: updated,
    html_url: "https://github.com/lerenn/x/pull/1#issuecomment-10",
    body: `## Codex Review Summary\n<!-- codex-review-state:v1 {"commit_sha":"${sha}","status":"${status}","has_unresolved_findings":${unresolved}} -->`,
  });

  it("codex_review fires on an edit of the Codex summary comment, with its state", async () => {
    const state = { reviews: [] as any[], comments: [summary("aaa", "in_progress", false, "t0"), { id: 11, user: { login: "u" }, body: "@codex review" }] };
    const m = setup(() => open(), routesFor(state));
    send = m.send;
    const r = await subscribe(m.manager, { types: ["codex_review"] });
    await (m.manager as any).check(r.subscription.id);
    expect(send).not.toHaveBeenCalled();
    state.comments = [summary("aaa", "done", false, "t1"), { id: 11, user: { login: "u" }, body: "@codex review" }, { id: 12, user: { login: "u" }, body: "thanks" }];
    await (m.manager as any).check(r.subscription.id);
    expect(send).toHaveBeenCalledTimes(1);
    const text = body(0)[1];
    expect(text).toContain(`Codex summary comment edited on lerenn/x#1 by ${CODEX} (commit aaa), status done, no unresolved findings`);
    expect(text).not.toContain("thanks");
  });

  it("codex_review with head_sha waits for that commit, and sees Codex reviews", async () => {
    const state = { reviews: [] as any[], comments: [summary("aaa", "done", true, "t0")] };
    const m = setup(() => open({ head: { sha: "bbb" } }), {
      ...routesFor(state),
    });
    send = m.send;
    const r = await subscribe(m.manager, { types: ["codex_review"], head_sha: "bbb" });
    state.reviews = [{ id: 5, user: { login: CODEX }, state: "COMMENTED", body: "old", commit_id: "aaa" }];
    state.comments = [summary("aaa", "done", true, "t1")];
    await (m.manager as any).check(r.subscription.id);
    expect(send).not.toHaveBeenCalled();
    state.reviews.push({ id: 6, user: { login: CODEX }, state: "COMMENTED", body: "P2: fix this", commit_id: "bbb" });
    await (m.manager as any).check(r.subscription.id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(body(0)[1]).toContain("Codex review (COMMENTED) on lerenn/x#1");
    expect(body(0)[1]).toContain("(commit bbb)");
  });

  it("codex_review follows the codexLogins setting", async () => {
    const state = { reviews: [] as any[], comments: [] as any[] };
    const m = setup(() => open(), routesFor(state), ["my-codex[bot]"]);
    send = m.send;
    const r = await subscribe(m.manager, { types: ["codex_review"] });
    state.comments = [{ id: 1, user: { login: CODEX }, body: "default bot" }];
    await (m.manager as any).check(r.subscription.id);
    expect(send).not.toHaveBeenCalled();
    state.comments.push({ id: 2, user: { login: "My-Codex[bot]" }, body: "custom bot", created_at: "t0", updated_at: "t0" });
    await (m.manager as any).check(r.subscription.id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(body(0)[1]).toContain("custom bot");
  });

  it("settings default codexLogins to the Codex connector", () => {
    expect(eventsSettings.schema.parse({}).codexLogins).toEqual([CODEX]);
  });
});

describe("factory delivery", () => {
  it("starts the blueprint with mapped vars and the event id as idempotency key", async () => {
    const start = vi.fn(async () => "run1");
    const { manager, routes } = setup(() => open({ state: "closed", merged_at: null }));
    (manager as any).d.factory = { available: async () => true, start };
    routes["/repos/lerenn/x/pulls/1"] = () => open();
    const r: any = await manager.subscribe(
      { agentId: "a1" },
      { source: "github", filter: { repo: "lerenn/x", number: 1, types: ["pr_closed"] }, deliver: { kind: "factory", blueprint: "bp", vars_map: { pr: "subject", state: "data.sha" } } },
    );
    routes["/repos/lerenn/x/pulls/1"] = () => open({ state: "closed" });
    await (manager as any).check(r.subscription.id);
    expect(start).toHaveBeenCalledWith("bp", { pr: "lerenn/x#1", state: undefined }, expect.stringContaining(r.subscription.id));
    expect(manager.recentDeliveries()[0]).toMatchObject({ ok: true, target: "factory:bp", detail: "run1" });
  });
});

describe("mail delivery", () => {
  const sub = (manager: SubscriptionManager, deliver?: any) =>
    manager.subscribe({ agentId: "a1" }, { source: "github", filter: { repo: "lerenn/x", number: 1, types: ["pr_merged"] }, deliver }) as Promise<any>;

  it("sends one mail instead of a prompt, with the same body", async () => {
    let pr = open();
    const { manager, send } = setup(() => pr);
    const mail = { available: vi.fn(async () => true), send: vi.fn(async () => {}) };
    (manager as any).d.mail = mail;
    const r = await sub(manager, { kind: "mail" });
    pr = open({ state: "closed", merged_at: "x", merged_by: { login: "louis" } });
    await (manager as any).check(r.subscription.id);
    expect(send).not.toHaveBeenCalled();
    expect(mail.send).toHaveBeenCalledTimes(1);
    const [to, subject, body] = mail.send.mock.calls[0] as any;
    expect(to).toBe("a1");
    expect(subject).toBe("Event: github pr_merged lerenn/x#1");
    expect(body).toContain("merged by louis");
    expect(manager.recentDeliveries()[0]).toMatchObject({ ok: true, target: "mail:a1" });
  });

  it("turns kind agent (asked or default) into a mail to the caller when Agents Mail is installed", async () => {
    const { manager } = setup(() => open());
    (manager as any).d.mail = { available: async () => true, send: vi.fn(async () => {}) };
    expect((await sub(manager, { kind: "agent" })).subscription.deliver).toEqual({ kind: "mail" });
    expect((await sub(manager)).subscription.deliver).toEqual({ kind: "mail" });
    (manager as any).d.mail = { available: async () => false, send: vi.fn() };
    expect((await sub(manager, { kind: "agent" })).subscription.deliver).toEqual({ kind: "agent" });
  });

  it("mails the given address, and mails the expiry notice", async () => {
    const { manager, send } = setup(() => open());
    const mail = { available: async () => true, send: vi.fn(async () => {}) };
    (manager as any).d.mail = mail;
    const r = await sub(manager, { kind: "mail", to: "@assistant" });
    await (manager as any).expire((manager as any).subs.find((x: any) => x.id === r.subscription.id));
    expect(send).not.toHaveBeenCalled();
    const [to, subject, body] = mail.send.mock.calls[0] as any;
    expect(to).toBe("@assistant");
    expect(subject).toMatch(/^Event: github expired /);
    expect(body).toContain("expired");
  });

  it("falls back to the direct prompt when Agents Mail is unavailable or fails", async () => {
    for (const mail of [undefined, { available: async () => false, send: vi.fn() }, { available: async () => true, send: vi.fn(async () => { throw new Error("boom"); }) }]) {
      let pr = open();
      const { manager, send } = setup(() => pr);
      (manager as any).d.mail = mail;
      const r = await sub(manager, { kind: "mail" });
      pr = open({ state: "closed", merged_at: "x" });
      await (manager as any).check(r.subscription.id);
      expect(send).toHaveBeenCalledTimes(1);
      expect((send.mock.calls[0] as any)[0]).toBe("a1");
      expect(manager.recentDeliveries().map((d) => d.ok)).toEqual([true, false]);
    }
  });

  it("persistent mode sends one mail per batch", async () => {
    let comments: any[] = [];
    const { manager, send } = setup(() => open(), {
      "/repos/lerenn/x/issues/1/comments?per_page=100": () => comments,
      "/repos/lerenn/x/pulls/1/comments?per_page=100": () => [],
    });
    const mail = { available: async () => true, send: vi.fn(async () => {}) };
    (manager as any).d.mail = mail;
    (manager as any).d.settings = async () => eventsSettings.schema.parse({ batchSeconds: 0 });
    const r: any = await manager.subscribe({ agentId: "a1" }, { source: "github", filter: { repo: "lerenn/x", number: 1, types: ["comment_created"] }, deliver: { kind: "mail" }, mode: "persistent" });
    comments = [{ id: 1, user: { login: "u" }, body: "a" }, { id: 2, user: { login: "u" }, body: "b" }];
    await (manager as any).check(r.subscription.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("defaultDeliver applies when the subscription names no delivery; default stays agent", async () => {
    expect(eventsSettings.schema.parse({}).defaultDeliver).toBe("agent");
    const { manager } = setup(() => open());
    expect((await sub(manager)).subscription.deliver).toEqual({ kind: "agent" });
    (manager as any).d.settings = async () => eventsSettings.schema.parse({ defaultDeliver: "mail" });
    expect((await sub(manager)).subscription.deliver).toEqual({ kind: "mail" });
    expect((await sub(manager, { kind: "agent" })).subscription.deliver).toEqual({ kind: "agent" });
  });
});
