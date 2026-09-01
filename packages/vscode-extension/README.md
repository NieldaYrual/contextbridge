# ContextBridge Codex

**Sync your local code with ContextBridge to carry your code context across every AI chat, automatically.**

ContextBridge Codex is the VS Code and Cursor companion to the [ContextBridge](https://ctxbridge.io) ecosystem — a cross-platform memory bridge that captures your conversations, code, files, and decisions across Claude, ChatGPT, Gemini, and Grok, then brings that context back exactly when your AI needs it.

This extension keeps your local codebase in sync with ContextBridge so that when you ask an AI assistant a question on any platform, it already knows your code.

---

## Features

- 🔄 **Delta sync** — Only changed files are uploaded, keeping syncs fast
- 📂 **Multi-project support** — Sync into one or more ContextBridge projects at once
- 🎯 **Smart include/exclude patterns** — Configurable globs for what to sync
- 🔐 **Secure authentication** — Credentials stored in VS Code's built-in secret storage
- 💻 **Works in Cursor** — Fully compatible with Cursor and other VS Code forks

---

## Getting Started

1. **Install** the extension
2. **Sign in** — Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:
   `ContextBridge: Sign In`
3. **Select your project(s)** — Run `ContextBridge: Select Project` and pick which ContextBridge projects to sync code into
4. **Sync your workspace** — Run `ContextBridge: Sync Entire Workspace`

That's it. From now on, your code is available to any AI chat that uses ContextBridge.

---

## Commands

| Command | Description |
| --- | --- |
| `ContextBridge: Sign In` | Authenticate with your ContextBridge account |
| `ContextBridge: Sign Out` | Clear saved credentials |
| `ContextBridge: Select Project` | Choose which ContextBridge project(s) to sync into |
| `ContextBridge: Sync Current File` | Upload the currently open file |
| `ContextBridge: Sync Entire Workspace` | Run a full delta sync of your workspace |

---

## Configuration

Configure in VS Code Settings under **ContextBridge**:

- **`contextbridge.includedPatterns`** — Glob patterns for files to sync (e.g. `src/**/*`)
- **`contextbridge.excludePatterns`** — Glob patterns to always skip (e.g. `**/node_modules/**`)
- **`contextbridge.apiUrl`** — API endpoint (defaults to `https://api.ctxbridge.io`)

---

## Requirements

- A free [ContextBridge account](https://ctxbridge.io)
- VS Code `1.80.0` or later (also works in Cursor)

---

## Privacy

Your code is uploaded only to ContextBridge projects you explicitly select. Files matching your exclude patterns (including `node_modules`, `.git`, build artifacts, and binaries) are never uploaded. See our [privacy policy](https://ctxbridge.io/privacy) for full details.

---

## Support

- 🌐 Website: [ctxbridge.io](https://ctxbridge.io)
- 📖 Documentation: [ctxbridge.io/how-to-use](https://ctxbridge.io/how-to-use)
- 📧 Contact: support@ctxbridge.io

---

*ContextBridge Codex is part of ContextBridge, released under the MIT License. © 2026 ContextBridge.*