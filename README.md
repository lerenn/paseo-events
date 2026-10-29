# Paseo Events

Paseo plugin: event subscriptions from external services that wake agents or start Factory blueprints. It replaces GitHub Proxy's `github_subscribe`.

- Sources: GitHub (polling with ETags), a generic signed webhook, and external event servers speaking a SEP-3415 style contract. Linear, Sentry and Datadog are planned. See [docs/extending.md](docs/extending.md).
- Tools given to agents: `events_subscribe`, `events_list`, `events_unsubscribe`, `events_sources`.
- Delivery: a steer message to the subscribing agent, an Agents Mail (when that plugin is installed, else the steer message), or a Paseo Factory blueprint (when Factory is installed).

See [OVERVIEW.md](OVERVIEW.md) and [docs/subscriptions.md](docs/subscriptions.md).

## Slack source and standing subscriptions

- `slack`, type `message_created`: new top-level messages of one channel (filter `channel`, optional `bot_id` or `user`), read with
  `conversations.history` using a bot token from the file in the `slackTokenFile` setting (a Kubernetes Secret the host mounts;
  this plugin never stores it). Scopes: `channels:history` (or `groups:history` for a private channel). Event data: `channel`, `ts`,
  `thread_ts`, `text` (text, blocks and attachments), `links` (button and text URLs), `permalink`, and for an Aikido alert
  `aikido_group` with `incident_id = aikido:<group>`, which is also the event id, so several alerts about one group make one event.
- `standing` (settings): subscriptions that belong to the configuration, not to an agent. Persistent, never expire, kept when agents
  are archived, delivered to a Factory blueprint (`deliver.kind = factory`) or by mail (`to` required). They are recreated when their
  definition changes and retried every 5 minutes when they cannot start (for example before the token is mounted).
