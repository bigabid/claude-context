import { Context, MilvusVectorDatabase } from "@bigabid/claude-context-core";
import { loadConfig } from "./config.js";
import { createEmbeddingInstance } from "./embedding.js";
import { createGithubAppAuth, mintInstallationToken, discoverRepos } from "./github-app.js";
import { cloneOrPull } from "./git-sync.js";

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

    let synced = 0;
    let failed = 0;

    for (const repo of repos) {
        try {
            console.log(`[SYNC] [${repo.fullName}] cloning/pulling...`);
            // Fresh token per repo - a whole-org run can exceed a single
            // installation token's ~1h lifetime, so don't reuse discoveryToken here.
            const repoToken = await mintInstallationToken(appAuth, config.githubAppInstallationId);
            const repoPath = await cloneOrPull(repo, repoToken, config.reposDir);

            // Idempotent: no-ops (no drop, no data loss) if the collection
            // already exists. reindexByChange alone won't create it for a repo
            // that's never been indexed by anyone before - only indexCodebase
            // normally does, but calling it here would always run a full
            // (re-)index instead of the incremental diff reindexByChange gives us.
            await context.getPreparedCollection(repoPath);

            console.log(`[SYNC] [${repo.fullName}] reindexing (path: ${repoPath})...`);
            const stats = await context.reindexByChange(repoPath);
            console.log(`[SYNC] [${repo.fullName}] done: +${stats.added} -${stats.removed} ~${stats.modified}`);
            synced++;
        } catch (error) {
            console.error(`[SYNC] [${repo.fullName}] FAILED:`, error);
            failed++;
        }
    }

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
