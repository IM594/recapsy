# Recapsy agent and contributor rules

These rules apply to every change in this repository, whether a person or a coding agent makes it. Read them before editing. The human-facing workflow lives in [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md).

If `AGENTS.local.md` exists in the repository root, read it before doing anything else. It is never committed.

## What Recapsy is

A macOS desktop app that keeps a local record of what the user is working on, screenshot by screenshot, and answers questions about it. Everything runs on the user's Mac: capture, OCR, indexing, search and summaries. Agents such as Claude Code, Cursor and Codex ask it over MCP. Every answer carries its source: screenshot, recognized text and time.

Boundaries that shape every decision:

- Nothing leaves the device. No account, no telemetry, no upload. The only network call is the version check for updates, and the app says so.
- Work is sorted by how often it runs. Per-frame work (capture, OCR, indexing) runs locally and must be cheap. Once-a-day work (session, daily, weekly summaries) uses a model the user configures and is optional. On-demand questions go through the user's own agent over MCP. There is no chat UI.
- Four promises to the user: gaps are visible, originals stay, nothing is deleted silently, every answer cites its source.
- Out of scope: chat interface, mobile app, Windows, Linux, browser extension, team features, any cloud capability.
- Hard targets: from download to running in under ten minutes; energy impact "Low" in Activity Monitor at all times.

## Stack

Electron and TypeScript for the main process and UI. A Swift process for screen capture with pre-capture privacy interception. SQLite with full-text indexing. PP-OCR running on device. An MCP server. Summaries through any OpenAI-compatible endpoint the user configures, including a local Ollama.

Dependencies are pinned. Adding a library needs a discussion first.

## Naming

- Name things after what they do for the user. A name describes a capability, never a stage of work, a scaffold or an implementation detail. This applies to code, tests, directories, types, injection keys and user-visible reason codes.
- Words such as `tmp`, `stub`, `foundation`, `slice`, `v0` or `next` do not appear in names unless they are real domain concepts, for example a `/v1` API path or a provider stub.
- File and directory names are consistent, unambiguous and readable. Flag unclear names and propose a rename before building on them.

## Tests

- Module tests live in `src/<module>/tests/`. Cross-module integration tests live in `tests/integration/`. All test files are named `*.test.ts`.
- No `__tests__/` directories, no `*.spec.ts`, no tests placed next to source files.
- Production code never imports from a test directory.
- Swift keeps the standard `Tests/<Target>Tests/` layout.
- Run the full test suite before opening a pull request. Passing end-to-end checks do not replace unit tests.
- New behavior comes with a new test. A bug fix starts with a test that reproduces the bug.
- A new test is run and seen failing before the code that makes it pass is written.
- Existing tests are not edited, weakened, skipped or deleted to make a run pass. When a test is wrong, the pull request says so and explains why.

## Code

- Comments are the last resort. Names and structure carry the meaning. When a comment is needed, it is one line.
- No hard-coded secrets, domains, ports or personal paths.
- Fix the cause, not the symptom. If a workaround is the only option, say so in the pull request and explain the trade-off.
- Anything that runs continuously must justify its energy cost. Prefer doing less work over doing work faster.
- Destructive operations (deleting files, bulk moves, clearing data) are reported as a dry run first and executed only after confirmation.

## Commits and pull requests

- Commit title: `type(scope): message`. One line. No body, no footer, no trailers.
- Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `ci`, `build`, `style`, `revert`.
- `scope` is required and names a module or capability, for example `capture`, `ocr`, `mcp`, `summary`, `review`, `repo`, `deps`.
- Branches are named `type/topic` with the same types.
- `main` only accepts squash merges through pull requests. The pull request title becomes the commit title.
- A pull request does one thing and references the issue it works on in its body, for example `Closes #12`. A pull request without an issue reference does not pass checks.
- The pull request body lists the commands that were run and what they returned, and states anything that was left undone or could not be verified.

## Documents

- Documents are in English. The README also has a Chinese edition under `docs/`. Nothing else is translated.
- Documents carry dates, not version numbers.
- Public documents describe what the product does, what it promises and how to take part. They do not compare against other products by name.

## Working with agents

- Prefer the root cause over the quick fix. When a shortcut exists, present both with their trade-offs and let the maintainer decide.
- For non-trivial changes, propose the approach before implementing it.
- A delegated agent does not delegate further. Verify its results on disk rather than trusting its report.
- Remove temporary files, debug output and scratch data before finishing.
