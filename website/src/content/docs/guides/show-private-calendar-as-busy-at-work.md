---
title: Show your private calendar as busy at work
description: Block time in your work calendar for private appointments, without colleagues seeing what they are.
sidebar:
  order: 2
---

Colleagues book you for a meeting while you are at the dentist. They cannot see your private
calendar, so they do not know. This guide puts a "Busy" block in your work calendar for each
private appointment, and nothing else.

## Why adding the calendar to Outlook is not enough

You can add a private calendar to Outlook, by subscription or by sharing. Then you see your
private appointments next to your work. Colleagues who check when you are free still see only
your work calendar. Blocks that you copy by hand go out of date when an appointment moves.

slotmirror writes one block into your work calendar for each private appointment, and it moves
or removes the block when the appointment changes.

## Steps

1. Deploy slotmirror with the [Quickstart](../../docs/quickstart/) and connect your work and your
   private account.
2. On the **Rules** page, add both calendars to the group **Block each other**.
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

## Questions

### Can colleagues see what the appointment is?

No. A block carries the title from **Title of busy blocks**, "Busy" by default. **Mark copies as
private** is on by default, so colleagues who can open your calendar see "Private" instead.
Colleagues who only check when you are free see that you are busy. The title, the location and
the attendees of the appointment stay in your private calendar.

### Who holds the access to my private calendar?

The operator of the deployment. If you deploy slotmirror yourself, the tokens are in your own
Cloudflare account. If your employer runs the deployment, they are in its account. The `/privacy`
page of the deployment shows the contact of the operator, if the operator set one. See
[Privacy and data location](../../docs/privacy/).

### What about holidays and days off?

All-day events block the whole day by default. Events that are marked as free stay out. To leave
out all all-day events, turn on **Skip all-day events** under **For all calendars**.

## Related guides

- [Sync Outlook and Google Calendar](../sync-outlook-and-google-calendar/)
- [Block time for a team or club schedule](../block-team-or-club-calendar/)
