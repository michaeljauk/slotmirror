---
title: Sync Outlook and Google Calendar
description: Show your Outlook events in Google Calendar and your Google events in Outlook, as busy blocks or with titles, without a sync service.
sidebar:
  order: 1
---

You have an Outlook calendar for work and a Google calendar for everything else. People who book
you in one calendar do not see the other. This guide makes each calendar show the events of the
other.

## Why a calendar subscription is not enough

Outlook and Google Calendar can both subscribe to a calendar by its address, an ICS link. You
then see the other calendar next to yours. A subscription has three limits:

- It is read-only and goes in one direction.
- The calendar app refreshes it on its own schedule, so a change can take hours or longer to
  appear.
- People who check when you are free see your main calendar. The events of a subscribed calendar
  do not appear there.

slotmirror writes real events into the main calendar of each account. People who check when you
are free then see the blocks. With `PUBLIC_URL` set, a change starts the sync when the provider
reports it. Without it, the change arrives at the next run, after up to 10 minutes.

## What you get

- Work events appear in Google Calendar, with titles if you want.
- Google events appear in Outlook as "Busy", marked private.
- A moved or cancelled meeting moves or removes its copy.

## Steps

1. Deploy slotmirror with the [Quickstart](../../docs/quickstart/).
2. Create a [Microsoft Entra app](../../docs/entra-setup/) and a
   [Google OAuth client](../../docs/google-setup/).
3. Set `PUBLIC_URL`, so that the providers notify your deployment of changes.
4. Sign in and connect both accounts under **Accounts**.
5. On the **Rules** page, use **Quick start**: both calendars then block each other as busy.
6. Expand the card of the Outlook account. For the Google target, choose **With title** or
   **Everything**. The line **There:** shows the result.
7. Choose **Save**.

## Things to know

- Copies go into the main calendar of each account.
- Events marked private in the source never carry more than "Busy".
- All-day events such as holidays are mirrored by default, so they block a whole day. Events that
  are marked as free stay out. To leave out all all-day events, turn on **Skip all-day events**
  under **For all calendars**.

## Questions

### Does it work with Outlook.com and Gmail?

Yes. On the Microsoft side, slotmirror connects Microsoft 365 work or school accounts and personal
Microsoft accounts such as Outlook.com. Personal accounts need the account type **Accounts in any
organizational directory and personal Microsoft accounts** in the
[Entra app](../../docs/entra-setup/). On the Google side, it connects Google accounts.

### Does Google Calendar see the titles of my Outlook meetings?

Not by default. At the level **As busy**, a copy carries only the title from **Title of busy
blocks**, "Busy" by default. The title, the location and the attendees of the meeting stay out.
**With title** adds the title, and **Everything** adds more detail. You choose the level for each
direction, and the line **There:** shows the result.

### What happens to a recurring meeting?

Each occurrence is mirrored on its own. If one occurrence moves, its copy moves. If it is
cancelled, its copy is removed.

### Do I need a server?

No. slotmirror runs today in your own Cloudflare account, on the Workers Free plan. A large team
can need Workers Paid. See [Limits](../../docs/limits/).

## Related guides

- [Show your private calendar as busy at work](../show-private-calendar-as-busy-at-work/)
- [Sync calendars across Microsoft 365 tenants](../sync-multiple-microsoft-365-tenants/)
