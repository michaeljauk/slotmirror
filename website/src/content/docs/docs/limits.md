---
title: Limits
description: What slotmirror does not do yet, and how it stays inside the Cloudflare free plan and the provider rate limits.
---

## What it does not do

- **Microsoft 365 and Google only.** iCloud and other CalDAV calendars are not supported yet.
- **Targets are main calendars.** Blocks go into the main calendar of each account, not into
  other calendars of the account.
- **A window of 90 days.** By default the sync mirrors the next 90 days. The window moves forward
  every day. You can change it under **For all calendars**.
- **Past blocks stay.** The sync looks from today forward. If you delete a rule, its blocks from
  today on are removed. Blocks before today stay as history.
- **Unverified Google app.** Until Google verifies your OAuth client, Google shows a warning when
  someone connects a Google account.

## Cloudflare free plan

The Workers Free plan allows 10 ms CPU time and 50 subrequests per invocation. slotmirror splits
each sync into one step per rule direction, so that each step stays inside these limits.

The daily quotas are 100,000 Worker requests and 100,000 Durable Object requests. They cover a
person or a small team. Each connected account needs a few hundred requests a day. A large team
needs Workers Paid ($5 a month).

## Provider rate limits

Microsoft and Google throttle a client that sends too many requests. slotmirror stays inside their
limits and recovers when it is throttled.

- **Outlook** allows four concurrent requests per app and mailbox, and 10,000 requests in 10
  minutes. One `$batch` already uses the four slots. All calls to a mailbox start in the Durable
  Object of its account, and that instance runs them one at a time.
- **Google** allows 600 requests per minute per user. Each call in a batch counts as one request.
- **If a provider throttles**, the throttled writes stay open, and the next alarm waits for
  `Retry-After`. Graph answers 429 or 503. Google answers 429, or 403 with the reason
  `rateLimitExceeded` or `userRateLimitExceeded`, and sends no `Retry-After`. Without the header,
  the wait is 30 seconds.
- **The activity log** shows the HTTP status and the error code of the provider for each failed
  or throttled write, for example `HTTP 429 ApplicationThrottled ×13`.
