import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HttpMail } from "./mail";

const endpointFile = (content?: object) => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "mail-")), "endpoint.json");
  if (content) writeFileSync(file, JSON.stringify(content));
  return file;
};

describe("HttpMail", () => {
  it("posts the mail after a health check", async () => {
    const fetchImpl = vi.fn(async (..._a: any[]) => new Response("{}", { status: 200 }));
    const mail = new HttpMail(() => endpointFile({ url: "http://127.0.0.1:1/", token: "t" }), fetchImpl as any);
    await mail.send("@assistant", "Event: x", "body");
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual(["http://127.0.0.1:1/api/health", "http://127.0.0.1:1/api/mails"]);
    const init = fetchImpl.mock.calls[1][1] as any;
    expect(init.headers.authorization).toBe("Bearer t");
    expect(JSON.parse(init.body)).toMatchObject({ to: "@assistant", subject: "Event: x", body: "body", asAgent: { agentId: "events" } });
  });

  it("is unavailable without an endpoint file, without calling anything", async () => {
    const fetchImpl = vi.fn();
    const mail = new HttpMail(() => endpointFile(), fetchImpl as any);
    expect(await mail.available()).toBe(false);
    await expect(mail.send("a", "s", "b")).rejects.toThrow(/not installed/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("remembers an outage after a failed send, then recovers after the ttl", async () => {
    let t = 0;
    let fail = true;
    const fetchImpl = vi.fn(async (url: string) => new Response(fail && url.endsWith("/api/mails") ? "no" : "{}", { status: fail && url.endsWith("/api/mails") ? 500 : 200 }));
    const mail = new HttpMail(() => endpointFile({ url: "http://h", token: "t" }), fetchImpl as any, () => t, 60_000);
    await expect(mail.send("a", "s", "b")).rejects.toThrow(/500/);
    expect(await mail.available()).toBe(false);
    fail = false;
    t = 61_000;
    expect(await mail.available()).toBe(true);
    await mail.send("a", "s", "b");
  });
});
