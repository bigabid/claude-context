import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Context } from './context';
import { Embedding, EmbeddingVector } from './embedding';
import { VectorDatabase } from './vectordb';

class TestEmbedding extends Embedding {
    protected maxTokens = 8192;
    public embedCallCount = 0;

    async detectDimension(): Promise<number> {
        return 3;
    }

    async embed(text: string): Promise<EmbeddingVector> {
        this.embedCallCount++;
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
    hasCollection: jest.fn().mockResolvedValue(false),
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

async function writeGitOriginConfig(repoDir: string, url: string): Promise<void> {
    const gitDir = path.join(repoDir, '.git');
    await fs.mkdir(gitDir, { recursive: true });
    const config = [
        '[core]',
        '\trepositoryformatversion = 0',
        '[remote "origin"]',
        `\turl = ${url}`,
        ''
    ].join('\n');
    await fs.writeFile(path.join(gitDir, 'config'), config, 'utf-8');
}

describe('Context repo-identity search (no local checkout required)', () => {
    let tempRoot: string;
    let originalHybridMode: string | undefined;

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-context-repo-search-'));
        originalHybridMode = process.env.HYBRID_MODE;
        process.env.HYBRID_MODE = 'false';
    });

    afterEach(async () => {
        if (originalHybridMode === undefined) {
            delete process.env.HYBRID_MODE;
        } else {
            process.env.HYBRID_MODE = originalHybridMode;
        }
        await fs.rm(tempRoot, { recursive: true, force: true });
    });

    test('getCollectionNameForRepo matches getCollectionName for the same repo identity', async () => {
        const checkout = path.join(tempRoot, 'checkout');
        await fs.mkdir(checkout, { recursive: true });
        await writeGitOriginConfig(checkout, 'https://github.com/bigabid/core-mwaa.git');

        const context = new Context({ vectorDatabase: createVectorDatabase() });

        const fromRepoIdentity = context.getCollectionNameForRepo('github.com/bigabid/core-mwaa');
        const fromSshUrl = context.getCollectionNameForRepo('git@github.com:bigabid/core-mwaa.git');

        expect(fromRepoIdentity).toBe(fromSshUrl);
        // Must also match what a real (local, git-remote-keyed) checkout resolves to.
        const originalKeySource = process.env.CODE_CHUNKS_COLLECTION_KEY_SOURCE;
        process.env.CODE_CHUNKS_COLLECTION_KEY_SOURCE = 'git-remote';
        try {
            expect(context.getCollectionName(checkout)).toBe(fromRepoIdentity);
        } finally {
            if (originalKeySource === undefined) {
                delete process.env.CODE_CHUNKS_COLLECTION_KEY_SOURCE;
            } else {
                process.env.CODE_CHUNKS_COLLECTION_KEY_SOURCE = originalKeySource;
            }
        }
    });

    test('hasIndexForRepo delegates to hasCollection using the repo-derived name', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.hasCollection.mockResolvedValue(true);
        const context = new Context({ vectorDatabase });

        const result = await context.hasIndexForRepo('github.com/bigabid/core-mwaa');

        expect(result).toBe(true);
        expect(vectorDatabase.hasCollection).toHaveBeenCalledWith(
            context.getCollectionNameForRepo('github.com/bigabid/core-mwaa')
        );
    });

    test('hasIndexForRepo falls back to a description scan when the hashed name is a HYBRID_MODE mismatch', async () => {
        // Simulates: repo was indexed by someone with HYBRID_MODE=true (or a
        // CODE_CHUNKS_COLLECTION_NAME_OVERRIDE), so the searcher's own hash
        // (computed with HYBRID_MODE=false here) doesn't exist, but the real
        // collection is still discoverable via its recorded `repo:` identity.
        const vectorDatabase = createVectorDatabase();
        const context = new Context({ vectorDatabase });
        const hashedName = context.getCollectionNameForRepo('github.com/bigabid/core-mwaa');

        vectorDatabase.hasCollection.mockImplementation(async (name: string) => name !== hashedName && name === 'hybrid_code_chunks_deadbeef');
        vectorDatabase.listCollections.mockResolvedValue(['hybrid_code_chunks_deadbeef']);
        vectorDatabase.getCollectionDescription.mockResolvedValue(
            'repo:github.com/bigabid/core-mwaa;codebasePath:/home/other/core-mwaa'
        );

        const result = await context.hasIndexForRepo('github.com/bigabid/core-mwaa');

        expect(result).toBe(true);
    });

