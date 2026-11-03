---
title: Self-hosted calendar sync for Outlook and Google
description: Run your own busy-time sync between Microsoft 365 and Google calendars, so that no sync service holds the access to your calendars.
sidebar:
  order: 5
---

A calendar sync service needs access to every calendar that you connect. It holds a token for
each account, and it can read your events. With slotmirror, you deploy the sync into your own
Cloudflare account. There is no slotmirror service between your calendars and your deployment.

## What stays in your account

- **The tokens.** Each connected account has an OAuth token, encrypted with AES-256-GCM. The key
  is a secret that you set.
- **The account data.** The email address of each user, the names of the calendars and, for
  Microsoft accounts, the tenant ID and the object ID.
- **The rules and the activity log.** The log has times, counts and error codes, and no event
  content.
- **No event content.** Titles, descriptions, locations and attendees are read during a sync and
  kept only in memory. They are not written to the database. One exception: if blocks cannot be
  removed, their title stays for 90 days, so that someone can delete them by hand. See
  [Delete data](../../docs/privacy/#delete-data).

You can keep the data in the EU. See [Privacy and data location](../../docs/privacy/).

## What you need

- A Cloudflare account. slotmirror runs today on the Workers Free plan. A large team can need
  Workers Paid. See [Limits](../../docs/limits/).
- Your own [Microsoft Entra app](../../docs/entra-setup/) for Microsoft 365 and Outlook.com, and
  your own [Google OAuth client](../../docs/google-setup/) for Google Calendar. You need only the
  ones for the calendars that you connect.

The [Quickstart](../../docs/quickstart/) covers the deployment, the apps and the first rules.

## What you take on

Self-hosting moves some work from a service to you:

- **Google shows a warning.** Until Google verifies your OAuth client, it warns that the app is not
  verified. slotmirror shows a notice about this before the redirect. If the client stays in
  **Testing** mode, Google expires its refresh tokens after 7 days. See
  [Google OAuth client](../../docs/google-setup/).
- **Secrets expire.** The client secret of the Entra app has an expiry date. If it expires, token
  refreshes fail and the sync stops. Before that date, you create a new secret.
- **Updates are yours.** You choose when your deployment moves to a new version. See
  [Updating your deployment](../../docs/updating/).
- **It is an early version.** The version is below 1.0. Settings and the database can still change
  between releases.

## Run it for others

If you deploy slotmirror for a team, you are its operator. The tokens of every member are then in
your Cloudflare account. Set `OPERATOR_NOTICE` to say who runs the deployment and what you can
see. Members see this notice before they connect an account. See
[Settings reference](../../docs/settings/).

To limit sign-in to your tenant, you need three settings together. See
[Limit who signs in](../../docs/organisations/#limit-who-signs-in). An admin can also cap the
detail between work and private calendars.

## Related guides

- [Sync Outlook and Google Calendar](../sync-outlook-and-google-calendar/)
- [Show your private calendar as busy at work](../show-private-calendar-as-busy-at-work/)
