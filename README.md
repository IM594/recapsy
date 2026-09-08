<div align="center">

# Recapsy

**Give your AI agent a work memory that never lies to you.**

Local screen memory for macOS, built for the agents you already use.

[English](README.md) · [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](#requirements)
[![Status: in development](https://img.shields.io/badge/status-in%20development-orange.svg)](#status)
[![DCO](https://img.shields.io/badge/DCO-signed--off-green.svg)](DCO)

</div>

---

- **The desktop app is free and open source, forever.** Everything runs on your Mac. Not a single byte leaves it.
- **A cloud tier funds the project.** Multi-device sync, hosted models, backup and asking from your phone will be a subscription.
- **Anything that was free stays free.** Paid features are only ever added, never moved behind a wall.

> Recapsy is under active development and has not shipped yet. Star or watch the repository to be notified of the first release. To join the cloud tier waitlist, open a [discussion](https://github.com/IM594/recapsy/discussions).

## Why Recapsy

Ten minutes before a review meeting your head is empty. You ask your agent, via MCP, "what did I work on this past week?" Three minutes later you have talking points with real detail: which files, which threads, which afternoon. Without Recapsy that is an hour of digging through git, Slack and Notion.

The same move covers mid-year and year-end reviews, and the everyday case where an agent starts a task and first asks "where did this person leave off in this project?"

Recapsy is not another timeline to scroll through. Its primary interface is the agent you already run: Claude Code, Cursor, Codex, or anything that speaks MCP.

## It never lies to you

Every screen recorder eventually drops frames, compresses history or deletes quietly. Recapsy makes four promises that none of them make.

| # | Promise | What it means |
|---|---------|---------------|
| 1 | **Gaps are visible** | Every time window has either a screenshot or a recorded reason there is none. If capture stops, you are told. |
| 2 | **Originals stay** | The screenshot and the recognized text from any moment can be pulled up and checked against an answer. |
| 3 | **Nothing is deleted silently** | Retention follows rules you can see and change. |
| 4 | **Every answer cites its source** | Screenshot, original text and timestamp travel with each response, so an agent can quote them verbatim. |

## How it works

Every idea in Recapsy is sorted by how often it runs. The rhythm decides where it runs and who pays.

| Rhythm | Runs on | Cost to you | What it means for the product |
|--------|---------|-------------|-------------------------------|
| **Every frame**: capture, OCR, indexing | Your Mac | Nothing | Strictly local. Zero upload. |
| **Once a day**: session, daily and weekly summaries | A model you configure, or one we host | Free with your own key; hosted is paid | The only thing the cloud tier charges for |
| **Whenever you ask**: weekly reports, habit analysis, anything | Your own agent over MCP | Your existing agent bill | No chat UI. A prompt gallery instead. |

```
 screen ──▶ Swift capture ──▶ PP-OCR (local) ──▶ SQLite + full-text + vectors
                                                        │
                       session / daily / weekly summaries (your model, optional)
                                                        │
                                          MCP server ──▶ Claude Code · Cursor · Codex
                                                        │
                                          Daily review page (for humans)
```

Text recognition runs PP-OCR on device. Capture frequency, deduplication and scheduling are designed so OCR fits inside the "Low" energy budget in Activity Monitor. If the fan spins because of Recapsy, that is a bug.

## What ships in 1.0

**Memory**
- Continuous screenshots, on-device OCR, on-device full-text search. Zero upload.
- Gap accounting: every window has a screenshot or a reason. Stalled capture raises an alert.
- Visible retention: the rules that delete data are shown and editable.
- Three summary layers: session, day, week. Bring any OpenAI-compatible endpoint and key, including Ollama. Skip it and everything else still works.
- Optional semantic search with on-device embeddings.

**Agent access**
- One command wires the MCP server into Claude Code, Cursor or Codex.
- Every answer carries screenshot, original text and time.
- Context resume: an agent can ask "where did this person leave off in this project or directory?"

**For humans**
- A daily review page: today and this week as a timeline with screenshots, recognized text and session summaries. No chat, no dashboard.

**Trust**
- No account.
- One-click full export in open formats.
- A "what leaves your device" page. In 1.0 the answer is the version number sent when checking for updates.
- No telemetry by default.

**Hard targets**
- From download to running in under ten minutes, without asking the author.
- Energy impact "Low" in Activity Monitor. The fan does not spin because of Recapsy.

## Not in 1.0

Accounts, the cloud tier, mobile, Windows, Linux, a chat interface, browser extensions, a team edition, one-time purchase, usage-based billing, migration of data from earlier prototypes.

The cloud tier starts when fifty people are on the waitlist or ten people ask how to use Recapsy on two machines. Not before.

## Requirements

- macOS. Recapsy is macOS only by design so that capture quality, privacy interception and on-device OCR can be finished properly on one platform.
- Screen Recording and Accessibility permissions.
- Optional: an OpenAI-compatible endpoint and key, or a local Ollama, for summaries.

## Status

Under development, not yet released. The repository was cleared on 2026-09-08 to begin a local-first rebuild; earlier code remains in the history for reference.

## Tech stack

Electron and TypeScript for the main process and UI. A Swift process for capture with pre-capture privacy interception. SQLite with full-text indexing. PP-OCR on device. An MCP server. Summaries through any OpenAI-compatible model you configure.

## Contributing

Issues are welcome. Bug-fix pull requests are welcome. For features, open a discussion first. All commits must be signed off under the [Developer Certificate of Origin](DCO):

```sh
git commit -s -m "fix(capture): describe the change"
```

## History

This repository carries the full history of the project since its first commit on 2025-12-10.

| When | What |
|------|------|
| 2025-12 | recaply: daily, weekly and yearly summaries generated from git history |
| 2025-12 | First Electron desktop attempt |
| 2026-01 | recapsense: screen, OCR, search, MCP. The first local memory pipeline |
| 2026-02 | Native Swift experiment |
| 2026-04 | TypeScript monorepo architecture draft |
| 2026-05 | Recapsy monorepo with a Swift capture engine and pre-capture privacy interception |
| 2026-09 | Local-first rebuild begins |

## License

[MIT](LICENSE)
