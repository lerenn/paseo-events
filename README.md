# Paseo Events

Paseo plugin: event subscriptions from external services that wake agents or start Factory blueprints. It replaces GitHub Proxy's `github_subscribe`.

- Sources: GitHub (polling with ETags). Linear, Sentry, Datadog, external event sources and a signed generic webhook are planned.
- Tools given to agents: `events_subscribe`, `events_list`, `events_unsubscribe`, `events_sources`.
- Delivery: a steer message to the subscribing agent, or a Paseo Factory blueprint (when Factory is installed).

See [OVERVIEW.md](OVERVIEW.md) and [docs/subscriptions.md](docs/subscriptions.md).
