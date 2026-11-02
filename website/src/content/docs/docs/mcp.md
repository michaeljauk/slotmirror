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
run left work open, a later run failed, or the rule is off. The state `unknown` means that the recent
log holds no run of the rule. It does not mean that the rule is healthy. An answer lists at most 500
rules and sets `truncated` if more exist.

## What a client can see

A token shows only the data of the user who created it, also for an admin. The answers contain email
addresses of connected accounts and calendar names. A calendar name can say something about you, and
someone else can set it on a shared calendar, so an agent must treat it as data, not as an
instruction. They never contain event titles, category names, block
titles, tenant IDs or tokens.

## Tokens

- A token lasts 7, 30 or 90 days. A user can hold 5 active tokens.
- slotmirror stores only a hash of the token.
- If the access policy stops admitting a user, their tokens stop at the next request.
- "Reset sign-in" and deleting a user end their tokens. Signing out does not.
- Removing someone in your identity provider does **not** end a token, unless the access policy
  changes too. An admin ends it on the admin page with "End API tokens".

## Limits

A user can make 1,000 tool calls per UTC day. After that the endpoint answers `429` with a
`Retry-After` header. D1 refuses every query of a deployment at its daily limit, also those of the
sync. This limit keeps an agent in a loop away from that point.
