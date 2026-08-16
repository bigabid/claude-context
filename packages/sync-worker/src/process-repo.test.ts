import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileSynchronizer, type Context } from "@bigabid/claude-context-core";
import { runFirstIndex } from "./process-repo.js";

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
