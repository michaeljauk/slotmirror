---
title: FAQ
description: Common questions about slotmirror.
---

## Does it cost anything?

slotmirror is free and licensed under the AGPL-3.0. It runs on the Cloudflare Workers Free plan. A large team can
need Workers Paid ($5 a month). See [Limits](../limits/).

## What does the AGPL mean for me?

This is a plain-words summary, not legal advice. The license text in the
[LICENSE](https://github.com/michaeljauk/slotmirror/blob/main/LICENSE) file is the only binding
source.

- **You run slotmirror for yourself or your team, unchanged.** You can use it, copy it and deploy
  it. Nothing else is required.
- **You change the code and let other people use your version over a network.** Section 13 of the
  license applies: you must offer those users the source code of your changed version, under the
  AGPL.
- **You pass the code on, changed or not.** You must pass it on under the AGPL and keep the
  copyright and license notices.

## Can a company use slotmirror?

Yes. The AGPL does not forbid commercial or company use. A company that deploys slotmirror
unchanged for its own staff has the same terms as everyone else. If a company changes the code,
or wants to offer slotmirror as part of a product or service to others, it must read the license
text, in particular section 13, and decide with its own legal advisers whether its plan fits.
Some companies do not allow AGPL software at all. Check your own policy first.

## What about the earlier MIT license?

Code up to and including commit `93ce752` was published under the MIT license, and that stays
valid for that code. You can still use that version under the MIT terms. All later changes are
under the AGPL-3.0. The MIT text is in
[LICENSE-MIT](https://github.com/michaeljauk/slotmirror/blob/main/LICENSE-MIT).

## Can the people who see my work calendar read my private events?

Not unless you choose so. In the group **Block each other**, each calendar sees the others only as
"Busy", marked private. More detail is a choice per direction. Events marked private in the source
never carry more than "Busy".

## What happens to a moved occurrence of a recurring meeting?

Each occurrence is mirrored on its own. If one occurrence moves, its block moves. If it is
cancelled, its block is removed.

## How fast does a change arrive?

With `PUBLIC_URL` set, usually within seconds. See [Push notifications](../push-notifications/).

## Can I add more than one calendar of an account?

Yes, as sources. Next to the main calendar, you can turn on other calendars of the account, for
example a subscribed team schedule. Blocks always go into the main calendars.

## What happens when I delete a rule?

Its blocks from today on are removed in the background. Blocks before today stay.

## Does it support iCloud?

Not yet. Microsoft 365 and Google Calendar are supported.

## Why is there a "not verified" warning from Google?

Your OAuth client is your own, and Google has not verified it. For your own deployment, you can
continue past the warning. See [Google OAuth client](../google-setup/).

## Where are my tokens?

In the Durable Object of each account, in your Cloudflare account, encrypted with AES-256-GCM.
See [Privacy and data location](../privacy/).
