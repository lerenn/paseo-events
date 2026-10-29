# Subscription model

## Tools

| Tool | Purpose |
| --- | --- |
| `events_subscribe` | `source`, `filter`, `deliver?` (`agent`, `mail`, `factory`), `ttl_seconds?`, `mode?`. Returns the subscription, or `{satisfied}` when the condition already holds (once mode). |
| `events_list` | The caller's subscriptions, `source?` and `status?` filters. |
| `events_unsubscribe` | Cancel one of the caller's active subscriptions. |
| `events_sources` | Sources, connection status and event types. |

The agent id comes from the MCP session, never from the arguments.

Naming follows the MCP Events draft (SEP-3415): `events_subscribe`/`list`/`unsubscribe` map to `events/subscribe`/`list`/`unsubscribe`, and every event is `{id, source, type, subject, time, data}` with a stable `id` used for dedupe.

## GitHub filter

`{repo?, number | url, types[], head_sha?, ignore_authors?, authors?, include_edits?}`. `repo` defaults to the origin remote of the agent's directory. `head_sha` applies to checks, reviews (their `commit_id`) and `codex_review`; `authors` keeps only reviews and comments by those logins (the converse of `ignore_authors`).

| Type | Fires when |
| --- | --- |
| `checks_completed` | The checks and statuses of the head (or `head_sha`) are all finished, at least one reported, and stay so for 20 s. A push restarts the wait. |
| `review_submitted` | A review not there at subscribe time is submitted (not `PENDING`), on `head_sha` when given. |
| `pr_merged` / `pr_closed` | Merged / closed without merging. |
| `pr_head_updated` | The head commit changed. |
| `comment_created` | A new conversation or review comment; with `include_edits: true`, also each edit of an existing one. |
| `codex_review` | A new review or conversation comment by Codex (setting `codexLogins`), or an edit of its summary comment (deduped by comment id and `updated_at`). Data: `kind`, `commit_sha`, `status`, `has_unresolved_findings` from `codex-review-state:v1`. |

## Modes, ttl, delivery

- `mode: once` (default): fires on the first poll that shows events, reporting all of them, then ends. `persistent`: stays until the ttl; events seen within `batchSeconds` become one prompt.
- `ttl_seconds` defaults to `defaultTtlMinutes`, capped by `maxTtlMinutes`. At expiry a last read happens: a real event wins over an expiry notice.
- Events are deduped per subscription by event id. A wake-up that fails is retried twice.
- State is kept in `~/.paseo/events/subscriptions.json` (mode 0600) and restored at startup. An archived agent's subscriptions are cancelled.

## Credentials

GitHub tokens are per owner, chosen by the repository owner, stored write-only. To reuse GitHub Proxy's tokens on the daemon host, without printing them:

```sh
install -D -m 600 ~/.paseo/github-proxy/tokens.json ~/.paseo/events/tokens.json
```

(The file format is the same: `{"<owner>": "<token>"}`. The plugin re-reads it on every call, so no restart is needed.)

## Migrating from `github_subscribe`

```
github_subscribe(repo, number, events, timeout_seconds, ignore_authors)
→ events_subscribe(source:"github", filter:{repo, number, types:events, ignore_authors}, ttl_seconds:timeout_seconds)
```

Event names are unchanged. The wake-up text is the same shape, prefixed `[events]`.

## Other sources

| Source | Filter | Types | Credential |
| --- | --- | --- | --- |
| `linear` | `{types[], team?, issue?, states?}` | `issue_created`, `state_changed` | API key |
| `sentry` | `{org, project, level?, query?, types?}` | `issue_new` | auth token (setting `sentryUrl` for self-hosted) |
| `datadog` | `{types[], monitor_tags?, monitor_id?}` | `alert_triggered`, `alert_resolved` | `<api key>:<application key>` (setting `datadogSite`) |
| `webhook`, external | see [extending.md](extending.md) | | HMAC secret / header value |

All three poll every `pollSeconds` and only report what happened after the subscription started. Keys are write-only; a key the service rejects is not stored.

## Factory delivery

`deliver: {kind:"factory", blueprint, vars_map}` starts a Paseo Factory blueprint per event. Factory is found at runtime, with no import: it writes `~/.paseo/factory/endpoint.json` (`{url, token}`, mode 0600), and the plugin reads it on every use. A missing file means Factory is not installed and `events_subscribe` refuses the delivery.

`POST {url}/blueprints/start` with `Authorization: Bearer <token>` and body `{blueprint, vars, requestedBy:"events", idempotencyKey:"<subscription id>:<event id>"}` answers 200 `{runId}`, 404 (unknown blueprint), 400 (bad vars) or 401. The same key returns the same run. `vars_map` maps blueprint vars to event paths, for example `{"pr":"subject","sha":"data.sha"}` (`id`, `source`, `type`, `subject`, `time`, `data.*`). Each outcome (run id or error) appears in the screen's recent deliveries.

## Mail delivery

`deliver: {kind:"mail", to?}` (or setting `defaultDeliver: "mail"` for subscriptions without a `deliver`; default `agent`) sends each delivery as one Agents Mail rather than a steer prompt, which lands mid-turn as a user message. Fired events, persistent batches and expiry ("nothing seen") notices are all mailed: subject `Event: <source> <types> <subject>` (`Event: <source> expired <label>` for an expiry), body the prompt text, sender `Events`.

Agents Mail is found at runtime with no import, like Factory: it writes `~/.paseo/agents-mail/endpoint.json` (`{url, token}`, mode 0600; `EVENTS_MAIL_ENDPOINT` overrides the path). Events calls `GET {url}/api/health` (result reused for 60 s), then `POST {url}/api/mails` with `Authorization: Bearer <token>` and `{to, subject, body, kind:"info", asAgent:{agentId:"events", name:"Events"}}`. Subscribing with `kind:"mail"` is accepted even when Agents Mail is absent; the check happens at delivery. If the file is missing, the health check fails or the post is refused, the prompt is sent directly to the subscribing agent (with the usual retries), the failure is logged and appears in the screen's recent deliveries as a failed `mail:<to>` entry followed by the `agent:` one.
