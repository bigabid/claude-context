import { Context, EmbeddingModelMismatchError, FileSynchronizer } from "@bigabid/claude-context-core";
import { SyncWorkerConfig } from "./config.js";
import { createGithubAppAuth, mintInstallationToken, DiscoveredRepo } from "./github-app.js";
import { cloneOrPull, EmptyRepoError } from "./git-sync.js";

export type AppAuth = ReturnType<typeof createGithubAppAuth>;

/**
 * Runs a full index for a repo that has either never been indexed before, or
 * whose merkle snapshot was lost. Extracted from processRepo so it can be
 * unit-tested against a faked Context, independent of the git clone/token
 * minting around it.
 */
export async function runFirstIndex(context: Context, repoPath: string, repoFullName: string, alreadyIndexed: boolean): Promise<void> {
    if (!alreadyIndexed) {
        console.log(`[SYNC] [${repoFullName}] never indexed before - running full index...`);
    } else {
        console.log(`[SYNC] [${repoFullName}] collection exists but merkle snapshot is missing - forcing full re-index...`);
    }
    const ignorePatterns = await context.getEffectiveIgnorePatterns(repoPath);
    const supportedExtensions = context.getEffectiveSupportedExtensions();
    const synchronizer = new FileSynchronizer(repoPath, ignorePatterns, supportedExtensions);
    // Don't persist the freshly-generated baseline yet: if indexCodebase
    // below fails partway - embedding quota, Milvus hiccup, or the pod
    // being killed by the chart's activeDeadlineSeconds (no exception at
    // all in that case, just process death) - a snapshot written now
    // would make the next run's hasSnapshot() check true, taking the
    // reindexByChange branch, finding zero changes against a half-indexed
    // baseline, and reporting success forever with an incomplete
    // collection. Only persist once indexing has actually succeeded.
    await synchronizer.initialize(false);

    // Force-recreate the collection when one already exists, so a
    // lost-snapshot re-index doesn't just append on top of stale vectors.
    await context.getPreparedCollection(repoPath, alreadyIndexed);
    const collectionName = context.getCollectionName(repoPath);
    context.setSynchronizer(collectionName, synchronizer);

    const stats = await context.indexCodebase(repoPath);
    await synchronizer.persistSnapshot();
    console.log(`[SYNC] [${repoFullName}] done: indexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks`);
}

/**
 * Incremental sync for an already-indexed repo, with the recovery path for an
 * intentional embedding-model change: core's reindexByChange refuses (typed
 * EmbeddingModelMismatchError) to write vectors from a different model into a
 * tagged collection. Without a recovery path that repo would fail every run
 * forever, since descriptions are immutable and only a force re-index (drop +
 * recreate) can move a collection to the new model. That rebuild re-embeds the
 * whole repo, so it's destructive and costs real embedding traffic — it only
 * runs when the operator opts in via SYNC_FORCE_REINDEX_ON_MODEL_MISMATCH.
 */
export async function runIncrementalSync(context: Context, repoPath: string, repoFullName: string, forceReindexOnModelMismatch: boolean): Promise<void> {
    console.log(`[SYNC] [${repoFullName}] reindexing (path: ${repoPath})...`);
    try {
        const stats = await context.reindexByChange(repoPath);
        console.log(`[SYNC] [${repoFullName}] done: +${stats.added} -${stats.removed} ~${stats.modified}`);
    } catch (error) {
        if (!(error instanceof EmbeddingModelMismatchError)) {
            throw error;
        }
        if (!forceReindexOnModelMismatch) {
            throw new EmbeddingModelMismatchError(
                `${error.message} Set SYNC_FORCE_REINDEX_ON_MODEL_MISMATCH=true on the sync-worker to rebuild affected collections with the current model.`
            );
        }
        console.warn(`[SYNC] [${repoFullName}] embedding model changed (${error.message}) - SYNC_FORCE_REINDEX_ON_MODEL_MISMATCH is set, rebuilding the collection with the current model...`);
        await runFirstIndex(context, repoPath, repoFullName, true);
    }
}

export async function processRepo(context: Context, appAuth: AppAuth, config: SyncWorkerConfig, repo: DiscoveredRepo): Promise<void> {
    console.log(`[SYNC] [${repo.fullName}] cloning/pulling...`);
    // Fresh token per repo - a whole-org run can exceed a single
    // installation token's ~1h lifetime, so don't reuse discoveryToken here.
    const repoToken = await mintInstallationToken(appAuth, config.githubAppInstallationId);
    let repoPath: string;
    try {
        repoPath = await cloneOrPull(repo, repoToken, config.reposDir);
    } catch (error) {
        if (error instanceof EmptyRepoError) {
            // Not a real failure - the GitHub API reports a default_branch
            // even for a repo with zero commits. Nothing to index; skip
            // quietly instead of it showing up as FAILED every run.
            console.log(`[SYNC] [${repo.fullName}] skipped: ${error.message}`);
            return;
        }
        throw error;
    }

    const alreadyIndexed = await context.hasIndex(repoPath);
    // A Milvus collection surviving with no merkle snapshot on disk (PVC
    // deleted/recreated, persistence.enabled=false, misconfigured HOME) is
    // just as much a "can't diff incrementally" case as never-indexed:
    // reindexByChange would recreate the synchronizer, baseline it against
    // the CURRENT on-disk state (since there's no snapshot to load), and
    // report zero changes forever - silently never re-embedding again.
    const hasSnapshot = alreadyIndexed && await FileSynchronizer.hasSnapshot(repoPath);

    if (!alreadyIndexed || !hasSnapshot) {
        // Either first time this repo has ever been indexed (by anyone, since
        // CODE_CHUNKS_COLLECTION_KEY_SOURCE=git-remote means "indexed"
        // is a property of the repo, not this checkout), or the collection
        // exists but its merkle snapshot was lost. reindexByChange
        // is NOT sufficient here: when no merkle snapshot exists yet, it
        // builds its baseline from the CURRENT on-disk state and treats
        // that as "already synced", reporting zero changes and leaving
        // the collection stale forever - it's built for catching changes
        // since a prior indexCodebase, not for doing that first/full index.
        // Mirrors packages/mcp/src/handlers.ts's handleIndexCodebase:
        // build+register the synchronizer BEFORE indexing, so later runs'
        // reindexByChange (via its own synchronizer-recreation fallback,
        // reading the snapshot file this just wrote) diffs correctly.
        await runFirstIndex(context, repoPath, repo.fullName, alreadyIndexed);
    } else {
        await runIncrementalSync(context, repoPath, repo.fullName, config.forceReindexOnModelMismatch);
    }
}
