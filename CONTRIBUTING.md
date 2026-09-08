# Contributing to Recapsy

[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for your interest. Recapsy is deliberately small. The rules below keep the codebase consistent whether a change comes from a person or from a coding agent working on their behalf.

## What to open

- **Bug**: use the bug report form. Include version, macOS version and steps.
- **Feature**: start a [discussion](https://github.com/IM594/recapsy/discussions) before writing code. Many good ideas fit better as a prompt for your agent than as a feature in the app, and a discussion settles that before anyone spends time on code. Feature pull requests without a prior discussion may be closed.
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

## Code rules

- **Name things after what they do for the user.** Names describe a capability, never a stage of work, a scaffold or an implementation detail, in code, tests, directories, types and user-visible messages alike.
- **Tests follow ownership.** Module tests live in `src/<module>/tests/`, cross-module integration tests in `tests/integration/`, all named `*.test.ts`. No `__tests__/`, no `*.spec.ts`, no tests next to source files. Production code never imports from a test directory. Swift keeps `Tests/<Target>Tests/`.
- **Comments are the last resort.** Let names and structure carry the meaning. When a comment is needed, keep it to one line.
- **No hard-coded secrets, domains, ports or personal paths.**
- **Fix the cause, not the symptom.** If a workaround is the only option, say so in the pull request and explain the trade-off.
- **Dependencies are pinned and deliberate.** Adding a library needs a discussion first.
- **Energy is a hard target.** Anything that runs continuously must justify its cost. Activity Monitor must keep showing "Low".

## Local setup

Setup and test commands will be documented here together with the first code.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
