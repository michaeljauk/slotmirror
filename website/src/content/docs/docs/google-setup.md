---
title: Google OAuth client
description: Create the Google OAuth client that lets slotmirror read and write Google calendars.
---

slotmirror needs an OAuth client in Google Cloud to connect Google accounts.

1. In the Google Cloud console, create a project and enable the **Google Calendar API**.
2. In **Google Auth Platform**, fill in **Branding**: the app name, the address of your Worker as
   home page, `https://<your-worker>/privacy` as privacy policy, and the domain of your Worker as
   authorized domain.
3. Under **Data access**, add the scopes `openid`, `email`, `profile`,
   `https://www.googleapis.com/auth/calendar.events` and
   `https://www.googleapis.com/auth/calendar.calendarlist.readonly`.
4. Under **Audience**, publish the app to **In production**.
5. Under **Clients**, create a **Web application** client with the redirect URI
   `https://<your-worker>/auth/google/callback`.
6. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as secrets. In the Cloudflare dashboard,
   open your Worker, **Settings**, **Variables and Secrets**. With a clone, you can run
   `pnpm wrangler secret put <NAME>` instead.

:::caution[Testing mode expires tokens]
If the app stays in **Testing**, Google expires refresh tokens after 7 days. The account then
shows a notice to connect it again.
:::

Until Google verifies the app, users see a warning that the app is not verified. For your own
deployment, you can continue past it.
