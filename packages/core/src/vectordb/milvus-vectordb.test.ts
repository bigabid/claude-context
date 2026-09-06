import { MilvusVectorDatabase } from './milvus-vectordb';

// The Milvus gRPC SDK does not throw on a failed describeCollection — it
// returns status.error_code !== 'Success' with no schema. If that is not
// checked, a status-level failure (rate limit, partial outage, RBAC) reads as
// an empty description, and the embedding-model guard "assumes match" and
// proceeds — the exact silent vector-space mixing it exists to prevent.
// Instantiated via Object.create to skip the constructor's real gRPC client.
function databaseWithClient(client: unknown): MilvusVectorDatabase {
    const db = Object.create(MilvusVectorDatabase.prototype) as MilvusVectorDatabase;
    (db as unknown as { initializationPromise: Promise<void> }).initializationPromise = Promise.resolve();
    (db as unknown as { client: unknown }).client = client;
    return db;
}

describe('MilvusVectorDatabase.getCollectionDescription', () => {
    test('throws when Milvus reports a status-level failure instead of returning an empty description', async () => {
        const db = databaseWithClient({
            describeCollection: async () => ({
                status: { error_code: 'RateLimit', reason: 'rate limited' },
            }),
        });

        await expect(db.getCollectionDescription('hybrid_code_chunks_test')).rejects.toThrow(/rate limited/);
    });

    test('returns the description on success', async () => {
        const db = databaseWithClient({
            describeCollection: async () => ({
                status: { error_code: 'Success', reason: '' },
                schema: { description: 'repo:github.com/bigabid/x;codebasePath:/home/x' },
            }),
        });

        await expect(db.getCollectionDescription('hybrid_code_chunks_test'))
            .resolves.toBe('repo:github.com/bigabid/x;codebasePath:/home/x');
    });
});
