import { Context, MilvusVectorDatabase, FileSynchronizer } from "@bigabid/claude-context-core";
import { loadConfig, SyncWorkerConfig } from "./config.js";
import { createEmbeddingInstance } from "./embedding.js";
import { createGithubAppAuth, mintInstallationToken, discoverRepos, DiscoveredRepo } from "./github-app.js";
import { cloneOrPull } from "./git-sync.js";
import { runWithConcurrency } from "./concurrency-pool.js";

type AppAuth = ReturnType<typeof createGithubAppAuth>;

async function processRepo(context: Context, appAuth: AppAuth, config: SyncWorkerConfig, repo: DiscoveredRepo): Promise<void> {
    console.log(`[SYNC] [${repo.fullName}] cloning/pulling...`);
    // Fresh token per repo - a whole-org run can exceed a single
    // installation token's ~1h lifetime, so don't reuse discoveryToken here.
    const repoToken = await mintInstallationToken(appAuth, config.githubAppInstallationId);
    const repoPath = await cloneOrPull(repo, repoToken, config.reposDir);

    const alreadyIndexed = await context.hasIndex(repoPath);

    if (!alreadyIndexed) {
        // First time this repo has ever been indexed (by anyone, since
        // CODE_CHUNKS_COLLECTION_KEY_SOURCE=git-remote means "indexed"
        // is a property of the repo, not this checkout). reindexByChange
        // is NOT sufficient here: when no merkle snapshot exists yet, it
        // builds its baseline from the CURRENT on-disk state and treats
        // that as "already synced", reporting zero changes and leaving
        // the collection empty forever - it's built for catching changes
        // since a prior indexCodebase, not for doing that first index.
        // Mirrors packages/mcp/src/handlers.ts's handleIndexCodebase:
        // build+register the synchronizer BEFORE indexing, so later runs'
        // reindexByChange (via its own synchronizer-recreation fallback,
        // reading the snapshot file this just wrote) diffs correctly.
        console.log(`[SYNC] [${repo.fullName}] never indexed before - running full index...`);
        const ignorePatterns = await context.getEffectiveIgnorePatterns(repoPath);
        const supportedExtensions = context.getEffectiveSupportedExtensions();
        const synchronizer = new FileSynchronizer(repoPath, ignorePatterns, supportedExtensions);
        await synchronizer.initialize();

        await context.getPreparedCollection(repoPath);
        const collectionName = context.getCollectionName(repoPath);
        context.setSynchronizer(collectionName, synchronizer);

        const stats = await context.indexCodebase(repoPath);
        console.log(`[SYNC] [${repo.fullName}] done: indexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks`);
    } else {
        console.log(`[SYNC] [${repo.fullName}] reindexing (path: ${repoPath})...`);
        const stats = await context.reindexByChange(repoPath);
        console.log(`[SYNC] [${repo.fullName}] done: +${stats.added} -${stats.removed} ~${stats.modified}`);
    }
}

async function main(): Promise<void> {
    const config = loadConfig();

    const embedding = createEmbeddingInstance(config);
    const vectorDatabase = new MilvusVectorDatabase({
        address: config.milvusAddress,
        ...(config.milvusToken && { token: config.milvusToken })
    });
    const context = new Context({
        embedding,
        vectorDatabase,
        collectionNameOverride: config.collectionNameOverride
    });

    const appAuth = createGithubAppAuth(config);

    console.log(`[SYNC] Discovering repos for installation ${config.githubAppInstallationId}...`);
    const discoveryToken = await mintInstallationToken(appAuth, config.githubAppInstallationId);
    const repos = await discoverRepos(config, discoveryToken);
    console.log(`[SYNC] Discovered ${repos.length} repo(s) to sync (after archived/fork/exclude filtering)`);
    console.log(`[SYNC] Processing with concurrency=${config.concurrency}`);

    const { synced, failed } = await runWithConcurrency(
        repos,
        config.concurrency,
        (repo) => processRepo(context, appAuth, config, repo),
        (repo, error) => console.error(`[SYNC] [${repo.fullName}] FAILED:`, error)
    );

    console.log(`[SYNC] Run complete: ${synced} synced, ${failed} failed out of ${repos.length} discovered.`);

    if (repos.length > 0 && synced === 0) {
        // Every repo failed - a k8s CronJob should retry rather than call this a success.
        process.exit(1);
    }
}

main().catch((error) => {
    console.error("[SYNC] Fatal error:", error);
    process.exit(1);
});
