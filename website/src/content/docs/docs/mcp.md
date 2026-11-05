---
title: MCP server
description: Let an AI agent read your accounts, rules and sync status over the Model Context Protocol.
---

slotmirror has an optional, read-only MCP server. An agent such as Claude Code can then answer
"Is my sync running, and if not, why?". It cannot change anything. It reads no calendars and sees no
event content.

The server is off by default. While it is off, `/mcp`, `/tokens` and the OAuth endpoints answer 404.

## Turn it on

1. Set the variable `MCP_ENABLED` to `1`.
2. Apply the migrations, as for every [update](/docs/updating/).

## Connect a client

The endpoint is `https://<your deployment>/mcp`. Each deployment has its own. A client connects in
one of two ways.

### With your sign-in (OAuth)

Add the endpoint in the client without a token. Clients that follow the MCP authorization spec,
such as Claude Code, then open slotmirror in the browser. The client must use an HTTPS redirect, or
HTTP on `127.0.0.1` or `localhost`; a client with its own URL scheme cannot connect yet. You sign in as
usual and allow the app to read. The client gets its own tokens; you copy nothing.

```sh
claude mcp add --transport http slotmirror https://sync.example.com/mcp
```

In Claude Code, run `/mcp` once to sign in. Connected apps appear under **API tokens**, where you can
disconnect them.

### With a personal token

For a script, or a client without OAuth: open **API tokens** in the app and create a token. It is
shown once. Clients send it in the `Authorization` header:

```sh
claude mcp add --transport http slotmirror https://sync.example.com/mcp \
  --header "Authorization: Bearer sm_pat_..."
```

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
  sessions, tokens and connected apps. "End tokens and apps" ends only those, and a signed-in user can create new
  ones.

## Connected apps

- A client registers itself with the deployment (dynamic client registration). Anyone can
  register a client, so the consent page says that the name is unchecked and shows where the answer
  goes. A deployment takes 1,000 new clients a day, and 30 from one network address (an IPv6 /64 counts as
  one). Someone with many addresses can use up the day's registrations; apps that are registered
  already keep working, new ones wait until 00:00 UTC. Each registration writes about a dozen database rows, so
  a full day of them takes about a tenth of D1's daily writes. The count keeps
  a keyed hash of the address, not the address. A client that never connects is deleted with a later registration after 30 days, one that
  connected once 180 days after its last connection.
- If an app sends a request that slotmirror cannot take, the error shows on slotmirror's page. Only
  your decision, allow or deny, goes back to the app.
- The consent buttons wait a moment until the page is visible, so that a click meant for another
  window does not allow an app.
- An app reads with an access token that lasts one hour and renews it with a refresh token. Each
  renewal replaces the refresh token. If an older refresh token comes back within its own 30 days,
  the connection ends, because someone copied it. Only the token just before the current one has 30 seconds of grace,
  for two renewals that raced.
- A connection lasts at most 90 days, then you allow the app again. A user can connect 10 apps.
- Disconnecting on the **API tokens** page, "Reset sign-in", "End tokens and apps" and deleting the user
  end connections at once. The access policy stops them as it stops tokens.
- Redirects must use HTTPS, or HTTP on `127.0.0.1` or `localhost` for apps on your computer.

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
