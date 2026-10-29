Paseo Events lets agents wait for things that happen in external services without polling them. An agent calls `events_subscribe` with a source, a filter and a delivery, ends its turn, and the daemon sends it a prompt when the event arrives or the subscription expires.

The first source is GitHub: checks finished on a pull request, a review submitted, a merge, a close, a new head commit, a new comment, a Codex review. Events are found by reading GitHub with conditional requests (ETags, free when nothing changed) on an interval, and diffing against what the subscription saw when it started.

New agents get the Events tools automatically (setting "Inject into", `PASEO_EVENTS=off` opts an agent out). Subscriptions end when the agent is archived.

## Setup

Open the Events screen and add one GitHub token per owner or organization, for example `lerenn` and `anyshift-io`. The token needs read access to pull requests, checks (or Actions) and commit statuses. Tokens are write-only: the screen shows that one is set but never displays it. They are stored on the daemon machine in `~/.paseo/events/tokens.json`, readable only by its user.

## Delivery

`deliver: {kind: "agent"}` (the default) steers the subscribing agent with a prompt. `deliver: {kind: "factory", blueprint, vars_map}` starts a Paseo Factory blueprint instead, mapping event fields to blueprint variables; it is refused when Factory is not installed.

`deliver: {kind: "mail", to?}` sends an Agents Mail instead, so the event does not interrupt a turn: one mail per delivery (a batch of a persistent subscription is one mail), subject `Event: <source> <types> <subject>`, body the same text as the prompt. `to` is an agent id, title or alias such as `@assistant` and defaults to the subscribing agent. Expiry notices are mailed too. If Agents Mail is not installed or not answering when the event arrives, the prompt is sent directly as with `kind: "agent"`, and the failure is logged and shown in the screen's recent deliveries. The setting `defaultDeliver` (`agent` by default, or `mail`) applies to subscriptions that name no delivery; a subscription's own `deliver` wins, except that when Agents Mail is installed (it answers at subscribe time), `kind: "agent"` (asked for or by default) is turned into a mail to the subscribing agent and the override is logged. `kind: "factory"` is never changed.

## GitHub filters

`{repo?, number | url, types[], head_sha?, ignore_authors?, authors?, include_edits?}`. `head_sha` limits `checks_completed`, `review_submitted` (the review's commit) and `codex_review` to that commit. `authors` keeps only reviews and comments by those logins, the converse of `ignore_authors`. `comment_created` reports new comments only, unless `include_edits: true` also reports each edit of an existing comment (seen through its `updated_at`).

`codex_review` fires on a review or a conversation comment by the Codex bot (setting `codexLogins`, default `["chatgpt-codex-connector[bot]"]`), including each edit of the summary comment Codex keeps updating. Its data carries `commit_sha`, `status` and `has_unresolved_findings` from the comment's `codex-review-state:v1` marker (null when absent); with `head_sha`, a comment counts only when its marker names that commit.
