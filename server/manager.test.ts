import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { eventsSettings } from "../shared/events";
import { GitHubClient } from "./github";
import { SubscriptionManager } from "./manager";
import { GitHubSource } from "./sources/github";
import { TokenStore } from "./tokens";

function setup(pr: () => any, extra: Record<string, () => any> = {}) {
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
  const source = new GitHubSource(github, tokens, 0);
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
