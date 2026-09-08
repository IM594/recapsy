# Roadmap

[English](roadmap.md) · [简体中文](roadmap.zh-CN.md)

Updated 2026-09-08. Versions are split by one question: does anything leave your device? 1.0 is the free, fully local tier. 2.0 is the paid cloud tier. The data model is defined once for 1.0 and implemented in steps.

## 1.0, free and local

**Memory**
- Continuous screenshots, on-device OCR, on-device full-text search. Zero upload.
- Gap accounting: every time window has a screenshot or a reason. Stalled capture raises an alert.
- Visible retention: the rules that delete data are shown and editable.
- Three summary layers: session, day, week. Bring any OpenAI-compatible endpoint and key, including Ollama. Skip it and everything else still works.
- Optional semantic search with on-device embeddings.

**Agent access**
- One command wires the MCP server into Claude Code, Cursor or Codex.
- Every answer carries screenshot, original text and time.
- Context resume: an agent can ask where this person left off in a project or directory.

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

**Requirements**
- macOS, with Screen Recording and Accessibility permissions.
- Optional: an OpenAI-compatible endpoint and key, or a local Ollama, for summaries.

## Not in 1.0

Accounts, the cloud tier, mobile, Windows, Linux, a chat interface, browser extensions, a team edition, one-time purchase, usage-based billing, migration of data from earlier prototypes.

## 2.0, paid cloud tier

Hosted models for summaries, cloud OCR, backup and multi-device sync, hosted MCP so the agent on your phone can ask too, accounts and payment. Work starts when fifty people are on the waitlist or ten people ask how to use Recapsy on two machines. Not before.

## Tech stack

Electron and TypeScript for the main process and UI. A Swift process for capture with pre-capture privacy interception. SQLite with full-text indexing. PP-OCR on device. An MCP server. Summaries through any OpenAI-compatible model you configure.

## History

| When | What |
|------|------|
| 2025-12 | recaply: daily, weekly and yearly summaries generated from git history |
| 2025-12 | First Electron desktop attempt |
| 2026-01 | recapsense: screen, OCR, search, MCP. The first local memory pipeline |
| 2026-02 | Native Swift experiment |
| 2026-04 | TypeScript monorepo architecture draft |
| 2026-05 | Recapsy monorepo with a Swift capture engine and pre-capture privacy interception |
| 2026-09 | Local-first rebuild begins from a clean `main`; earlier work under tag `archive/prototypes-2026-09` |
