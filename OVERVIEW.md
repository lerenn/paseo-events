Paseo Events lets agents wait for things that happen in external services without polling them. An agent calls `events_subscribe` with a source, a filter and a delivery, ends its turn, and the daemon sends it a prompt when the event arrives or the subscription expires.

The first source is GitHub: checks finished on a pull request, a review submitted, a merge, a close, a new head commit, a new comment. Events are found by reading GitHub with conditional requests (ETags, free when nothing changed) on an interval, and diffing against what the subscription saw when it started.

New agents get the Events tools automatically (setting "Inject into", `PASEO_EVENTS=off` opts an agent out). Subscriptions end when the agent is archived.

## Setup

Open the Events screen and add one GitHub token per owner or organization, for example `lerenn` and `anyshift-io`. The token needs read access to pull requests, checks (or Actions) and commit statuses. Tokens are write-only: the screen shows that one is set but never displays it. They are stored on the daemon machine in `~/.paseo/events/tokens.json`, readable only by its user.

## Delivery

`deliver: {kind: "agent"}` (the default) steers the subscribing agent with a prompt. `deliver: {kind: "factory", blueprint, vars_map}` starts a Paseo Factory blueprint instead, mapping event fields to blueprint variables; it is refused when Factory is not installed.
