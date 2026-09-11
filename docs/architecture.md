# Architecture

Date: 2026-09-11. This document is the single source of truth for architectural decisions. AGENTS.md links here; it does not duplicate content.

## Directory layout

```text
recapsy/
├── app/
│   ├── desktop/          # Electron shell: tray, window, process management, assembly
│   ├── capture/          # Swift screenshot process (SPM, not in Node workspace)
│   └── web/              # Review page and settings, produces static assets
├── core/
│   ├── memory/           # SQLite schema, migrations, write, retain, tombstone,
│   │                     # BlobStore, FTS5, vector query interface, export
│   ├── ingest/           # Frame reception, span merging, dedup, persistent queue
│   └── enrich/           # OCR dispatch, summarization, embedding
├── mcp/                  # MCP server, independent stdio process entry point
└── docs/
    ├── architecture.md   # This file
    ├── data-model.md     # Core entities, schema, migration rules
    └── capture-protocol.md  # Contract between capture and desktop
```

- `app/` holds executable artifacts the user interacts with.
- `core/` holds shared logic with no process semantics. No package under `core/` may import Electron.
- `mcp/` is a root-level package because it is neither an app (agents launch it, not the user) nor a core library (it is a process entry point).
- `capture/` is managed by Swift Package Manager and does not participate in the pnpm workspace.
- Node workspace packages: `app/desktop`, `app/web`, `core/memory`, `core/ingest`, `core/enrich`, `mcp`.

## Dependency direction

```text
mcp      → core/memory
ingest   → core/memory
enrich   → core/memory
desktop  → core/memory + core/ingest + core/enrich
web      → core/memory (shared types only)
```

`mcp` never imports `core/ingest` or `core/enrich`. This isolates the MCP process from ONNX runtime and keeps cold start under 100 ms.

`core/*` never imports Electron. `core/memory` has no internal dependencies.

Dependency direction is enforced by CI using `dependency-cruiser`.

## Runtime architecture

The user sees one Recapsy.app. Three processes at most:

| Process | Lifecycle | What it does |
|---|---|---|
| Recapsy (Electron) | Launched by user, always running | Tray, window, runs `core/memory` + `core/ingest` + `core/enrich` in-process |
| RecapsyCapture (Swift) | Managed by Electron main process | Screenshots, privacy interception, writes blobs and stdout events |
| MCP (Node) | Launched on demand by agents via stdio | Read-only SQLite access, answers queries with citations |

MCP uses the Electron binary with `ELECTRON_RUN_AS_NODE=1` so native modules (better-sqlite3) are compiled once for one ABI.

## Data flow

### capture → desktop

The capture process writes screenshots to the blob directory, then emits one JSON line per frame on stdout: path, timestamp, app name, window title, or a privacy-interception reason code. It receives control commands on stdin (pause, rule updates).

Files land on disk before the notification arrives. This guarantees "originals stay" by construction.

### Inside the Electron process

The persistent queue is a `status` column on the frames table: `captured` → `recognized` → `indexed`. No in-memory event bus is the source of truth.

- **ingest** receives capture events, merges consecutive identical frames into spans (`first_seen` / `last_seen`), deduplicates before OCR, and writes rows with status `captured`.
- **enrich** pulls `captured` rows serially, runs OCR (PP-OCR or model OCR per user config), writes results and advances status to `recognized`. Summarization runs on its own schedule (session, daily, weekly), is idempotent, and can be re-run.
- **EventEmitter** only notifies the review page to refresh. It is never the source of truth.

SQLite runs in WAL mode. Multiple readers (MCP, UI, summarization reads) and one writer (ingest/enrich) coexist without blocking.

### MCP → SQLite

MCP opens the database read-only. It checks the schema version on open; if the version is newer than it understands, it opens read-only or reports an upgrade prompt. MCP never writes.

Semantic search: MCP lazily loads the embedding model in its own process. When unavailable, it falls back to FTS5 full-text search.

## Core entity: span, not screenshot

A span represents a continuous period of unchanged screen content, with `first_seen` and `last_seen` timestamps. Deduplication happens before OCR — this is the biggest energy lever.

The timeline is built from spans and explicit gap records (privacy interception, pause, sleep, process not running). Gap reason codes are user-visible and named by capability per AGENTS.md.

## OCR providers

A single provider interface with three implementations:

