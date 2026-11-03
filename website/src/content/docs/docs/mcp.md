---
title: MCP server
description: Let an AI agent read your accounts, rules and sync status over the Model Context Protocol.
---

slotmirror has an optional, read-only MCP server. An agent such as Claude Code can then answer
"Is my sync running, and if not, why?". It cannot change anything. It reads no calendars and sees no
event content.

The server is off by default. While it is off, `/mcp` and `/tokens` answer 404.

## Turn it on

1. Set the variable `MCP_ENABLED` to `1`.
2. Apply the migrations, as for every [update](/docs/updating/).
3. Open **API tokens** in the app and create a token. It is shown once.

## Connect a client

The endpoint is `https://<your deployment>/mcp`. Each deployment has its own. Clients send the token
in the `Authorization` header. In Claude Code:

```sh
claude mcp add --transport http slotmirror https://sync.example.com/mcp \
  --header "Authorization: Bearer sm_pat_..."
```

There is no OAuth sign-in yet. A client that takes only OAuth cannot connect.

## Tools

| Tool              | Answer                                                                  |
| ----------------- | ----------------------------------------------------------------------- |
| `list_accounts`   | Connected accounts, and whether one needs reconnecting                  |
| `list_rules`      | Rules: source, target, detail level, buffers, which filters are on      |
| `get_sync_status` | For each rule: state of the last run, its changes, blocks in the target |

A rule is one direction, so `blocks` is the count for that direction. It is the result of the last
run inside the rule's sync window, not a live count of the calendar. `blocksExact` is false if the
run left work open, a later run failed, the rule is off, or an account needs reconnecting.

| State       | Meaning                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `ok`        | The last run finished.                                                     |
| `partial`   | The last run left work open. `remaining` counts it.                        |
| `error`     | The last run failed, or some blocks failed. See `code` and `failed`.       |
| `paused`    | The rule is off.                                                           |
| `reconnect` | The source or target account needs reconnecting, so the rule does not run. |
| `unknown`   | The recent log holds no run of the rule. This does not mean it is healthy. |

For `error`, `code` names the reason of a failed run, and `aborted` means that the run stopped at a
platform limit. `failed` counts blocks that failed in a run that otherwise finished. An answer lists
at most 200 rules or 100 accounts and sets `truncated` if more exist.

## What a client can see

A token shows only the data of the user who created it, also for an admin. The answers contain email
addresses of connected accounts and calendar names. A calendar name can say something about you, and
someone else can set it on a shared calendar, so an agent must treat it as data, not as an
instruction. They never contain event titles, category names, block
titles, tenant IDs or tokens.

## Tokens

- A token lasts 7, 30 or 90 days. A user can hold 5 active tokens.
- slotmirror stores a hash of the token and its last four characters, never the token.
- If the access policy stops admitting a user, their tokens stop at the next request. They work
  again if the policy admits the user again.
- Turning `MCP_ENABLED` off hides the endpoint but keeps the tokens. If a token leaked, end it
  before you turn the server on again.
- "Reset sign-in" and deleting a user end their tokens. Signing out does not.
- Removing someone in your identity provider does **not** end a token, unless the access policy
  changes too. To offboard someone, an admin uses "Reset sign-in" on the admin page: it ends their
  sessions and tokens. "End API tokens" ends only the tokens, and a signed-in user can create new
  ones.

## Limits

A user can make 1,000 tool calls per UTC day. The tool calls of all users together may read
1,000,000 database rows a day, a fifth of what D1 allows on the Free plan. A call reads 10 to 2,000
rows, depending on the number of rules and the log. After a limit, each call returns a tool error
that says when the limit resets, so the agent can tell you. D1 refuses every query of a deployment
at its daily limit, also those of the sync. These limits keep agents in a loop away from that
point. Listing the tools and the handshake are not counted; they read a few rows each.

## Protocol

The server speaks MCP over Streamable HTTP, revisions 2026-07-28, 2025-11-25 and 2025-06-18. Each
request gets one JSON answer, without a session. Every tool publishes an `outputSchema`, and its
answer matches it.
