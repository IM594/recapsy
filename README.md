<div align="center">

# Recapsy

**Everything you do on your Mac, remembered. Nothing leaves unless you say so.**

[English](README.md) · [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](#how-it-works)
[![Status: in development](https://img.shields.io/badge/status-in%20development-orange.svg)](#status)

</div>

Recapsy keeps a local record of what you're working on, moment by moment, and answers when you or your agent ask about any of it. Today you ask through Claude Code, Cursor or Codex over MCP, and every answer comes with the screenshot, the original text and the time.

> “Compare me now with me three months ago. Positive and negative changes, with data.”
>
> “What did I actually finish this week? Show me the screenshots.”
>
> “What was I reading yesterday afternoon before the call?”

- **The desktop app is free and open source, forever.** Nothing leaves your Mac unless you opt into the cloud tier.
- **A cloud tier funds the project.** Sync, hosted models, backup and asking from your phone will be a subscription.
- **Anything that was free stays free.**

## Why

Ten minutes before a review you ask "what did I work on this week?" and get talking points with real detail: which files, which threads, which afternoon. Without Recapsy that is an hour in git, Slack and Notion. Because it has seen every day, bigger questions work too: how your work changed over a quarter, and what the evidence is. And an agent starting a task can first ask where you left off.

## It never lies to you

Four promises about your data.

| Promise | What it means |
|---------|---------------|
| **Gaps are visible** | Every time window has a screenshot or a recorded reason there is none. If capture stops, you are told. |
| **Originals stay** | Any moment's screenshot and recognized text can be pulled up and checked against an answer. |
| **Nothing is deleted silently** | Retention follows rules you can see and change. |
| **Every answer cites its source** | Screenshot, original text and timestamp travel with each response. |

## How it works

```
 screen ──▶ Swift capture ──▶ PP-OCR (on device) ──▶ SQLite + full-text + vectors
                                                            │
                          session / daily / weekly summaries (your model, optional)
                                                            │
                                              MCP server ──▶ Claude Code · Cursor · Codex
                                                            │
                                              Daily review page (for humans)
```

Capture, OCR and indexing run on your Mac. Summaries run once a day on a model you configure, any OpenAI-compatible endpoint or a local Ollama, and everything else works without them. Questions go through your own agent over MCP, so there is no chat window to learn. OCR is PP-OCR on device, scheduled to keep energy impact at "Low" in Activity Monitor. macOS only.

What ships in 1.0 and what does not: [docs/roadmap.md](docs/roadmap.md).

## Status

Under development, not yet released. Watch the repository for the first release. To join the cloud tier waitlist, open a [discussion](https://github.com/IM594/recapsy/discussions).

`main` started from a clean history on 2026-09-08. Prototypes back to 2025-12 are kept under the tag `archive/prototypes-2026-09`.

## Contributing

Bugs go through the issue form, features start as a discussion. Outside pull requests are not merged until the first release. Workflow and code rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
