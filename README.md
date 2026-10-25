# Paseo Events

Paseo plugin: event subscriptions from external services that wake agents or start Factory blueprints. It replaces GitHub Proxy's `github_subscribe`.

- Sources: GitHub (polling with ETags), a generic signed webhook, and external event servers speaking a SEP-3415 style contract. Linear, Sentry and Datadog are planned. See [docs/extending.md](docs/extending.md).
- Tools given to agents: `events_subscribe`, `events_list`, `events_unsubscribe`, `events_sources`.
- Delivery: a steer message to the subscribing agent, or a Paseo Factory blueprint (when Factory is installed).

See [OVERVIEW.md](OVERVIEW.md) and [docs/subscriptions.md](docs/subscriptions.md).

## Status

GitHub, Linear, Sentry, Datadog, signed webhook and external sources are implemented. Factory delivery is pending an agreed entry point.