    test('semanticSearchByRepo searches the repo-derived collection without touching the filesystem', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.hasCollection.mockResolvedValue(true);
        vectorDatabase.search.mockResolvedValue([
            {
                document: {
                    id: 'chunk-1',
                    vector: [0.1, 0.2, 0.3],
                    content: 'def handler(): pass',
                    relativePath: 'dags/example.py',
                    startLine: 1,
                    endLine: 1,
                    fileExtension: '.py',
                    metadata: { language: 'python' }
                },
                score: 0.9
            }
        ]);
        const context = new Context({ vectorDatabase, embedding: new TestEmbedding() });

        const results = await context.semanticSearchByRepo('github.com/bigabid/core-mwaa', 'airflow dag handler');

        expect(results).toHaveLength(1);
        expect(results[0].relativePath).toBe('dags/example.py');
        expect(vectorDatabase.search).toHaveBeenCalledWith(
            context.getCollectionNameForRepo('github.com/bigabid/core-mwaa'),
            expect.any(Array),
            expect.any(Object)
        );
    });

    test('listIndexedRepos parses repo identity and codebasePath out of collection descriptions', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.listCollections.mockResolvedValue([
            'code_chunks_aaaaaaaa',
            'hybrid_code_chunks_bbbbbbbb',
            'not_a_code_collection'
        ]);
        vectorDatabase.getCollectionDescription.mockImplementation(async (name: string) => {
            if (name === 'code_chunks_aaaaaaaa') {
                return 'repo:github.com/bigabid/core-mwaa;codebasePath:/home/itai/workspace/core-mwaa';
            }
            if (name === 'hybrid_code_chunks_bbbbbbbb') {
                // Legacy collection indexed before repo-identity tracking existed.
                return 'codebasePath:C:\\Users\\alex\\rtb-engine';
            }
            return '';
        });
        const context = new Context({ vectorDatabase });

        const repos = await context.listIndexedRepos();

        expect(repos).toHaveLength(2);
        expect(repos).toContainEqual({
            collectionName: 'code_chunks_aaaaaaaa',
            repo: 'github.com/bigabid/core-mwaa',
            codebasePath: '/home/itai/workspace/core-mwaa'
        });
        expect(repos).toContainEqual({
            collectionName: 'hybrid_code_chunks_bbbbbbbb',
            repo: undefined,
            codebasePath: 'C:\\Users\\alex\\rtb-engine'
        });
    });

    test('listIndexedRepos survives a codebasePath containing a literal semicolon (legal on Linux/Mac)', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.listCollections.mockResolvedValue(['code_chunks_cccccccc']);
        vectorDatabase.getCollectionDescription.mockResolvedValue(
            'repo:github.com/bigabid/core-mwaa;codebasePath:/home/itai/workspace/weird;name'
        );
        const context = new Context({ vectorDatabase });

        const repos = await context.listIndexedRepos();

        expect(repos).toContainEqual({
            collectionName: 'code_chunks_cccccccc',
            repo: 'github.com/bigabid/core-mwaa',
            codebasePath: '/home/itai/workspace/weird;name'
        });
    });

    test('semanticSearchAllRepos fans out across every indexed collection, embeds the query once, and returns results ranked by score', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.listCollections.mockResolvedValue(['code_chunks_aaaaaaaa', 'hybrid_code_chunks_bbbbbbbb']);
        vectorDatabase.getCollectionDescription.mockImplementation(async (name: string) => {
            if (name === 'code_chunks_aaaaaaaa') return 'repo:github.com/bigabid/repo-a;codebasePath:/home/x/repo-a';
            if (name === 'hybrid_code_chunks_bbbbbbbb') return 'repo:github.com/bigabid/repo-b;codebasePath:/home/x/repo-b';
            return '';
        });
        vectorDatabase.hasCollection.mockResolvedValue(true);
        vectorDatabase.search.mockResolvedValue([
            {
                document: {
                    id: 'a-1', vector: [1, 0, 0], content: 'low score match', relativePath: 'a.py',
                    startLine: 1, endLine: 1, fileExtension: '.py', metadata: { language: 'python' }
                },
                score: 0.3
            }
        ]);
        vectorDatabase.hybridSearch.mockResolvedValue([
            {
                document: {
                    id: 'b-1', vector: [1, 0, 0], content: 'high score match', relativePath: 'b.py',
                    startLine: 1, endLine: 1, fileExtension: '.py', metadata: { language: 'python' }
                },
                score: 0.9
            }
        ]);
        const embedding = new TestEmbedding();
        const context = new Context({ vectorDatabase, embedding });

        const results = await context.semanticSearchAllRepos('handler');

        expect(embedding.embedCallCount).toBe(1);
        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({ relativePath: 'b.py', repo: 'github.com/bigabid/repo-b', collectionName: 'hybrid_code_chunks_bbbbbbbb', score: 0.9 });
        expect(results[1]).toMatchObject({ relativePath: 'a.py', repo: 'github.com/bigabid/repo-a', collectionName: 'code_chunks_aaaaaaaa', score: 0.3 });
    });

    test('semanticSearchAllRepos skips a collection that errors (e.g. embedding-dimension mismatch) instead of failing the whole search', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.listCollections.mockResolvedValue(['code_chunks_aaaaaaaa', 'code_chunks_dddddddd']);
        vectorDatabase.getCollectionDescription.mockImplementation(async (name: string) => {
            if (name === 'code_chunks_aaaaaaaa') return 'repo:github.com/bigabid/repo-a;codebasePath:/home/x/repo-a';
            if (name === 'code_chunks_dddddddd') return 'repo:github.com/bigabid/repo-d;codebasePath:/home/x/repo-d';
            return '';
        });
        vectorDatabase.hasCollection.mockResolvedValue(true);
        vectorDatabase.search.mockImplementation(async (collectionName: string) => {
            if (collectionName === 'code_chunks_dddddddd') {
                throw new Error('vector dimension 3 does not match collection schema dimension 1536');
            }
            return [
                {
                    document: {
                        id: 'a-1', vector: [1, 0, 0], content: 'match', relativePath: 'a.py',
                        startLine: 1, endLine: 1, fileExtension: '.py', metadata: { language: 'python' }
                    },
                    score: 0.5
                }
            ];
        });
        const context = new Context({ vectorDatabase, embedding: new TestEmbedding() });

        const results = await context.semanticSearchAllRepos('handler');

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ relativePath: 'a.py', repo: 'github.com/bigabid/repo-a' });
    });

    test('semanticSearchAllRepos returns an empty array when no repos are indexed', async () => {
        const vectorDatabase = createVectorDatabase();
        vectorDatabase.listCollections.mockResolvedValue([]);
        const context = new Context({ vectorDatabase, embedding: new TestEmbedding() });

        const results = await context.semanticSearchAllRepos('handler');

        expect(results).toEqual([]);
    });
});
