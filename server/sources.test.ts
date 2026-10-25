import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { eventsSettings } from "../shared/events";
import { matches, readJsonPath } from "./jsonpath";
import { SubscriptionManager } from "./manager";
import { ExternalSource } from "./sources/external";
import { WebhookSource } from "./sources/webhook";
import { TokenStore } from "./tokens";

const tmp = () => mkdtempSync(path.join(tmpdir(), "events-"));
const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("jsonpath", () => {
  it("reads and matches", () => {
    const p = { a: { b: [{ c: 1 }], "x-y": "z" }, action: "opened" };
    expect(readJsonPath(p, "$.a.b[0].c")).toBe(1);
    expect(readJsonPath(p, "$['a']['x-y']")).toBe("z");
    expect(matches(p, { "$.action": ["opened", "edited"], "$.a.b[0].c": 1 })).toBe(true);
    expect(matches(p, { "$.action": "closed" })).toBe(false);
    expect(() => readJsonPath(p, "$.a[*]")).toThrow();
  });
});

describe("webhook source", () => {
  function setup() {
    const secrets = new TokenStore(path.join(tmp(), "s.json"));
    secrets.set("ci", "s3cret");
    const hook = new WebhookSource(secrets, () => ["ci"]);
    const send = vi.fn(async () => {});
    const manager = new SubscriptionManager({ sources: () => [hook], settings: async () => eventsSettings.schema.parse({ batchSeconds: 0 }), send, file: path.join(tmp(), "subs.json") });
    return { hook, manager, send };
  }

  it("rejects bad signatures and unknown names", () => {
    const { hook } = setup();
    const body = Buffer.from('{"a":1}');
    expect(hook.ingest("ci", body, { "x-events-signature": "sha256=00" }).status).toBe(401);
    expect(hook.ingest("nope", body, {}).status).toBe(404);
    expect(hook.ingest("ci", body, { "x-events-signature": sign("s3cret", '{"a":1}') }).status).toBe(202);
  });

  it("wakes the agent on a matching payload only, once", async () => {
    const { hook, manager, send } = setup();
    const r: any = await manager.subscribe({ agentId: "a1" }, { source: "webhook", filter: { name: "ci", match: { "$.status": "failed" } } });
    const post = (obj: object, id: string) => {
      const b = JSON.stringify(obj);
      return hook.ingest("ci", Buffer.from(b), { "x-events-signature": sign("s3cret", b), "x-event-id": id });
    };
    post({ status: "ok" }, "1");
    await manager.hint(() => true);
    expect(send).not.toHaveBeenCalled();
    expect(post({ status: "failed" }, "2").status).toBe(202);
    expect(post({ status: "failed" }, "2").message).toBe("duplicate");
    await manager.hint(() => true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(manager.list()[0]).toMatchObject({ id: r.subscription.id, status: "fired" });
  });
});

describe("external source", () => {
  it("speaks the contract: subscribe, poll, push, unsubscribe", async () => {
    const calls: any[] = [];
    let queue: any[] = [];
    const fetchImpl = (async (_url: string, init: any) => {
      const req = JSON.parse(init.body);
      calls.push({ method: req.method, auth: init.headers.authorization, params: req.params });
      const result =
        req.method === "events/list" ? { events: [{ name: "thing.happened" }] }
        : req.method === "events/subscribe" ? { subscriptionId: "r1", cursor: 0 }
        : req.method === "events/poll" ? { events: queue.splice(0), cursor: 1 }
        : {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
    }) as unknown as typeof fetch;
    const src = new ExternalSource({ id: "svc", name: "Svc", url: "http://x/rpc", authHeader: "authorization" }, () => "Bearer k", () => "https://pub", fetchImpl);
    await src.refreshTypes();
    expect(src.types).toEqual(["thing.happened"]);
    const send = vi.fn(async () => {});
    const manager = new SubscriptionManager({ sources: () => [src], settings: async () => eventsSettings.schema.parse({}), send, file: path.join(tmp(), "subs.json") });
    const r: any = await manager.subscribe({ agentId: "a1" }, { source: "svc", filter: { topic: "t" } });
    const sub = calls.find((c) => c.method === "events/subscribe");
    expect(sub.auth).toBe("Bearer k");
    expect(sub.params.callback.url).toBe("https://pub/events/push/svc");
    src.push("r1", [{ id: "p1", type: "thing.happened", data: { n: 1 } }]);
    await manager.hint(() => true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(manager.list()[0].status).toBe("fired");
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.some((c) => c.method === "events/unsubscribe")).toBe(true);
    void r;
  });
});
