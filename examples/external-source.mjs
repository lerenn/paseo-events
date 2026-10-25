// Minimal external event source for Paseo Events. Run: node examples/external-source.mjs
// Then in Events settings add the external source `demo=http://127.0.0.1:8099/rpc` and set its
// header value (default header: authorization) to `Bearer demo-secret`.
// It emits one `tick` event per second per subscription; polling only, no push.
import { createServer } from "node:http";

const SECRET = "Bearer demo-secret";
const subs = new Map(); // subscriptionId -> { filter, n }
let next = 0;

const methods = {
  "events/list": () => ({ events: [{ name: "tick", description: "A counter, once per second" }] }),
  "events/subscribe": ({ filter }) => {
    const id = `s${++next}`;
    subs.set(id, { filter, startedAt: Date.now() });
    return { subscriptionId: id, cursor: 0 };
  },
  // The cursor is the last tick number returned; events carry stable ids so Events can dedupe.
  "events/poll": ({ subscriptionId, cursor }) => {
    const s = subs.get(subscriptionId);
    if (!s) throw new Error("unknown subscription");
    const upto = Math.floor((Date.now() - s.startedAt) / 1000);
    const events = [];
    for (let n = (cursor ?? 0) + 1; n <= upto; n++) events.push({ id: `${subscriptionId}-${n}`, type: "tick", subject: s.filter.topic ?? "demo", data: { n } });
    return { events, cursor: upto };
  },
  "events/unsubscribe": ({ subscriptionId }) => (subs.delete(subscriptionId), {}),
};

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const reply = (obj) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(obj)));
    if (req.headers.authorization !== SECRET) return (res.writeHead(401), res.end());
    const { id, method, params } = JSON.parse(body);
    try {
      reply({ jsonrpc: "2.0", id, result: methods[method](params ?? {}) });
    } catch (e) {
      reply({ jsonrpc: "2.0", id, error: { code: -32000, message: String(e.message) } });
    }
  });
}).listen(8099, "127.0.0.1");
