import { Context, MilvusVectorDatabase } from "@bigabid/claude-context-core";
import { loadConfig } from "./config.js";
import { createEmbeddingInstance } from "./embedding.js";
import { createGithubAppAuth, mintInstallationToken, discoverRepos } from "./github-app.js";
import { runWithConcurrency } from "./concurrency-pool.js";
import { processRepo } from "./process-repo.js";

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
