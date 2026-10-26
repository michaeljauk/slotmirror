---
title: Sync Outlook and Google Calendar
description: Show your Outlook events in Google Calendar and your Google events in Outlook, as busy blocks or with titles, without a sync service.
sidebar:
  order: 1
---

You have an Outlook calendar for work and a Google calendar for everything else. People who book
you in one calendar do not see the other. This guide makes each calendar show the events of the
other.

## What you get

- Work events appear in Google Calendar, with titles if you want.
- Google events appear in Outlook as "Busy", marked private.
- A moved or cancelled meeting moves or removes its copy within seconds.

## Steps

1. Deploy slotmirror with the [Quickstart](../../docs/quickstart/).
2. Create a [Microsoft Entra app](../../docs/entra-setup/) and a
   [Google OAuth client](../../docs/google-setup/).
3. Set `PUBLIC_URL`, so that changes arrive within seconds.
4. Sign in and connect both accounts under **Accounts**.
5. In **Where your events go**, use **Quick start**: both calendars then block each other as busy.
6. Expand the card of the Outlook account. For the Google target, choose **With title** or
   **Everything**. **Looks like this there** shows the result.
7. Choose **Save**.

## Things to know

- Copies go into the main calendar of each account.
- Events marked private in the source never carry more than "Busy".
- All-day events such as holidays are skipped by default, so they do not block a whole day. To
  mirror them, turn off **Skip all-day events** under **For all calendars**.
