# Contributing to Recapsy

Thanks for your interest.

> Recapsy has not shipped yet and the code is changing quickly. Until the first release, outside pull requests are not merged. Bug reports and discussions are welcome and read.

Recapsy is deliberately small. Naming, tests, commits and code rules live in [AGENTS.md](../AGENTS.md), written so that people and coding agents read the same text. This page covers how to take part.

## What to open

- **Bug**: use the bug report form. Include version, macOS version and steps.
- **Feature**: start a [discussion](https://github.com/IM594/recapsy/discussions) before writing code. Many good ideas fit better as a prompt for your agent than as a feature in the app, and a discussion settles that before anyone spends time on code. Feature pull requests without a prior discussion may be closed.
- **Security**: see [SECURITY.md](SECURITY.md). Never open a public issue.

## Workflow

1. Branch from `main` as `type/topic`, using the same types as commits: `feat/mcp-citations`, `fix/capture-stall-alert`, `docs/readme-install`.
2. Keep the pull request focused on one change. Small and complete beats large and partial.
3. Open the pull request with a title in Conventional Commits form. That title becomes the single commit on `main`, so make it precise.
4. Pushes to `main` are not allowed. Everything lands through a squash merge.

## Commits and code

Commit format, naming, test layout and code rules are in [AGENTS.md](../AGENTS.md).

## Local setup

You need Node 24 and pnpm 10. Clone the repository and run `pnpm install`, then `pnpm lint`, `pnpm typecheck` and `pnpm test`. The install step sets up git hooks: staged files must pass Biome (`pnpm fix` formats them) and commit messages must follow the Conventional Commits format, otherwise the commit is rejected before it reaches CI. `pnpm --filter recapsy-desktop start` builds the desktop app and runs it.

The capture process is a Swift package in `capture/`. You need Xcode 16.4 or later. Run its tests with `swift test --package-path capture` and format with `swift format --recursive --in-place capture`.

## Releases

Pushing a `vX.Y.Z` tag builds the desktop app, signs it and publishes a GitHub Release with the `.dmg` and generated notes. The app is signed with a self-signed certificate rather than an Apple Developer ID, so the first launch needs to be allowed in System Settings under Privacy & Security. Maintainers configure the certificate through two repository secrets: `MACOS_SIGNING_CERTIFICATE_P12`, the base64-encoded certificate export, and `MACOS_SIGNING_CERTIFICATE_PASSWORD`. Without them the release is signed ad hoc.

## License

By contributing you agree that your contributions are licensed under the [MIT License](../LICENSE).
