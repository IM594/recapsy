# Contributing to Recapsy

[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for your interest. Recapsy is small and opinionated, and the rules below exist so that the codebase reads the same no matter who or what wrote it. They apply equally to humans and to coding agents working on their behalf.

## What to open

- **Bug**: use the bug report form. Include version, macOS version and steps.
- **Feature**: start a [discussion](https://github.com/IM594/recapsy/discussions) before writing code. Recapsy sorts every idea by rhythm first (every frame, once a day, whenever you ask) and many ideas belong in the prompt gallery rather than in the app. A pull request for an undiscussed feature will be closed with a pointer to this paragraph.
- **Security**: see [SECURITY.md](SECURITY.md). Never open a public issue.

## Workflow

1. Branch from `main` as `type/topic`, using the same types as commits: `feat/mcp-citations`, `fix/capture-stall-alert`, `docs/readme-install`.
2. Keep the pull request focused on one change. Small and complete beats large and partial.
3. Open the pull request with a title in Conventional Commits form. That title becomes the single commit on `main`, so make it precise.
4. Pushes to `main` are not allowed. Everything lands through a squash merge.

## Commits

- Format: `type(scope): message`, one line, no body, no footer.
- Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `ci`, `build`, `style`, `revert`.
- `scope` is required for `feat`, `fix` and `refactor`. It names a module or capability, for example `capture`, `ocr`, `mcp`, `summary`, `review`.
- Sign every commit off under the [Developer Certificate of Origin](DCO). `git commit -s` adds the line for you. Pull requests with unsigned commits cannot be merged.

## Code rules

- **Name things after the business capability.** Stage names, scaffolding names and implementation history never appear in runtime code, tests, directories, type names or user-visible reason codes. No `slice`, `foundation`, `tmp`, `stub`, `v0`, `next`, unless it is a real domain concept such as a `/v1` API path or a provider stub.
- **Tests follow ownership.** Module tests live in `src/<module>/tests/`, cross-module integration tests in `tests/integration/`, all named `*.test.ts`. No `__tests__/`, no `*.spec.ts`, no tests next to source files. Production code never imports from a test directory. Swift keeps `Tests/<Target>Tests/`.
- **Comments are the last resort.** Let names and structure carry the meaning. When a comment is needed, keep it to one line.
- **No hard-coded secrets, domains, ports or personal paths.**
- **Fix the cause, not the symptom.** If a workaround is the only option, say so in the pull request and explain the trade-off.
- **Dependencies are pinned and deliberate.** Adding a library needs a discussion first.
- **Energy is a hard target.** Anything running on every frame must justify its cost. Activity Monitor must keep showing "Low".
- Documents carry dates, not version numbers.

## Local setup

The rebuild is in progress. Setup and test commands will be documented here with the first code drop.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE) and certified under the [DCO](DCO).
