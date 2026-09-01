# ContextBridge

> **Conversation memory for LLMs** — capture, store, and intelligently re-inject context across AI conversations and platforms.

Every AI chat starts from zero. ContextBridge fixes that: a Chrome extension captures your conversations on Claude.ai and ChatGPT, a backend builds a knowledge graph and semantic index over them, and when you start a new conversation, precisely the right context gets injected — regardless of which platform you're on.

<!--
  DEMO GIF — drop the file at docs/demo.gif, then uncomment the two lines below.
  Kept commented so the public README shows no broken image until the file exists.

<p align="center">
  <img src="docs/demo.gif" alt="ContextBridge: capturing a conversation, then a new chat auto-loading the relevant context" width="720">
</p>

-->
<!-- Shot list for the recording (aim for 8–12s, loops cleanly):
     1. A finished Claude.ai/ChatGPT chat — the ContextBridge widget shows it was captured.
     2. Open a brand-new chat on the OTHER platform (show cross-platform).
     3. Type a question that depends on the earlier chat's context.
     4. The relevant prior context is injected; the model answers correctly.
     Record at ~1280px wide, then downscale; keep it under ~5 MB so it loads fast. -->


## How it works

```
┌──────────────────┐     ┌─────────────────────┐     ┌──────────────────┐
│ Chrome extension  │────▶│  Backend (Express)  │────▶│    Supabase      │
│ capture/injection │     │  extraction,        │     │  conversations,  │
│ on Claude/ChatGPT │◀────│  summarization,     │◀────│  entities,       │
└──────────────────┘     │  semantic search    │     │  embeddings      │
┌──────────────────┐     └─────────────────────┘     └──────────────────┘
│ VS Code extension │────▶ syncs local code context
│    ("Codex")      │      into the same store
└──────────────────┘
```

1. **Capture** — the Chrome extension observes your Claude.ai / ChatGPT sessions and ships each conversation to the backend.
2. **Understand** — the backend extracts entities and concepts, links related conversations, generates summaries, and embeds everything for semantic search (OpenAI embeddings + Anthropic/Ollama for extraction).
3. **Retrieve & inject** — when you start a new conversation, the extension asks the backend for the most relevant context and injects it into your prompt.

## Repository layout

| Package | What it is |
|---|---|
| `packages/backend` | Node.js/Express API — capture ingestion, entity extraction, knowledge graph, semantic search |
| `packages/chrome-extension` | The capture/injection extension (Manifest V3, plain JS) |
| `packages/vscode-extension` | "Codex" — syncs local code context into ContextBridge |
| `packages/shared` | Shared utilities (retry-fetch, etc.) |
| `packages/scraper` | Puppeteer-based scraping workers (Bull/Redis queues) |
| `packages/capture` | Standalone capture tooling |
| `packages/website` | Landing page / docs site (static) |
| `supabase/` | Database migrations and edge functions |

## Quick start

**Prerequisites:** Node 20+, [pnpm](https://pnpm.io) 10+, a [Supabase](https://supabase.com) project (free tier works, or `supabase start` locally), an OpenAI API key (embeddings) and an Anthropic API key (extraction/summarization). Redis is only needed for the scraper queues — you can skip it at first.

```bash
git clone https://github.com/NieldaYrual/contextbridge.git
cd contextbridge
pnpm install

# Configure the backend
cp .env.example packages/backend/.env
#   → fill in SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY

# Apply database migrations to your Supabase project
supabase db push        # or run supabase/migrations/*.sql in the SQL editor

# Start the backend (http://localhost:3000)
pnpm backend
```

**Load the Chrome extension:**

1. Open `chrome://extensions`, enable **Developer mode**
2. **Load unpacked** → select `packages/chrome-extension`
3. Open the extension options and point it at your backend URL
4. Visit claude.ai or chatgpt.com and have a conversation — it should appear in your Supabase `conversations` table

All env vars (required and optional) are documented in [`.env.example`](./.env.example).

## Development

```bash
pnpm dev          # run all packages in parallel watch mode
pnpm backend      # backend only (tsx watch)
pnpm build        # build everything
pnpm --filter contextbridge-chrome-extension build   # build the extension into dist/
```

## Status & roadmap

This project is being opened up from a working private prototype. It runs, it's used daily, and it has rough edges — that's exactly where you come in.

I'd love contributions in the following areas.

**Good first issues** — self-contained, a great way in:

- [ ] Consolidate env var naming (`SUPABASE_SERVICE_KEY` vs `SB_SERVICE_ROLE` vs `SUPABASE_SERVICE_ROLE_KEY` are all read in different places)
- [ ] MS Edge / Firefox / Safari support for the extension
- [ ] Keep the [ctxbridge.io](https://www.ctxbridge.io) site (frontend under `packages/website`) up to date as new features ship

**Features & fixes:**

- [ ] Local-first mode — Ollama embeddings, no cloud keys required
- [ ] Fix auto-context selection — resolve the token-budget issue, add a launch-on-demand mode, verify the disable toggle actually works, and enrich replies with better context
- [ ] Improve memory retrieval — time-based (last-in-first-out) recall, better location of specific tidbits in past conversations, and higher-accuracy document retrieval (code, code blocks, Markdown, Word, Excel) that pinpoints the exact passage needed rather than the whole file
- [ ] Make a Claude Code and OpenAI Codex version
- [ ] Add local folders and personal repos as context sources for chat models (Dropbox, Box, OneNote, etc.)

**Bigger picture:**

- [ ] ContextBridge was built for coding, but the same idea is just as useful for other professions — legal, finance, real estate, and more. Adapters, prompts, and domain-specific retrieval for these are wide open.

And beyond this list: if you can think of anything that would make ContextBridge more useful to a wider range of people, propose it — open an issue to start the conversation. This roadmap is a starting point, not a boundary.

## Contributing

Issues and PRs welcome. Check the [good first issue](https://github.com/NieldaYrual/contextbridge/labels/good%20first%20issue) label for approachable entry points, and see [CONTRIBUTING.md](./CONTRIBUTING.md) for how to get a dev environment running and what to expect from review.

## License

[MIT](./LICENSE) — do whatever you want with it; a link back is appreciated.
