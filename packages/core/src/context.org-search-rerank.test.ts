import { Context } from './context';
import { Embedding, EmbeddingVector } from './embedding';
import { VectorDatabase } from './vectordb';

class TestEmbedding extends Embedding {
    protected maxTokens = 8192;

    async detectDimension(): Promise<number> {
        return 3;
    }

    async embed(text: string): Promise<EmbeddingVector> {
        return { vector: [1, 0, 0], dimension: 3 };
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map(() => ({ vector: [1, 0, 0], dimension: 3 }));
    }

    getDimension(): number {
        return 3;
    }

    getProvider(): string {
        return 'test';
    }
}

const createVectorDatabase = (): jest.Mocked<VectorDatabase> => ({
    createCollection: jest.fn().mockResolvedValue(undefined),
    createHybridCollection: jest.fn().mockResolvedValue(undefined),
    dropCollection: jest.fn().mockResolvedValue(undefined),
    hasCollection: jest.fn().mockResolvedValue(true),
    listCollections: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockResolvedValue(undefined),
    insertHybrid: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue([]),
    hybridSearch: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
    getCollectionDescription: jest.fn().mockResolvedValue(''),
    checkCollectionLimit: jest.fn().mockResolvedValue(true),
    getCollectionRowCount: jest.fn().mockResolvedValue(0),
});

const chunk = (id: string, relativePath: string, vector: number[]) => ({
    id,
    vector,
    content: `content of ${relativePath}`,
    relativePath,
    startLine: 1,
    endLine: 10,
    fileExtension: '.ts',
    metadata: { language: 'typescript' },
});

// Every hybrid collection's #1 candidate carries the same RRF score
// (1/(k+1) + 1/(k+1) with k=100), regardless of how relevant it actually is.
const RRF_TOP_SCORE = 2 / 101;

describe('semanticSearchAllRepos cross-collection ranking', () => {
    test('re-ranks hybrid candidates by dense cosine similarity, not per-collection RRF score', async () => {
        // Reproduces the search_org bug: two repos, each hybrid search returns its own
        // local #1 with the identical RRF score. The collection enumerated FIRST holds
        // the irrelevant chunk (a README far from the query); the one enumerated second
        // holds the truly relevant chunk. Merging by RRF score is a tie, so the stable
        // sort surfaces the irrelevant chunk first — the bug. Correct behavior is to
        // order by actual similarity to the query.
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.listCollections.mockResolvedValue([
            'hybrid_code_chunks_aaaaaaaa',
            'hybrid_code_chunks_bbbbbbbb',
        ]);
        vectorDatabase.getCollectionDescription.mockImplementation(async (name: string) => {
            if (name === 'hybrid_code_chunks_aaaaaaaa') return 'repo:github.com/bigabid/tiny-repo;codebasePath:/home/x/tiny-repo';
            if (name === 'hybrid_code_chunks_bbbbbbbb') return 'repo:github.com/bigabid/events-system;codebasePath:/home/x/events-system';
            return '';
        });
        vectorDatabase.hybridSearch.mockImplementation(async (collectionName: string) => {
            if (collectionName === 'hybrid_code_chunks_aaaaaaaa') {
                // Query embedding is [1,0,0]; this chunk is nearly orthogonal to it.
                return [{ document: chunk('a-1', 'README.md', [0.1, 1, 0]), score: RRF_TOP_SCORE }];
            }
            // Same RRF score, but the chunk actually matches the query.
            return [{ document: chunk('b-1', 'clickHandler.ts', [2, 0, 0]), score: RRF_TOP_SCORE }];
        });
        const context = new Context({ vectorDatabase, embedding: new TestEmbedding() });

        const results = await context.semanticSearchAllRepos('click trackers sent to mmp');

        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({
            relativePath: 'clickHandler.ts',
            repo: 'github.com/bigabid/events-system',
        });
        // Scores are now cosine similarities: [2,0,0] vs [1,0,0] → 1; [0.1,1,0] vs [1,0,0] → ~0.0995.
        expect(results[0].score).toBeCloseTo(1, 5);
        expect(results[1].score).toBeCloseTo(0.0995, 3);
    });

    test('asks the vector DB to return candidate vectors for the re-rank', async () => {
        // Without includeVector, real Milvus omits the vector field and the re-rank
        // would silently operate on empty vectors — mocks would hide that.
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.listCollections.mockResolvedValue(['hybrid_code_chunks_aaaaaaaa']);
        vectorDatabase.getCollectionDescription.mockResolvedValue('repo:github.com/bigabid/repo-a;codebasePath:/home/x/repo-a');
        vectorDatabase.hybridSearch.mockResolvedValue([
            { document: chunk('a-1', 'a.ts', [1, 0, 0]), score: RRF_TOP_SCORE },
        ]);
        const context = new Context({ vectorDatabase, embedding: new TestEmbedding() });

        await context.semanticSearchAllRepos('anything');

        expect(vectorDatabase.hybridSearch).toHaveBeenCalledWith(
            'hybrid_code_chunks_aaaaaaaa',
            expect.any(Array),
            expect.objectContaining({ includeVector: true })
        );
    });

    test('a hybrid candidate with no stored vector ranks below every cosine-scored result, even a negative one', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.listCollections.mockResolvedValue([
            'hybrid_code_chunks_aaaaaaaa',
            'hybrid_code_chunks_bbbbbbbb',
        ]);
        vectorDatabase.getCollectionDescription.mockImplementation(async (name: string) => {
            if (name === 'hybrid_code_chunks_aaaaaaaa') return 'repo:github.com/bigabid/repo-a;codebasePath:/home/x/repo-a';
            return 'repo:github.com/bigabid/repo-b;codebasePath:/home/x/repo-b';
        });
        vectorDatabase.hybridSearch.mockImplementation(async (collectionName: string) => {
            if (collectionName === 'hybrid_code_chunks_aaaaaaaa') {
                // Vector missing (e.g. legacy collection) — cannot be re-scored.
                return [{ document: { ...chunk('a-1', 'legacy.ts', []), vector: [] }, score: RRF_TOP_SCORE }];
            }
            // A terrible but real cosine match (-1, below the RRF score) must
            // still outrank an un-rescorable candidate: a verified similarity —
            // however low — is more information than no similarity at all.
            return [{ document: chunk('b-1', 'weak.ts', [-1, 0, 0]), score: RRF_TOP_SCORE }];
        });
        const context = new Context({ vectorDatabase, embedding: new TestEmbedding() });

        const results = await context.semanticSearchAllRepos('anything');

        expect(results).toHaveLength(2);
        expect(results[0].relativePath).toBe('weak.ts');
        expect(results[0].score).toBeCloseTo(-1, 5);
        // The unscorable candidate keeps its RRF score for display but ranks last.
        expect(results[1].relativePath).toBe('legacy.ts');
        expect(results[1].score).toBeCloseTo(RRF_TOP_SCORE, 5);
    });
});
