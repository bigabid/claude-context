import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EmbeddingModelMismatchError, FileSynchronizer, type Context } from "@bigabid/claude-context-core";
import { runFirstIndex, runIncrementalSync } from "./process-repo.js";

async function withTempHome(run: (tempRoot: string) => Promise<void>): Promise<void> {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "claude-context-sync-worker-"));
    const homeDir = path.join(tempRoot, "home");
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;

    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    try {
        await fs.mkdir(path.join(homeDir, ".context"), { recursive: true });
        await run(tempRoot);
    } finally {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
        if (originalUserProfile === undefined) {
            delete process.env.USERPROFILE;
        } else {
            process.env.USERPROFILE = originalUserProfile;
        }
        await fs.rm(tempRoot, { recursive: true, force: true });
    }
}

function fakeContext(indexCodebase: () => Promise<{ indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }>): Context {
    return {
        getEffectiveIgnorePatterns: async () => [],
        getEffectiveSupportedExtensions: () => ['.ts'],
        getPreparedCollection: async () => {},
        getCollectionName: () => 'code_chunks_test',
        setSynchronizer: () => {},
        indexCodebase
    } as unknown as Context;
}

test("runFirstIndex does not persist a merkle snapshot when indexCodebase fails (CR-1)", async () => {
    await withTempHome(async (tempRoot) => {
        const repoPath = path.join(tempRoot, "repo");
        await fs.mkdir(repoPath, { recursive: true });
        await fs.writeFile(path.join(repoPath, "a.ts"), "export const a = 1;\n");

        const context = fakeContext(async () => {
            throw new Error("embedding provider 429");
        });

        await assert.rejects(
            () => runFirstIndex(context, repoPath, "acme/widgets", false),
            /embedding provider 429/
        );

        // The bug this guards against: initialize() persisting the merkle
        // snapshot to disk BEFORE indexing succeeds. If it did, the next run
        // would see hasSnapshot()=true against a Milvus collection that never
        // actually got indexed, take the reindexByChange branch, find zero
        // changes, and report success forever with an empty collection.
        const persisted = await FileSynchronizer.hasSnapshot(repoPath);
        assert.equal(persisted, false, "a failed indexCodebase must not leave a merkle snapshot behind");
    });
});

test("runFirstIndex persists the merkle snapshot once indexCodebase succeeds", async () => {
    await withTempHome(async (tempRoot) => {
        const repoPath = path.join(tempRoot, "repo");
        await fs.mkdir(repoPath, { recursive: true });
        await fs.writeFile(path.join(repoPath, "a.ts"), "export const a = 1;\n");

        const context = fakeContext(async () => ({ indexedFiles: 1, totalChunks: 3, status: 'completed' as const }));

        await runFirstIndex(context, repoPath, "acme/widgets", false);

        const persisted = await FileSynchronizer.hasSnapshot(repoPath);
        assert.equal(persisted, true, "a successful indexCodebase must persist the merkle snapshot");
    });
});

function fakeReindexContext(options: { reindexError?: Error }) {
    const calls: { reindexed: boolean; forcedPrepare: boolean[]; indexed: boolean } = { reindexed: false, forcedPrepare: [], indexed: false };
    const context = {
        getEffectiveIgnorePatterns: async () => [],
        getEffectiveSupportedExtensions: () => ['.ts'],
        getPreparedCollection: async (_path: string, force?: boolean) => { calls.forcedPrepare.push(force === true); },
        getCollectionName: () => 'code_chunks_test',
        setSynchronizer: () => {},
        indexCodebase: async () => { calls.indexed = true; return { indexedFiles: 1, totalChunks: 1, status: 'completed' as const }; },
        reindexByChange: async () => {
            calls.reindexed = true;
            if (options.reindexError) throw options.reindexError;
            return { added: 0, removed: 0, modified: 0 };
        },
    } as unknown as Context;
    return { context, calls };
}

test("runIncrementalSync recovers from an embedding-model mismatch by force re-indexing when the flag is set", async () => {
    await withTempHome(async (tempRoot) => {
        const repoPath = path.join(tempRoot, "repo");
        await fs.mkdir(repoPath, { recursive: true });
        await fs.writeFile(path.join(repoPath, "a.ts"), "export const a = 1;\n");

        const { context, calls } = fakeReindexContext({
            reindexError: new EmbeddingModelMismatchError("collection tagged openai/ada, indexer is voyage/code-3"),
        });

        await runIncrementalSync(context, repoPath, "acme/widgets", true);

        assert.equal(calls.reindexed, true);
        assert.deepEqual(calls.forcedPrepare, [true], "recovery must force-recreate the collection");
        assert.equal(calls.indexed, true, "recovery must run a full index with the new model");
    });
});

test("runIncrementalSync surfaces an embedding-model mismatch as a failure when the flag is off", async () => {
    await withTempHome(async (tempRoot) => {
        const repoPath = path.join(tempRoot, "repo");
        await fs.mkdir(repoPath, { recursive: true });

        const { context, calls } = fakeReindexContext({
            reindexError: new EmbeddingModelMismatchError("collection tagged openai/ada, indexer is voyage/code-3"),
        });

        await assert.rejects(
            () => runIncrementalSync(context, repoPath, "acme/widgets", false),
            (error: Error) => error instanceof EmbeddingModelMismatchError && /SYNC_FORCE_REINDEX_ON_MODEL_MISMATCH/.test(error.message)
        );
        assert.equal(calls.indexed, false, "must not silently rebuild without the flag");
    });
});

test("runIncrementalSync deletes the stale merkle snapshot before a model-mismatch rebuild, so a crashed rebuild retries", async () => {
    await withTempHome(async (tempRoot) => {
        const repoPath = path.join(tempRoot, "repo");
        await fs.mkdir(repoPath, { recursive: true });
        await fs.writeFile(path.join(repoPath, "a.ts"), "export const a = 1;\n");

        // A snapshot from the OLD model's era exists on disk.
        const oldSynchronizer = new FileSynchronizer(repoPath, [], ['.ts']);
        await oldSynchronizer.initialize();
        assert.equal(await FileSynchronizer.hasSnapshot(repoPath), true);

        // Recovery drops/recreates the collection, then indexing crashes
        // (quota, Milvus hiccup, pod killed). If the old snapshot survived,
        // the next run would take the incremental branch, find zero changes
        // against it, and report an EMPTY collection healthy forever.
        const { context } = fakeReindexContext({
            reindexError: new EmbeddingModelMismatchError("collection tagged openai/ada, indexer is voyage/code-3"),
        });
        (context as unknown as { indexCodebase: () => Promise<unknown> }).indexCodebase = async () => {
            throw new Error("embedding quota exhausted");
        };

        await assert.rejects(() => runIncrementalSync(context, repoPath, "acme/widgets", true), /embedding quota exhausted/);

        assert.equal(
            await FileSynchronizer.hasSnapshot(repoPath),
            false,
            "the stale snapshot must be gone so the next run lands in the full-rebuild branch"
        );
    });
});

test("runIncrementalSync does not treat other reindex failures as model mismatches", async () => {
    await withTempHome(async (tempRoot) => {
        const repoPath = path.join(tempRoot, "repo");
        await fs.mkdir(repoPath, { recursive: true });

        const { context, calls } = fakeReindexContext({ reindexError: new Error("milvus unavailable") });

        await assert.rejects(() => runIncrementalSync(context, repoPath, "acme/widgets", true), /milvus unavailable/);
        assert.equal(calls.indexed, false, "an unrelated failure must never trigger a destructive force reindex");
    });
});
