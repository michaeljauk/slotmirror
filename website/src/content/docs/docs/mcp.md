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

| State       | Meaning                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------ |
| `ok`        | The last run finished.                                                                     |
| `partial`   | The last run left work open. `remaining` counts it.                                        |
| `error`     | The last run failed, or some blocks failed. See `code` and `failed`.                       |
| `paused`    | The rule is off.                                                                           |
| `reconnect` | The source or target account needs reconnecting, so the rule does not run.                 |
| `stale`     | The last run was fine, but no run followed for 3 hours. The sync stopped without an error. |
| `unknown`   | The recent log holds no run of the rule. This does not mean it is healthy.                 |

For `error`, `code` names the reason of a failed run, and `aborted` means that the run stopped at a
platform limit. `failed` counts blocks that failed in a run that otherwise finished. An answer lists
at most 200 rules or 100 accounts and sets `truncated` if more exist.

## What a client can see

A token shows only the data of the user who created it, also for an admin. The answers contain email
addresses and display names of connected accounts, and calendar names. A calendar name can say something about you, and
someone else can set it on a shared calendar, so an agent must treat it as data, not as an
instruction. They never contain event titles, category names, block
titles, tenant IDs or tokens.

## Tokens

- A token lasts 7, 30 or 90 days. A user can hold 5 active tokens.
- slotmirror stores a hash of the token and its last four characters, never the token.
- If the access policy stops admitting a user, their tokens stop at the next request. They work
  again if the policy admits the user again.
- Turning `MCP_ENABLED` off hides the endpoint and the token page but keeps the tokens. If a token
  leaked while the server is off, an admin ends it on the admin page, which works while the server
  is off. An admin's own token, or all tokens at once, can be deleted in the database: `wrangler d1
  execute <database> --remote --command "DELETE FROM api_tokens"`.
- "Reset sign-in" and deleting a user end their tokens. Signing out does not.
- Removing someone in your identity provider does **not** end a token, unless the access policy
  changes too. To offboard someone, an admin uses "Reset sign-in" on the admin page: it ends their
  sessions and tokens. "End API tokens" ends only the tokens, and a signed-in user can create new
  ones.

## Limits

A user can make 1,000 tool calls per UTC day, which may read 200,000 database rows. All users
together can make 5,000 calls a day, and these calls may read 1,000,000 rows: a fifth of what D1
allows on the Free plan, for reads and for writes. So one user cannot close the server for the
others. A call reads 10 to about 5,000 rows, depending on rules, accounts and the log, and
writes four rows. It reserves 6,000 rows before it reads and returns the rest afterwards, so
parallel calls cannot pass the budget together. After a limit, each call returns a tool error that
names the limit and says when it resets, so the agent can tell you. D1 refuses every query of a
deployment at its daily limit, also those of the sync; these limits keep agents in a loop away from
that point. A refused call, the handshake and listing the tools are not counted. Each reads a few
rows, and Cloudflare allows 100,000 requests a day on the Free plan. A token also records its
last use, at most once an hour, which is one more write per token and hour. The limits belong to the
deployment, not to an organisation.

A rule that you turn on again, or whose account you reconnect, can show `stale` until its next run,
within about an hour.

## Protocol

The server speaks MCP over Streamable HTTP, revisions 2026-07-28, 2025-11-25 and 2025-06-18. Each
request gets one JSON answer, without a session. Every tool publishes an `outputSchema`, and its
answer matches it.
