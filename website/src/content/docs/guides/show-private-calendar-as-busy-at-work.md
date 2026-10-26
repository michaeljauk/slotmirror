---
title: Show your private calendar as busy at work
description: Block time in your work calendar for private appointments, without colleagues seeing what they are.
sidebar:
  order: 2
---

Colleagues book you for a meeting while you are at the dentist. They cannot see your private
calendar, so they do not know. This guide puts a "Busy" block in your work calendar for each
private appointment, and nothing else.

## Steps

1. Deploy slotmirror with the [Quickstart](../../docs/quickstart/) and connect your work and your
   private account.
2. In **Where your events go**, add both calendars to the group **Block each other**.
3. Expand the card of the private account. Keep **As busy** for the work calendar.
4. Under **For all calendars**, keep **Mark copies as private** on. Colleagues then see
   "Private". You still see everything.
5. Choose **Save**.

## Choose the title of the blocks

The blocks carry the title from **Title of busy blocks**, for example "Busy" or "Blocked". The
title, the location and the attendees of the private appointment do not reach the work calendar.

## For a team

An admin can enforce this for everyone: `MAX_DETAIL_FROM_EXTERNAL=busy` caps every direction
from a private account to a work account at "Busy". See [Organisations](../../docs/organisations/).
