---
title: Introduction
description: What slotmirror does, who it is for, and how it works.
---

slotmirror keeps several calendars in sync, so that nobody books you twice. It copies your events
from one calendar into your others as "Busy" blocks, or with as much detail as you choose. It
supports Microsoft 365 and Google Calendar and runs in your own Cloudflare account, on the free
plan.

It is for people with more than one calendar: consultants with client tenants, founders with two
companies, anyone with a work and a private calendar. You host it yourself, so your calendar
tokens stay with you and not with a sync service.

:::caution[Early version]
The version is below 1.0. Settings and the database can still change between releases.
:::

![The calendar editor: one card per calendar, and an overview of all directions](../../../../../docs/images/editor.png)

## What it does

- **One group for the common case.** Put your calendars in the block group, and each sees the
  others only as "Busy", marked private.
- **More detail where you want it.** Per calendar and target you choose: not at all, as busy,
  with title, or everything.
- **Several calendars per account.** Next to the main calendar you can add others, such as a
  subscribed team schedule. Targets are always the main calendars.
- **Changes within seconds.** Microsoft and Google notify your deployment when a calendar
  changes. See [Push notifications](../push-notifications/).
- **Recurring events are exact.** Each occurrence is mirrored on its own.
- **Only differences are written.** Every run compares what each target should contain with what
  it does contain. Blocks are never rebuilt.
- **Privacy limits for teams.** An admin can cap how much detail moves between work calendars and
  private ones. See [Organisations](../organisations/).
- **Audit log.** Sign-ins, changes and sync runs with counts and error codes, never event content.
- **English and German** in the app.

## How it works

A change in a source calendar reaches your Worker as a notification. The Worker reads the
changed events and writes the matching blocks into the target calendars.

- **Worker (Hono):** dashboard pages, OAuth callbacks, webhook endpoints and the cron trigger.
- **D1:** orgs, users, accounts, calendars, rules and the audit log.
- **Durable Object `AccountSync`, one per connected account:** encrypted tokens, the provider
  watches and the queue of rules to run. A rule runs in the instance of its target account and
  reads events from the instance of its source account.
- **Markers instead of a mapping table.** Each block carries a marker with the rule and the source
  occurrence. The target calendar itself records which blocks exist, so no mapping table can
  drift.
