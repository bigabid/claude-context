import { OpenAIEmbedding, VoyageAIEmbedding, GeminiEmbedding, OllamaEmbedding, BedrockEmbedding } from "@bigabid/claude-context-core";
import { SyncWorkerConfig } from "./config.js";

type EmbeddingInstance = OpenAIEmbedding | VoyageAIEmbedding | GeminiEmbedding | OllamaEmbedding | BedrockEmbedding;

// Mirrors packages/mcp/src/embedding.ts's createEmbeddingInstance - kept as a
// separate small copy rather than a shared dependency so this package doesn't
// need to depend on the mcp package for an unrelated concern.
export function createEmbeddingInstance(config: SyncWorkerConfig): EmbeddingInstance {
    console.log(`[EMBEDDING] Creating ${config.embeddingProvider} embedding instance...`);

    switch (config.embeddingProvider) {
        case 'OpenAI':
            if (!config.openaiApiKey) {
                throw new Error('OPENAI_API_KEY is required for OpenAI embedding provider');
            }
            return new OpenAIEmbedding({
                apiKey: config.openaiApiKey,
                model: config.embeddingModel,
                ...(config.openaiBaseUrl && { baseURL: config.openaiBaseUrl })
            });

        case 'VoyageAI':
            if (!config.voyageaiApiKey) {
                throw new Error('VOYAGEAI_API_KEY is required for VoyageAI embedding provider');
            }
            return new VoyageAIEmbedding({
                apiKey: config.voyageaiApiKey,
                model: config.embeddingModel
            });

        case 'Gemini':
            if (!config.geminiApiKey) {
                throw new Error('GEMINI_API_KEY is required for Gemini embedding provider');
            }
            return new GeminiEmbedding({
                apiKey: config.geminiApiKey,
                model: config.embeddingModel,
                ...(config.geminiBaseUrl && { baseURL: config.geminiBaseUrl })
            });

        case 'OpenRouter':
            if (!config.openrouterApiKey) {
                throw new Error('OPENROUTER_API_KEY is required for OpenRouter embedding provider');
            }
            return new OpenAIEmbedding({
                apiKey: config.openrouterApiKey,
                model: config.embeddingModel,
                baseURL: 'https://openrouter.ai/api/v1'
            });

        case 'Ollama':
            return new OllamaEmbedding({
                model: config.embeddingModel,
                host: config.ollamaHost || 'http://127.0.0.1:11434',
                ...(config.ollamaDimension && { dimension: config.ollamaDimension })
            });

        case 'Bedrock':
            if (!config.bedrockRegion) {
                throw new Error('BEDROCK_REGION (or AWS_REGION) is required for Bedrock embedding provider');
            }
            if (config.bedrockAccessKeyId && !config.bedrockSecretAccessKey) {
                throw new Error('BEDROCK_SECRET_ACCESS_KEY is required when BEDROCK_ACCESS_KEY_ID is set');
            }
            return new BedrockEmbedding({
                model: config.embeddingModel,
                region: config.bedrockRegion,
                ...(config.bedrockAccessKeyId && { accessKeyId: config.bedrockAccessKeyId }),
                ...(config.bedrockSecretAccessKey && { secretAccessKey: config.bedrockSecretAccessKey }),
                ...(config.bedrockSessionToken && { sessionToken: config.bedrockSessionToken }),
                ...(config.bedrockEndpoint && { endpoint: config.bedrockEndpoint }),
                ...(config.bedrockDimension && { dimension: config.bedrockDimension })
            });

        default:
            throw new Error(`Unsupported embedding provider: ${config.embeddingProvider}`);
    }
}
