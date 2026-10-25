# Extending Events without code in the plugin

There is no in-process plugin system. New services plug in from outside, in two ways. Both are configured in the plugin settings (names, URLs, public URL); secrets are write-only in the screen and never shown again.

## Listener

Webhooks and pushes need a listener reachable from the sender. Set `webhookPort` (0 keeps it off), `webhookBind` (default `0.0.0.0`) and `webhookPublicUrl` (what you tell senders; also the base of push callbacks). Put a tunnel or reverse proxy with TLS in front of it. It serves only:

- `POST /events/webhook/<name>`
- `POST /events/push/<source id>`

The agent endpoint (`/mcp`) stays on loopback and is never served here.

## Generic signed webhook

Add a name in `webhooks` and set its secret in the screen. Any system then POSTs JSON:

```sh
body='{"status":"failed","job":"nightly"}'
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST https://events.example.com/events/webhook/ci \
  -H "x-events-signature: sha256=$sig" -H "x-event-id: run-42" -H "x-event-type: ci.failed" \
  -d "$body"
```

- Signature: hex HMAC-SHA256 of the raw body (`x-events-signature` or `x-hub-signature-256`, with or without `sha256=`). A wrong one gets 401; an unknown name 404.
- Event id for dedupe: `x-event-id`, else `x-github-delivery`, else a hash of the body. Type: `x-event-type`, else the payload's `type`, else `webhook`.
- Subscribe with `events_subscribe(source:"webhook", filter:{name:"ci", match:{"$.status":"failed","$.job":["nightly","weekly"]}, types?:["ci.failed"]})`. `match` maps JSONPath (`$.a.b[0].c`, no wildcards) to a value or a list of accepted values; all entries must match. Only deliveries after the subscription started count.

## External event sources (SEP-3415 style)

Register `id=url` in `externalSources` (and, per source, the auth header name; default `authorization`) and set the header value in the screen. The server speaks JSON-RPC 2.0 over HTTP POST at that URL:

| Method | Params | Result |
| --- | --- | --- |
| `events/list` | `{}` | `{events:[{name, description?}]}`: the event types offered (shown by `events_sources`) |
| `events/subscribe` | `{filter, callback?}` | `{subscriptionId, cursor?, satisfied?}`; `satisfied` answers a once-subscription at once |
| `events/poll` | `{subscriptionId, cursor?}` | `{events:[{id, type, subject?, time?, data?}], cursor?}` |
| `events/unsubscribe` | `{subscriptionId}` | `{}` |

Agents use it as `events_subscribe(source:"<id>", filter:{...whatever the server defines})`. The filter is passed through untouched. Event ids must be stable (Events dedupes on them).

Delivery is polled every `pollSeconds`. If `webhookPublicUrl` is set, `events/subscribe` also receives `callback: {url, token}`; the server may then push `POST <url>` with `Authorization: Bearer <token>` and body `{subscriptionId, events:[...]}`, which wakes the subscription at the next check. A push-only server may answer `events/poll` with an error.

A complete minimal server is in [`examples/external-source.mjs`](../examples/external-source.mjs).
