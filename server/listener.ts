import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ExternalSource } from "./sources/external";
import type { WebhookSource } from "./sources/webhook";
import { timingSafeEqual } from "node:crypto";

const MAX_BODY = 1_000_000;

/**
 * The only listener meant to be reachable from outside (behind a tunnel or reverse proxy):
 *   POST /events/webhook/<name>  HMAC-signed JSON
 *   POST /events/push/<source>   bearer-authorized pushes from an external event server
 * Nothing else is served. Unlike the agent endpoint it does not check the Host header.
 */
export class WebhookListener {
  private server: Server | null = null;

  constructor(private readonly deps: { webhook: WebhookSource; external: (id: string) => ExternalSource | undefined }) {}

  start(port: number, bind: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.route(req).then(
          ({ status, message }) => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify({ message }));
          },
          () => {
            res.writeHead(500);
            res.end();
          },
        );
      });
      server.once("error", reject);
      server.listen(port, bind, () => {
        this.server = server;
        server.off("error", reject);
        resolve(`http://${bind}:${(server.address() as AddressInfo).port}`);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  async route(req: IncomingMessage): Promise<{ status: number; message: string }> {
    if (req.method !== "POST") return { status: 405, message: "POST only" };
    const url = (req.url ?? "").split("?")[0];
    const webhook = /^\/events\/webhook\/([A-Za-z0-9-]+)$/.exec(url);
    const push = /^\/events\/push\/([a-z0-9-]+)$/.exec(url);
    if (!webhook && !push) return { status: 404, message: "not found" };
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (err) {
      return { status: 413, message: (err as Error).message };
    }
    if (webhook) return this.deps.webhook.ingest(webhook[1], body, req.headers);
    const source = this.deps.external(push![1]);
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    const a = Buffer.from(bearer);
    const b = Buffer.from(source?.pushToken ?? "");
    if (!source || a.length !== b.length || !timingSafeEqual(a, b)) return { status: 401, message: "unauthorized" };
    try {
      const { subscriptionId, events } = JSON.parse(body.toString("utf8"));
      return { status: 202, message: `accepted ${source.push(String(subscriptionId), events)}` };
    } catch {
      return { status: 400, message: "body must be JSON {subscriptionId, events}" };
    }
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
