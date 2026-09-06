import OpenAI from 'openai';
import { OpenAIEmbedding } from './openai-embedding';

const mockCreate = jest.fn();

jest.mock('openai', () => {
    return jest.fn().mockImplementation(() => ({
        embeddings: { create: mockCreate },
    }));
});

function fakeEmbeddingResponse(dimension: number, count: number = 1) {
    return {
        data: Array.from({ length: count }, () => ({ embedding: new Array(dimension).fill(0.1) })),
    };
}

describe('OpenAIEmbedding dimension detection caching', () => {
    beforeEach(() => {
        mockCreate.mockReset();
        (OpenAI as unknown as jest.Mock).mockClear();
    });

    it('known models never call the API to detect dimension', async () => {
        const embedding = new OpenAIEmbedding({ apiKey: 'test', model: 'text-embedding-3-small' });

        await expect(embedding.detectDimension()).resolves.toBe(1536);
        await expect(embedding.detectDimension()).resolves.toBe(1536);

        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('custom models only call the API once across repeated detectDimension() calls', async () => {
        mockCreate.mockResolvedValue(fakeEmbeddingResponse(768));
        const embedding = new OpenAIEmbedding({ apiKey: 'test', model: 'jina-code-embeddings-1.5b' });

        await expect(embedding.detectDimension()).resolves.toBe(768);
        await expect(embedding.detectDimension()).resolves.toBe(768);
        await expect(embedding.detectDimension()).resolves.toBe(768);

        expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('embed() does not trigger a redundant dimension-detection call on every invocation for a custom model', async () => {
        mockCreate.mockResolvedValue(fakeEmbeddingResponse(768));
        const embedding = new OpenAIEmbedding({ apiKey: 'test', model: 'jina-code-embeddings-1.5b' });

        await embedding.embed('chunk one');
        await embedding.embed('chunk two');
        await embedding.embed('chunk three');

        // 1 real embed call each = 3, with zero extra calls from re-detecting
        // the dimension before each one (that used to be a 2nd call per embed()).
        expect(mockCreate).toHaveBeenCalledTimes(3);
    });

    it('embedBatch() does not trigger a redundant dimension-detection call on every invocation for a custom model', async () => {
        mockCreate.mockResolvedValue(fakeEmbeddingResponse(768, 5));
        const embedding = new OpenAIEmbedding({ apiKey: 'test', model: 'jina-code-embeddings-1.5b' });

        await embedding.embedBatch(['a', 'b', 'c', 'd', 'e']);
        await embedding.embedBatch(['f', 'g']);

        expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('setModel() invalidates the cache so the new model is re-detected', async () => {
        mockCreate.mockResolvedValue(fakeEmbeddingResponse(768));
        const embedding = new OpenAIEmbedding({ apiKey: 'test', model: 'jina-code-embeddings-1.5b' });
        await embedding.detectDimension();
        expect(mockCreate).toHaveBeenCalledTimes(1);

        mockCreate.mockResolvedValue(fakeEmbeddingResponse(1024));
        await embedding.setModel('another-custom-model');

        expect(mockCreate).toHaveBeenCalledTimes(2);
        await expect(embedding.detectDimension()).resolves.toBe(1024);
        expect(mockCreate).toHaveBeenCalledTimes(2); // still cached after setModel
    });
});
