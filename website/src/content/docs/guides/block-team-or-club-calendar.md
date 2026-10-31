---
title: Block time for a team or club schedule
description: Turn a subscribed team, club or school calendar into busy blocks in your work calendar, so that matches and training are never double-booked.
sidebar:
  order: 4
---

Your club, team or school publishes a schedule, and you subscribe to it in Google Calendar or
Outlook. Your work calendar does not know about it. This guide blocks every entry of that
schedule in your other calendars.

## Steps

1. Subscribe to the schedule in the account where you already have it, for example Google
   Calendar.
2. Deploy slotmirror with the [Quickstart](../../docs/quickstart/) and connect that account and
   your work account.
3. In **Where your events go**, expand the card of the account with the schedule.
4. Under **Calendars from …**, turn on the schedule next to the main calendar.
5. Keep **As busy** for the work calendar, or choose **With title** if colleagues may see "Home
   match".
6. Choose **Save**.

## Things to know

- The schedule is a source only. Blocks go into the main calendar of each target account.
- **Skip all-day events** is off by default, so all-day entries such as tournament days block the
  whole day. Entries that are marked as free stay out. To leave out all all-day entries, turn the
  setting on under **For all calendars**. The setting applies to all your calendars.
