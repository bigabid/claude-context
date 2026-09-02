# @bigabid/claude-context-sync-worker

Standalone batch job that auto-discovers every repo a GitHub App installation can see and keeps them indexed in the shared Claude Context vector database — a run-then-exit tool meant for a Kubernetes CronJob, not a long-lived process.

Meant to run as the **sole indexer** for whichever repos it's installed against. It does not coordinate with laptop-side `index_codebase` runs — if both index the same repo from different local checkouts, one can delete the other's vectors when it sees files "missing" relative to its own merkle snapshot (see `reindexByChange` in `@bigabid/claude-context-core`). Stop indexing a repo from laptops once this worker covers it.

## How it works

1. Authenticates as the configured GitHub App and mints an installation access token.
2. Lists every repo the installation can see (`GET /installation/repositories`), filtering out archived repos and forks by default.
3. Processes repos through a bounded worker pool (`SYNC_CONCURRENCY`, default 4) — repos are independent (separate collections, separate checkouts), so a handful run at once instead of strictly one-at-a-time; each worker picks up the next repo as soon as it finishes, so a few slow/huge repos don't stall the ones behind them. For each repo: shallow clone (or fetch + hard reset if already checked out) onto `SYNC_REPOS_DIR`, authenticating the git operation with a **fresh** installation token (these expire in ~1 hour — a whole-org run can outlast a single token, so one is minted per repo, not once at startup).
4. Calls `reindexByChange` (falls back to creating the collection first if the repo has never been indexed by anyone).
5. A failing repo (e.g. a transient embedding-endpoint error) is logged and skipped rather than stopping the run — since it never got indexed, it's picked up again on the next scheduled run.
6. Logs a summary and exits non-zero only if every repo failed (so a CronJob distinguishes "nothing changed" from "totally broken").

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
| `SYNC_CONCURRENCY` | How many repos to clone/index at once | `4` |
| `SYNC_FORCE_REINDEX_ON_MODEL_MISMATCH` | Set `true` to rebuild (drop + full re-index) any collection recorded with a different embedding model than the current one. See "Changing the embedding model" below | `false` |

## Changing the embedding model

Each collection records the `provider/model` that indexed it in its Milvus description, and core refuses to write vectors from a different model into it (mixing embedding spaces silently corrupts search). Because Milvus descriptions are immutable, the only way to move a collection to a new model is to drop and rebuild it.

So after changing `EMBEDDING_PROVIDER`/`EMBEDDING_MODEL` on this worker, every already-tagged collection will fail its sync with `EmbeddingModelMismatchError` on every run. To migrate:

1. Set `SYNC_FORCE_REINDEX_ON_MODEL_MISMATCH=true` alongside the new model config.
2. Let one full run complete — each mismatched collection is dropped and fully re-embedded with the new model (this is the expensive part: the whole org's embedding traffic in one run).
3. Remove the flag. Leaving it on permanently is dangerous: an accidental model/env drift would silently rebuild collections instead of failing loudly.

Collections created before model tagging existed carry no tag and are assumed to match; they migrate to tagged descriptions whenever they're next force-rebuilt.

## Creating the GitHub App

This worker cannot create the App itself (it's an interactive web flow). Steps:

1. Go to `https://github.com/organizations/<your-org>/settings/apps/new`
2. Fill in:
   - GitHub App name: e.g. `claude-context-sync-worker` (must be globally unique across all of GitHub — add a suffix if taken)
   - Homepage URL: any URL (e.g. your repo's) — required field, doesn't need to be functional
   - Uncheck the **Webhook active** checkbox — not needed
3. Under **Repository permissions**, set:
   - **Contents**: Read-only
   - **Metadata**: Read-only (auto-selected)
4. Under "Where can this GitHub App be installed?", choose **Only on this account**
5. Click **Create GitHub App**
6. Note the **App ID** shown at the top of the app's settings page → this is `GITHUB_APP_ID`
7. Scroll to **Private keys** → **Generate a private key** → downloads a `.pem` file. Save it — there's no way to re-download it, only generate a new one. This file's contents are `GITHUB_APP_PRIVATE_KEY`/`GITHUB_APP_PRIVATE_KEY_PATH`
8. Click **Install App** in the left sidebar → pick your org → **All repositories** (or select specific ones) → **Install**
9. After installing, the URL you land on is `github.com/organizations/<org>/settings/installations/<INSTALLATION_ID>` — that number is `GITHUB_APP_INSTALLATION_ID`

The installation token doubles as the git credential (`https://x-access-token:<token>@github.com/...`, sent as a per-invocation `http.extraheader` — never written to disk) — no separate deploy key needed.
