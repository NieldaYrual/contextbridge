# Contributing to ContextBridge

Thanks for your interest! ContextBridge just went open source from a working private prototype, so there's plenty of meaningful work at every level — from cleanup to whole new platform integrations.

## Getting a dev environment running

Follow the [Quick start](./README.md#quick-start) in the README. The short version:

1. `pnpm install` (Node 20+, pnpm 10+)
2. `cp .env.example packages/backend/.env` and fill in Supabase + OpenAI + Anthropic keys
3. Apply `supabase/migrations/*.sql` to your Supabase project
4. `pnpm backend`, then load `packages/chrome-extension` unpacked in Chrome

If the quick start doesn't work for you, **that's a bug** — please open an issue with your OS and where it broke. Onboarding friction reports are some of the most valuable contributions right now.

## What to work on

- Check [open issues](https://github.com/NieldaYrual/contextbridge/issues), especially `good first issue`
- The **Status & roadmap** section of the README lists the bigger directions we'd love help with
- Small fixes (typos, dead code, error messages, type safety) — just send a PR, no issue needed

## Pull requests

- Fork, branch from `main`, keep PRs focused on one change
- Describe **what** and **why** — a sentence each is fine
- For larger changes (new platform support, schema changes, new packages), open an issue first so we can agree on the approach before you invest the time
- CI/tests are still sparse (see roadmap) — at minimum, describe how you verified your change

## Ground rules

- **Never commit real conversation data, tokens, or `.env` files.** The `.gitignore` guards the known paths, but captures and logs can end up in odd places — check your diff before pushing.
- Be kind. This is a small project; assume good faith.

## Security

If you find a vulnerability, please email support@ctxbridge.io rather than opening a public issue.
