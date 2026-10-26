---
title: Microsoft Entra app
description: Create the Entra app registration that lets slotmirror read and write Microsoft 365 calendars.
---

slotmirror needs an app registration in Microsoft Entra to connect Microsoft 365 and Outlook.com
accounts.

1. In the Microsoft Entra admin center, open **App registrations** and choose **New
   registration**.
2. Supported account types: **Accounts in any organizational directory and personal Microsoft
   accounts**. Choose a single tenant only if every calendar is in your tenant.
3. Redirect URI: platform **Web**, `https://<your-worker>/auth/microsoft/callback`.
4. Under **API permissions**, add the delegated Microsoft Graph permissions `openid`, `email`,
   `profile`, `offline_access`, `User.Read` and `Calendars.ReadWrite`. Users can consent to these
   themselves, unless your tenant blocks user consent.
5. Under **Certificates & secrets**, create a client secret. Note when it expires. The sync stops
   when it expires.
6. Set `MICROSOFT_CLIENT_ID` (the application ID) and `MICROSOFT_CLIENT_SECRET`:

```sh
pnpm wrangler secret put MICROSOFT_CLIENT_ID
pnpm wrangler secret put MICROSOFT_CLIENT_SECRET
```

For a team on Microsoft 365, also see [Organisations](../organisations/): it explains
`ALLOWED_TENANT_IDS`, `SIGN_IN_PROVIDERS` and SCIM.
