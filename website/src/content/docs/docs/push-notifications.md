---
title: Push notifications
description: How slotmirror learns about calendar changes, and what runs when a notification is missed.
---

If `PUBLIC_URL` is set, slotmirror asks Microsoft and Google to notify it when a calendar changes
that a rule reads or writes. A change then starts a sync.

## Subscriptions

- **Microsoft** subscriptions last up to 7 days.
- **Google** channels last until Google ends them.
- The cron renews both a day before they expire.

## When a notification is missed

The cron runs every 10 minutes.

- Once an hour it runs a full cycle over all rules, as a check.
- In between, it runs only the rules whose source or target calendar has no active
  subscription.

A missed notification therefore costs at most an hour. Without `PUBLIC_URL`, every rule runs
every 10 minutes.

## Security

Each notification carries a token that only your deployment can compute: an HMAC of the account
with `SESSION_SECRET`. Notifications without it change nothing.

If you rotate `SESSION_SECRET`, the existing subscriptions no longer match. They are created again
when they expire, which can take up to 7 days. The cron keeps syncing in the meantime.

## Own writes

When slotmirror writes a block, Microsoft sends a notification for that write too. slotmirror
recognises its own writes of the last two minutes and does not sync again for them. Google
notifications carry no event IDs, so this filter works for Microsoft only.
