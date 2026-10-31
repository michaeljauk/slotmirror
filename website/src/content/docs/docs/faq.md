---
title: FAQ
description: Common questions about slotmirror.
---

## Does it cost anything?

slotmirror is free and MIT-licensed. It runs on the Cloudflare Workers Free plan. A large team can
need Workers Paid ($5 a month). See [Limits](../limits/).

## Can the people who see my work calendar read my private events?

Not unless you choose so. In the group **Block each other**, each calendar sees the others only as
"Busy", marked private. More detail is a choice per direction. Events marked private in the source
never carry more than "Busy".

## What happens to a moved occurrence of a recurring meeting?

Each occurrence is mirrored on its own. If one occurrence moves, its block moves. If it is
cancelled, its block is removed.

## How fast does a change arrive?

With `PUBLIC_URL` set, when Microsoft or Google notify the Worker. Without it, at the next run,
after up to 10 minutes. We have not measured the delay yet. See
[Push notifications](../push-notifications/).

## Can I add more than one calendar of an account?

Yes, as sources. Next to the main calendar, you can turn on other calendars of the account, for
example a subscribed team schedule. Blocks always go into the main calendars.

## What happens when I delete a rule?

Its blocks from today on are removed in the background. Blocks before today stay.

## Does it support iCloud?

Not yet. Microsoft 365 and Google Calendar are supported.

## Why is there a "not verified" warning from Google?

Your OAuth client is your own, and Google has not verified it. To continue, choose **Advanced**,
then **Go to … (unsafe)**. slotmirror shows this before the redirect. If the app is in **Testing**
mode, Google also expires its refresh tokens after 7 days. See
[Google OAuth client](../google-setup/).

## Who is the operator, and what does the role include?

The operator is the person or company that deploys slotmirror. There is no slotmirror service in
between. The operator owns the Cloudflare account, so the tokens, the rules and the activity log
are in the operator's account. The operator sets `PRIVACY_CONTACT`, the contact on the `/privacy`
page. See [Privacy and data location](../privacy/).

## Why does Microsoft ask for consent, and what if my tenant blocks it?

The Microsoft app asks to read and write your calendars. Users can consent themselves, unless
the tenant blocks user consent. Then a tenant admin must grant consent once. See
[Microsoft Entra app](../entra-setup/).

## Where are my tokens?

In the Durable Object of each account, in your Cloudflare account, encrypted with AES-256-GCM.
See [Privacy and data location](../privacy/).
