# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Claude Context is an MCP plugin that adds semantic code search to AI coding agents. A codebase is split into chunks, embedded, and stored in a Milvus/Zilliz vector database; queries are answered by semantic (hybrid dense + sparse) search instead of loading whole directories into the model's context.

## Monorepo Layout

pnpm workspace (`packages/*`, `examples/*`). Requires Node >=20 <24 and pnpm >=10.

- `packages/core` (`@bigabid/claude-context-core`) — the indexing engine. All real logic lives here; the other packages are thin frontends over it. Published to GitHub Packages (`npm.pkg.github.com`, `@bigabid` scope) — publish with `pnpm publish` (not plain `npm publish`, which doesn't rewrite the `workspace:*` dependency on core to a real version).
- `packages/mcp` (`@bigabid/claude-context-mcp`) — MCP server, the primary product. ESM (`"type": "module"`). Defaults to stdio transport (one local process per user); `MCP_TRANSPORT=http` runs it as a shared Streamable HTTP server instead (stateless per request, so safe behind a plain load balancer) — see `Dockerfile` (repo root, multi-arch) and `deploy/helm/claude-context-mcp` (Helm chart) for hosting that mode, e.g. in EKS.
- `packages/sync-worker` (`@bigabid/claude-context-sync-worker`) — standalone batch job (Kubernetes CronJob, not a service): auto-discovers a GitHub org's repos via a GitHub App installation, clones/pulls each onto a PVC, and calls `reindexByChange` with `CODE_CHUNKS_COLLECTION_KEY_SOURCE=git-remote` so it converges on the same shared collections laptops/CI use. Meant to be the *sole* indexer for whichever repos it covers — see the package README for why running it alongside laptop-side `index_codebase` on the same repo is unsafe. A repo never indexed before needs a real `indexCodebase` (with its `FileSynchronizer` built + registered first) — `reindexByChange` alone can't do a first index: with no merkle snapshot yet it baselines against the *current* on-disk state and reports zero changes, leaving the collection empty forever. Repos are processed through a bounded worker pool (`concurrency-pool.ts`, `SYNC_CONCURRENCY` env, default 4) rather than one at a time, since repos are independent (separate collections/checkouts, each mints its own GitHub App token) — indexing has no other concurrency anywhere in this codebase (not in core's file/chunk processing, not per-file embedding). See `Dockerfile.sync-worker` (repo root, multi-arch) and `deploy/helm/claude-context-sync-worker`.
- `packages/vscode-extension` (`semanticcodesearch`) — VSCode extension. Bundled with webpack; stubs out Node-only deps (Milvus gRPC, native AST) in `src/stubs/`.
- `packages/chrome-extension` — browser build; overrides `@zilliz/milvus2-sdk-node` to `false` (no gRPC in browser).
- `examples/basic-usage` — runnable library example.

## Commands

```bash
pnpm install
pnpm build                 # build all packages (examples built last)
pnpm build:core            # build a single package: also build:mcp, build:vscode, build:sync-worker
pnpm dev                   # watch all; or dev:core / dev:mcp / dev:vscode
pnpm lint                  # eslint across packages; lint:fix to autofix
pnpm typecheck             # tsc --noEmit across packages
pnpm clean                 # rimraf dist in every package
```

Packages depend on `core` via `workspace:*`, so **rebuild core (`pnpm build:core`) before testing mcp/vscode against core changes** — they consume `core/dist`, not its source.

### Tests

- **core** uses Jest + ts-jest. Test files are colocated as `*.test.ts` in `src/`.
  ```bash
  pnpm --filter @bigabid/claude-context-core test                     # all (runs in band)
  pnpm --filter @bigabid/claude-context-core test -- context.abort    # by filename
  pnpm --filter @bigabid/claude-context-core test -- -t "pattern"     # by test name
  ```
- **mcp** and **sync-worker** use the Node built-in test runner via tsx (no Jest):
  ```bash
  pnpm --filter @bigabid/claude-context-mcp test                      # runs src/**/*.test.ts
  pnpm --filter @bigabid/claude-context-sync-worker test
  ```

### Running the MCP server locally

```bash
pnpm --filter @bigabid/claude-context-mcp start        # tsx src/index.ts
```
Configuration is entirely via environment variables (see `.env.example` and `packages/mcp/src/config.ts`). Key vars: `EMBEDDING_PROVIDER` (OpenAI | VoyageAI | Gemini | Ollama | OpenRouter | Bedrock), provider API key, `EMBEDDING_MODEL`, `MILVUS_ADDRESS` and/or `MILVUS_TOKEN` (address can be auto-resolved from a Zilliz token), `CODE_CHUNKS_COLLECTION_NAME_OVERRIDE`, `CODE_CHUNKS_COLLECTION_KEY_SOURCE` (set to `git-remote` to key a codebase's collection off its git `origin` remote instead of its local path, so multiple checkouts of the same repo share one collection).

## Architecture

### Core: the `Context` orchestrator (`packages/core/src/context.ts`)

`Context` ties together three pluggable interfaces injected through its constructor config:

- **Embedding** (`src/embedding/`) — `base-embedding.ts` interface with `OpenAIEmbedding`, `VoyageAIEmbedding`, `GeminiEmbedding`, `OllamaEmbedding`, `BedrockEmbedding` implementations.
- **VectorDatabase** (`src/vectordb/`) — `MilvusVectorDatabase` (gRPC, Node-only) and `MilvusRestfulVectorDatabase` (HTTP, browser-safe). `zilliz-utils.ts` (`ClusterManager`) can provision a free Zilliz cluster and resolve an address from a token.
- **Splitter** (`src/splitter/`) — `AstCodeSplitter` (tree-sitter, the default at 2500/300 chunk/overlap) which falls back to `LangChainCodeSplitter` for unsupported languages or parse failures.

The public surface (`indexCodebase`, `reindexByChange`, `semanticSearch`, `clearIndex`, `hasIndex`) is re-exported from `src/index.ts`. Indexing reads files honoring ignore rules, splits them, embeds in batches, and upserts vectors. Collection name is derived from a hash of the absolute codebase path (overridable).

Repo-identity variants let a caller search or discover collections with no local checkout at all: `getCollectionNameForRepo`/`hasIndexForRepo`/`semanticSearchByRepo` take a repo identity string (e.g. `github.com/org/repo`) instead of a local path — `hasIndexForRepo`/`semanticSearchByRepo` fall back to scanning `listIndexedRepos()` if the direct hash misses, so a `HYBRID_MODE`/`CODE_CHUNKS_COLLECTION_NAME_OVERRIDE` mismatch between indexer and searcher doesn't produce a false "not indexed". `listIndexedRepos()` enumerates every `code_chunks_*`/`hybrid_code_chunks_*` collection and recovers each one's repo identity/local path from its Milvus collection description, written by `prepareCollection` as `repo:<identity>;codebasePath:<path>` (identity first, path last — an unescaped `;` in a path can't corrupt the parse since the path is always the last field, matched greedily to end-of-string). `semanticSearchAllRepos` fans out across every indexed collection concurrently (embedding the query once, reused across all of them), merges and ranks by score, and skips — rather than fails on — a collection that errors (e.g. an embedding-dimension mismatch from a different provider).

Two error types carry control-flow meaning and should be preserved when touching the pipeline:
- `IndexAbortError` — cooperative cancellation via `AbortSignal`.
- `EmbeddingError` — always re-thrown to halt the whole pipeline, unlike per-file read/parse errors which are logged and skipped. This prevents silent partial indexing (Milvus getting zero vectors while the snapshot marks files done).

### Incremental sync (`packages/core/src/sync/`)

`FileSynchronizer` builds a Merkle DAG (`merkle.ts`) of file hashes to compute `{added, removed, modified}` between runs. Snapshots persist to `~/.context/merkle/<md5-of-path>.json`. `reindexByChange` uses this so re-indexing only touches changed files. The MCP server can also run a background sync loop (`CLAUDE_CONTEXT_BACKGROUND_SYNC`, `CLAUDE_CONTEXT_SYNC_INTERVAL_MS`).

### Ignore patterns

Layered: built-in `DEFAULT_IGNORE_PATTERNS` + config + env (`CUSTOM_IGNORE_PATTERNS`) + on-disk ignore files (`.gitignore`, `.contextignore`, `.xxxignore`, and a global `~/.context/.gitignore`). `utils/ignore-matcher.ts` implements matching including gitignore negation (`!`) semantics — covered by `context.ignore-patterns.test.ts`.

### Env resolution (`packages/core/src/utils/env-manager.ts`)

`envManager.get(name)` resolves with priority `process.env` > `~/.context/.env` file. Use it instead of reading `process.env` directly so the `.env` file fallback keeps working.

### MCP server (`packages/mcp/src/`)

- `index.ts` — entry point. **Critically, it redirects `console.log`/`console.warn` to stderr at the very top**, because stdout is reserved for the MCP JSON protocol. Never write non-protocol output to stdout in this package. Also registers global `unhandledRejection`/`uncaughtException` handlers so an unreachable Milvus/embedding endpoint (a rejected promise deep in background sync) logs loudly instead of silently killing the process. `setupTools(server)` takes a `Server` instance so it can be called once (stdio: one long-lived `Server`) or per-request (`MCP_TRANSPORT=http`: a fresh `Server` + `StreamableHTTPServerTransport` pair per request, all sharing the same `Context`/Milvus connection built once at startup).
- `handlers.ts` (`ToolHandlers`) — implements the tools: `index_codebase`, `search_code`, `clear_index`, `get_indexing_status`, `list_indexed_repos`, `search_repo` (search one repo by git identity, no local checkout needed), `search_org` (fan out across every indexed repo at once).
- `snapshot.ts` (`SnapshotManager`) — tracks per-codebase indexing state across server restarts.
- `sync.ts` (`SyncManager`) — drives incremental re-indexing.
- `config.ts`, `embedding.ts` — build `Context` (embedding provider + Milvus) from environment variables.

## Conventions

Commits follow Conventional Commits with these scopes: `core`, `vscode`, `mcp`, `examples`, `docs` (e.g. `fix(core): support gitignore negation patterns`). All code and comments are written in English.
