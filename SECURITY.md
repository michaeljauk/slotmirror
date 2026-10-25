# Security policy

freebusy-sync stores OAuth tokens with write access to calendars. Please report security problems
privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the **Security** tab of this repository and
choose **Report a vulnerability**. Do not open a public issue.

Please include the affected version or commit, the steps to reproduce, and the impact. You will get
an answer within 7 days. Once a fix is released, the advisory is published with credit, unless you
ask otherwise.

## Supported versions

Only the latest release receives security fixes. Self-hosters should update to it.

## What the project does to protect your data

- Each deployment runs in its owner's Cloudflare account. No third party holds the tokens.
- OAuth tokens are encrypted at rest with AES-256-GCM. The key is a Worker secret, and the account
  ID is bound as additional authenticated data.
- By default only start, end and "Busy" are copied between calendars.
- The OAuth state is signed and checked against a cookie; sign-in uses PKCE.
- Access to a deployment is limited by `ALLOWED_EMAILS`, `ALLOWED_DOMAINS` and
  `ALLOWED_TENANT_IDS`, and it is checked again on every request.
