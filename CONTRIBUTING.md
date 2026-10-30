# Contributing

Thanks for your interest in slotmirror. Bug reports, fixes, docs and translations are welcome.

## Before you start

- For a bug, open an issue with the bug form. Include the provider (Microsoft 365 or Google), the
  kind of event (single, recurring, moved occurrence, all-day) and what you expected.
- For a larger change, open an issue first so that we can agree on the approach.
- Security problems: do not open an issue. See [SECURITY.md](SECURITY.md).

## Your first pull request

slotmirror is licensed under the [AGPL-3.0](LICENSE). Before we can merge your first pull request,
you must sign the [Contributor License Agreement](CLA.md). The CLA bot comments on your pull
request with a link. You sign once, in a comment, and the bot remembers it for later pull
requests. The CLA lets the maintainer distribute your change under the AGPL-3.0 and, if needed,
under other license terms. You keep the copyright of your change.

## Development

Requirements: Node.js 22 or later, pnpm 10.

```sh
pnpm install
cp .dev.vars.example .dev.vars   # fill in the values
pnpm db:migrate:local
pnpm dev
```

`pnpm check` runs formatting, lint, typecheck and tests. It must pass before you open a pull
request. The pre-commit hook runs the fast part of it.

Agents and humans follow the same project rules; they are in [AGENTS.md](AGENTS.md).

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `fix(sync): keep moved
  occurrences of recurring events`. The commit-msg hook checks this.
- Keep a pull request to one topic. Add or update tests for every behavior change.
- Pull requests are squash-merged, so the PR title must follow the same format.
- New user-facing text needs an entry in every catalog in `src/i18n/`.

## Translations

Add a file to `src/i18n/` that matches the shape of `en.ts`, register it in `src/i18n/index.tsx`,
and run `pnpm test`.

## Maintainer

The project currently has one maintainer, who reviews and merges pull requests and cuts releases.
Releases are automated from the commit history with release-please.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
