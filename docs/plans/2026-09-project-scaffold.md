# Project scaffold

## Purpose

Establish the engineering foundation for the Recapsy desktop client: dependency management, code formatting, commit conventions, testing, and continuous integration. This plan covers the work needed before any application code is written.

## Scope

Three pull requests, merged in order:

1. **Tooling and CI** — package manifest, TypeScript, Biome, lefthook, commitlint, Vitest, Dependabot, and the CI workflow.
2. **Swift package and macOS CI** — the Swift process for screen capture, its test target, and a macOS CI job.
3. **Release workflow** — Electron Forge packaging, code signing, and the GitHub release workflow.

## Decisions

- **Single package, not a monorepo.** The client is one Electron app with a Swift helper; a workspace adds indirection without benefit at this size.
- **pnpm and Node 24.** One runtime, one package manager. pnpm handles dependency pinning and script lifecycle. Node 24 is the current LTS track.
- **Vitest for tests.** Tests run on the same Node runtime as the Electron main process, so native modules and SQLite behave the same in tests and in the app. Vitest also covers the renderer later.
- **Biome for formatting and linting.** Replaces ESLint and Prettier with a single tool. Runs in CI and as a pre-commit hook.
- **lefthook and commitlint for commit hygiene.** Pre-commit runs Biome on staged files. Commit-msg validates the Conventional Commits format with configuration only: every commit carries a scope, so no custom rule is needed. CI validates the pull request title the same way, since titles become squash commits on main.
- **Dependabot for three ecosystems.** npm and GitHub Actions from the first pull request, Swift once the package exists. Minor and patch updates are grouped; major bumps stay individual for deliberate review.
- **Electron Forge for packaging.** Handles the build, the native module rebuild, and the DMG.
- **Sign the .app, not the DMG.** Gatekeeper verifies the app bundle. A signed DMG container conflicts with notarization checks and adds nothing for the user.

## Acceptance

From issue #8:

1. `pnpm install && pnpm lint` works on a fresh clone with the commands documented in CONTRIBUTING.
2. Commit messages that break the one-line Conventional Commits format are rejected locally and in CI.
3. CI runs lint on every pull request and the `main` ruleset requires it to pass; type check and tests join CI with the first module, since an empty repository gives them nothing to run on.
4. Dependabot opens grouped weekly updates for npm, GitHub Actions and Swift.
5. Pushing a `vX.Y.Z` tag produces a GitHub Release with a `.dmg` and generated notes.

## Progress

| PR | Status |
|----|--------|
| 1. Tooling and CI | In progress |
| 2. Swift package and macOS CI | Not started |
| 3. Release workflow | Not started |

## Retrospective
