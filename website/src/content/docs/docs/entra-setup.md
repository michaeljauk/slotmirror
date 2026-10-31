---
title: Microsoft Entra app
description: Create the Entra app registration that lets slotmirror read and write Microsoft 365 calendars.
---

slotmirror needs an app registration in Microsoft Entra to connect Microsoft 365 and Outlook.com
accounts.

## Check first: can I approve the app myself?

A work or school tenant decides whether its users may approve apps. If it does not, the first
sign-in stops with a consent error, and an administrator of that tenant has to approve the app.
Check this before you ask people to connect their calendars:

1. Sign in to the Microsoft Entra admin center of the tenant whose calendars you connect.
2. Open **Enterprise applications**, then **Consent and permissions**, then **User consent
   settings**.
3. If users may not consent to apps, or only to apps from verified publishers, an administrator
   has to approve slotmirror for the tenant. This is possible after you create the app below. The
   app then shows a request that you can copy. See
   [Troubleshooting](../troubleshooting/#aadsts65001).

A personal Microsoft account approves for itself.

## Create the app registration

1. In the Microsoft Entra admin center, open **App registrations** and choose **New
   registration**.
2. Supported account types: **Accounts in any organizational directory and personal Microsoft
   accounts**. Choose a single tenant only if every calendar is in your tenant.
3. Redirect URI: platform **Web**, `https://<your-worker>/auth/microsoft/callback`. The approval
   link for administrators returns to the same address, so it needs no second redirect URI.
4. Under **API permissions**, add the delegated Microsoft Graph permissions `openid`, `email`,
   `profile`, `offline_access`, `User.Read` and `Calendars.ReadWrite`. Users can consent to these
   themselves, unless your tenant blocks user consent (see the check above).
5. Optional: under **Token configuration**, add the optional claims `email` and `xms_edov` to
   the ID token. slotmirror then signs in a user under their email address if their tenant
   verified its domain. Without them, new users sign in under their user principal name;
   existing users keep their address.
6. Under **Certificates & secrets**, create a client secret. Entra shows its expiry date. Choose
   the longest lifetime the portal offers, and put the expiry date in your calendar a few weeks
   ahead. When the secret expires, token refreshes fail and the sync stops. Before that date,
   create a new secret and replace `MICROSOFT_CLIENT_SECRET` with its value. Copy the value
   when you create it: Entra shows it only once.
7. Set `MICROSOFT_CLIENT_ID` (the application ID) and `MICROSOFT_CLIENT_SECRET` as secrets. In
   the Cloudflare dashboard, open your Worker, **Settings**, **Variables and Secrets**. With a
   clone, you can run `pnpm wrangler secret put <NAME>` instead.

Set `ALLOWED_TENANT_IDS` to restrict Microsoft sign-in to your tenants. For a team on Microsoft
365, also see [Organisations](../organisations/): it explains `ALLOWED_TENANT_IDS`,
`SIGN_IN_PROVIDERS` and SCIM.
