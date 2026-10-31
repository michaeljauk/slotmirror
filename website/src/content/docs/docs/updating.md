---
title: Updating your deployment
description: Move a running slotmirror deployment to a newer version, and go back if you must.
---

A deployment does not update itself. You pull the new code into your repository and deploy it.
Your data stays in your D1 database. Your secrets and dashboard variables stay in your Cloudflare
account.

## What a deploy does

`pnpm run deploy` runs two commands in this order:

1. `wrangler d1 migrations apply DB --remote` changes the database.
2. `wrangler deploy` uploads the new code.

The migrations run before the code. If a migration fails, the second command does not run, and the
old code keeps running. A migration that succeeded stays applied.

A plain `wrangler deploy` skips the migrations. Do not use it for an update.

## If you used the deploy button

If you deployed before the `vars` block was removed, read
[the section on earlier deployments](#if-you-deployed-before-the-vars-block-was-removed) before
you merge.

Cloudflare created a new repository in your GitHub or GitLab account and connected it to your
Worker. The repository has no automatic link to the slotmirror repository. You add the link
yourself.

1. In a clone of your repository, add the slotmirror repository as a remote:

   ```sh
   git remote add upstream https://github.com/michaeljauk/slotmirror
   git fetch upstream
   ```

2. Merge the new code into your branch and push it:

   ```sh
   git merge upstream/main
   git push
   ```

   If you changed files, for example `wrangler.jsonc`, Git can report a conflict. Resolve it before
   you push. Keep your own `database_id` and `database_name`.

3. In the dashboard, open **Workers & Pages**, your Worker, **Settings**, **Builds**. Check that the
   build is connected to your repository. Enter `pnpm run deploy` as the deploy command, because
   that command runs the migrations. The command `npx wrangler deploy` does not.

4. If a push does not start a build, deploy from a clone as shown below.

## If you cloned the repository

If you deployed before the `vars` block was removed, read
[the section on earlier deployments](#if-you-deployed-before-the-vars-block-was-removed) before
you deploy.

```sh
cd slotmirror
git pull
pnpm install --frozen-lockfile
pnpm run deploy
```

Run `pnpm wrangler login` first if your session expired. `pnpm run deploy` needs your own
`database_id` in `wrangler.jsonc`. If `git pull` reports a conflict on that file, keep your
`database_id`.

## If you deployed before the `vars` block was removed

An earlier `wrangler.jsonc` had a `vars` block. It listed `ORG_NAME`, `ALLOWED_EMAILS`,
`ALLOWED_DOMAINS`, `ALLOWED_TENANT_IDS`, `ADMIN_EMAILS`, `PRIVACY_CONTACT`, `SIGN_IN_PROVIDERS`,
`PUBLIC_URL`, `DATA_JURISDICTION`, `MAX_DETAIL_TO_EXTERNAL`, `MAX_DETAIL_FROM_EXTERNAL` and
`TIME_ZONE`. Each deploy replaced the dashboard value of every name in that block. This included a
name with an empty value.

Now `wrangler.jsonc` has no `vars` block and sets `keep_vars`. A deploy keeps the dashboard values
that the file does not name. Without `keep_vars`, a deploy removes dashboard variables, and it
overwrites the variables that the file lists. Set your values in the dashboard before you update.

1. Write down your values. Read them from the `vars` block in your `wrangler.jsonc`, or from
   **Variables and Secrets** in the dashboard. A deploy from the old file may have replaced a
   dashboard value with an empty one. If a value is missing in the dashboard, enter it again.
2. In **Variables and Secrets**, add each value as a **Text** variable with the same name. Do this
   before you deploy the new version.
3. Update as described above. If the merge conflicts on the `vars` block, take the new file and
   remove the block. Keep your own `database_id` and `database_name`.
4. Open your Worker. Check the values you rely on, for example who can sign in.

Take care of these two values:

- `DATA_JURISDICTION`: if its value changes for existing data, every account disconnects. Set the
  same value as before. See [Settings](../settings/).
- `TIME_ZONE`: the old file set `UTC`. If you did not set another zone, no action is needed. The
  default is `UTC`.

This page does not state what Cloudflare does with a value that an earlier deploy set from the
file and that the dashboard does not hold. Do not rely on it. Set the value in the dashboard.

If you want a value in the file again, add a `vars` entry. Then use the file for that name and not
the dashboard. The file value replaces the dashboard value on every deploy.

## All-day events are mirrored by default

New rules now mirror all-day events, unless the events are marked as free. Rules from the editor
keep their behavior, because each rule stores `skipAllDay` in `rules.options`. The **Skip all-day
events** switch stays on for a user with a rule that skips these events, and that user's new rules
skip them too. A save changes the rules only if the user changes this switch. Then every rule of
the user follows it.

If such a user never saved the settings and removes their last rule, the switch goes off. Turn it
on again before you add a rule, or the new rule mirrors all-day events.

A rule without `skipAllDay` in `rules.options` starts to mirror all-day events after the update. The
editor never writes such a rule. It can come from your own SQL, because `options` defaults to `{}`.
To keep the old behavior, add `"skipAllDay": true` to the row before you update.

All-day blocks in Outlook now lie in the time zone of the mailbox, if Microsoft Graph names that
zone. slotmirror reads the zone once per day from the working hours of the mailbox, and this needs
no new permission. If the mailbox names no usable zone, the blocks use UTC as before. If the read
fails, the blocks keep the last known zone, or use UTC if no zone is known. slotmirror reads the
zone again after 15 minutes.

Two other cases also use UTC:

- If Graph refuses an all-day write with status 400, and no other all-day write of the same batch
  passes, the blocks use UTC for the day.
- If a sync step has too few requests left for the read, its blocks use the last known zone, or UTC
  if no zone is known.

The Graph documentation says that `getSchedule`, the call behind this read, does not support
personal Microsoft accounts. So all-day blocks on personal accounts probably stay in UTC. We did not
test this on a live personal account.

Existing blocks stay as they are, and a block written in UTC also stays that way. Such an all-day
block stays off the local day, by one hour at CET and by eight hours at Pacific time, until its
content changes.

## After the update

Open your Worker and sign in. If a checklist shows instead of the sign-in page, a variable or secret
is missing. The checklist names it. See the [settings reference](../settings/).

## Going back to an older version

Migrations do not run backward. After an update, the database keeps the new tables and columns,
also when you deploy older code.

1. Clone your repository to your computer and run `pnpm install`. If you used the deploy button,
   you need this step, because the build in the dashboard cannot deploy an older version for you.
   Check out the commit or tag of the older version.
2. Run `pnpm wrangler deploy`. The older folder `migrations/` holds only migrations that already ran,
   so no migration is needed.
3. Open your Worker and check that sign-in and sync work.

If the older version is from before the `vars` block was removed, its `wrangler.jsonc` lists the
`vars` block again. That deploy overwrites the dashboard values of every name in the block, also
with an empty value. Write down your values first, and set them again after the deploy.

The older code runs on the newer database. This works only if the migrations between the two
versions add tables or columns and remove nothing. All migrations up to now do this. A later
migration can differ. Before you go back across versions, read the [changelog](/changelog/) for
every version in between.

Before an update, you can export a copy of your D1 database:

```sh
pnpm wrangler d1 export <database_name> --remote --output backup.sql
```

Use the `database_name` from your `wrangler.jsonc`. The default is `slotmirror`.

The file holds sign-in addresses and calendar names. Store it with care. It does not include the
state of the Durable Objects, where each connected account keeps its tokens and its mappings.
