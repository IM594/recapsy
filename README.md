<div align="center">

# Recapsy

**Give your AI agent a work memory that never lies to you.**

[English](README.md) · [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](#how-it-works)
[![Status: in development](https://img.shields.io/badge/status-in%20development-orange.svg)](#status)

</div>

Recapsy records your Mac screen, reads the text on it, and keeps all of it on your machine. The agent you already use, whether Claude Code, Cursor, Codex or anything else that speaks MCP, asks Recapsy what you were doing and gets answers with the screenshot, the original text and the time attached.

- **The desktop app is free and open source, forever.** Nothing leaves your Mac.
- **A cloud tier funds the project.** Sync, hosted models, backup and asking from your phone will be a subscription.
- **Anything that was free stays free.**

## Why

Ten minutes before a review you ask your agent "what did I work on this week?" and get talking points with real detail: which files, which threads, which afternoon. Without Recapsy that is an hour in git, Slack and Notion. The same move covers year-end reviews, and the everyday case where an agent starts a task by asking where you left off in a project.

## It never lies to you

Screen recorders drop frames, compress history and delete quietly. Recapsy makes four promises none of them make.

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

Everything that runs on every frame runs on your Mac and costs nothing. Summaries run once a day on a model you configure, any OpenAI-compatible endpoint or a local Ollama, and everything else works without them. Anything you ask on demand goes through your own agent over MCP, so there is no chat UI. OCR is PP-OCR on device, scheduled to stay inside the "Low" energy band in Activity Monitor. macOS only.

What ships in 1.0 and what does not: [docs/roadmap.md](docs/roadmap.md).

## Status

Under development, not yet released. Watch the repository for the first release. To join the cloud tier waitlist, open a [discussion](https://github.com/IM594/recapsy/discussions).

`main` started from a clean history on 2026-09-08. Prototypes back to 2025-12 are kept under the tag `archive/prototypes-2026-09`.

## Contributing

Bugs go through the issue form, features start as a discussion. Workflow and code rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