| Provider | Available | Who pays | Energy cost |
|---|---|---|---|
| LocalPPOCR | 1.0, default | Free | Constrained by "Low" budget |
| ModelOCR | 1.0, user configures endpoint | User API bill | Zero local |
| HostedOCR | 2.0 | Subscription | Zero local |

ModelOCR and HostedOCR share the same implementation; the only difference is where the endpoint comes from (user config vs hosted). Every frame runs through whichever provider the user has selected.

## Electron packaging

Electron Forge is not used. It forces `node-linker=hoisted`, which breaks pnpm isolation and inflates the lockfile.

Packaging uses `@electron/packager` (lightweight, does not force hoisted) or a custom assembly script, plus:

- **Signing:** Custom script, sign layer by layer (Swift helper → frameworks → .app). `codesign --deep` is deprecated.
- **DMG:** `hdiutil create`.
- **Notarization:** `notarytool submit` + `stapler` (when a signing identity is configured).

The Swift capture binary is placed in `Contents/MacOS/RecapsyCapture` inside the app bundle.

## Web independence

`app/web` communicates with the backend over HTTP + JSON, not Electron IPC. The Electron main process listens on `127.0.0.1` with a random port and a one-time token. `pnpm dev` and the packaged app use the same path. Shared types come from `core/memory`.

This ensures `web` can be served standalone by any HTTP server (development, 2.0 cloud deployment).

## 2.0 compatibility: five abstractions embedded from day one

These are cheap now and prohibitively expensive to retrofit:

1. **UUIDv7 primary keys** with a `device_id` column on every row. Auto-increment IDs break multi-device sync.
2. **Tombstone deletes** with a recorded reason. Required by the "no silent deletion" promise; sync needs them too.
3. **Source tracking on derived data.** OCR text records: provider, model version, input hash. Summaries record: model, time window. Required by "every answer cites its source"; cloud re-OCR of old frames also needs it.
4. **Content-hash addressed blobs.** The database stores hashes, not absolute paths. A `BlobStore` interface resolves to a local directory now and to cloud storage later. Export, migration, and sync all benefit.
5. **MCP tools depend on a `MemoryQuery` interface.** The local implementation reads SQLite; a future remote implementation reads the cloud API. The tool definitions and response shapes stay the same.

**Not built until needed:** tenants, authentication, remote transport, accounts. SCOPE says 2.0 waits for fifty people on the waitlist.

## Library directory is the export format

The SQLite file, the blob directory, and a JSON settings file live in one directory. "One-click full export" is copying the directory. The format is open by construction. Settings are not stored separately (no electron-store).

## Schema versioning

Migrations only go forward, numbered sequentially. CI checks for gaps. Both the Electron process and the MCP process validate the schema version on open. MCP with an older schema opens read-only.

## Chinese full-text search

FTS5 default `unicode61` tokenizer treats a Chinese string as one token. The `trigram` tokenizer requires at least three characters, missing two-character words.

Solution: pre-segment Chinese text using the built-in `Intl.Segmenter` (Node 24, zero dependencies) before writing to the FTS column.

## Capture implementation notes

- Use ScreenCaptureKit (macOS 12.3+), not `CGWindowListCreateImage`. The latter loads ReplayKit as a side effect, leaking a ~19% CPU thread that never unloads. This directly threatens the "Low" energy target.
- Capture is event-driven: trigger on app switch, window focus change, click, scroll, typing pause. Idle fallback every 5 seconds. Fixed-interval capture wastes energy when the screen has not changed.
- Default storage format: JPEG quality 80–85 (an order of magnitude smaller than PNG, negligible OCR accuracy loss). Perceptual hash (pHash) for frame dedup, only changed frames are stored.

## Rule enforcement

| Layer | Carrier | Enforced by | On violation |
|---|---|---|---|
| L1 Hard rules | CI checks | Machine | PR red, cannot merge |
| L2 Structural rules | Templates, scaffolding | Machine | Wrong at generation time |
| L3 Conventions | AGENTS.md | Agent + review | Review catches it |
| L4 Background | docs/architecture.md | Human | Not enforced |

CI enforces: dependency direction (`dependency-cruiser`), test file location (vitest `include`), declared dependencies (`no-extraneous-dependencies`), migration numbering.

AGENTS.md carries only L3 rules that can be judged in review. It links here for background.
