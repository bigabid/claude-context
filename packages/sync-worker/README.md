# @bigabid/claude-context-sync-worker

Standalone batch job that auto-discovers every repo a GitHub App installation can see and keeps them indexed in the shared Claude Context vector database — a run-then-exit tool meant for a Kubernetes CronJob, not a long-lived process.

Meant to run as the **sole indexer** for whichever repos it's installed against. It does not coordinate with laptop-side `index_codebase` runs — if both index the same repo from different local checkouts, one can delete the other's vectors when it sees files "missing" relative to its own merkle snapshot (see `reindexByChange` in `@bigabid/claude-context-core`). Stop indexing a repo from laptops once this worker covers it.

## How it works

1. Authenticates as the configured GitHub App and mints an installation access token.
2. Lists every repo the installation can see (`GET /installation/repositories`), filtering out archived repos and forks by default.
3. For each repo: shallow clone (or fetch + hard reset if already checked out) onto `SYNC_REPOS_DIR`, authenticating the git operation with a **fresh** installation token (these expire in ~1 hour — a whole-org run can outlast a single token, so one is minted per repo, not once at startup).
4. Calls `reindexByChange` (falls back to creating the collection first if the repo has never been indexed by anyone).
5. Logs a summary and exits non-zero only if every repo failed (so a CronJob distinguishes "nothing changed" from "totally broken").

## Required environment variables

| Variable | Description |
|----------|-------------|
| `GITHUB_APP_ID` | The GitHub App's ID |
| `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH` | The App's private key PEM (inline, with literal `\n` or real newlines) or a path to a mounted file |
| `GITHUB_APP_INSTALLATION_ID` | The installation ID for the org this App is installed on |
| `CODE_CHUNKS_COLLECTION_KEY_SOURCE` | **Must be `git-remote`.** The worker refuses to start otherwise — without it, it would index into collections keyed off its own pod-internal checkout path instead of each repo's git identity, silently creating collections no one else's `search_repo`/`search_code` would ever find |

Plus the same embedding-provider and Milvus variables as `@bigabid/claude-context-mcp` (`EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, provider API key, `MILVUS_ADDRESS`, `MILVUS_TOKEN`, etc.) — **these must match whatever produced the existing collections** (same `HYBRID_MODE`, same embedding model/dimension), or this worker creates parallel collections instead of updating the real ones.

## Optional environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GITHUB_ORG` | Informational only (the installation ID already scopes discovery) | — |
| `SYNC_EXCLUDE_REPOS` | Comma-separated repo names or `org/repo` full names to skip | None |
| `SYNC_INCLUDE_ARCHIVED` | Set `true` to index archived repos too | `false` |
| `SYNC_INCLUDE_FORKS` | Set `true` to index forks too | `false` |
| `SYNC_REPOS_DIR` | Local checkout directory (should be a persistent volume, so repeated runs are incremental rather than re-cloning everything) | `/data/repos` |

## GitHub App permissions

- Repository contents: **Read-only**
- Metadata: **Read-only**

The installation token doubles as the git credential (`https://x-access-token:<token>@github.com/...`, sent as a per-invocation `http.extraheader` — never written to disk) — no separate deploy key needed.
