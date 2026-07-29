import * as fs from "fs";
import { envManager } from "@bigabid/claude-context-core";

export interface SyncWorkerConfig {
    // GitHub App auth
    githubAppId: string;
    githubAppPrivateKey: string;
    githubAppInstallationId: number;

    // Repo discovery
    githubOrg?: string;
    excludeRepos: string[];
    includeArchived: boolean;
    includeForks: boolean;

    // Local checkout
    reposDir: string;

    // Embedding provider (mirrors packages/mcp/src/config.ts's shape)
    embeddingProvider: 'OpenAI' | 'VoyageAI' | 'Gemini' | 'Ollama' | 'OpenRouter' | 'Bedrock';
    embeddingModel: string;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    voyageaiApiKey?: string;
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    openrouterApiKey?: string;
    ollamaModel?: string;
    ollamaHost?: string;
    ollamaDimension?: number;
    bedrockRegion?: string;
    bedrockAccessKeyId?: string;
    bedrockSecretAccessKey?: string;
    bedrockSessionToken?: string;
    bedrockEndpoint?: string;
    bedrockDimension?: number;

    // Vector database
    milvusAddress?: string;
    milvusToken?: string;
    collectionNameOverride?: string;
}

function requireEnv(name: string): string {
    const value = envManager.get(name);
    if (!value) {
        throw new Error(`${name} is required`);
    }
    return value;
}

function getPositiveIntegerFromEnv(name: string): number | undefined {
    const rawValue = envManager.get(name);
    if (!rawValue) {
        return undefined;
    }
    const parsedValue = Number(rawValue);
    if (Number.isInteger(parsedValue) && parsedValue > 0) {
        return parsedValue;
    }
    console.warn(`[CONFIG] ⚠️  Ignoring invalid ${name}: ${rawValue}. Expected a positive integer.`);
    return undefined;
}

function loadGithubAppPrivateKey(): string {
    const inline = envManager.get('GITHUB_APP_PRIVATE_KEY');
    if (inline) {
        // PEM files often get their newlines collapsed when passed through a
        // single-line env var / k8s Secret literal - restore them.
        return inline.includes('\\n') ? inline.replace(/\\n/g, '\n') : inline;
    }
    const keyPath = envManager.get('GITHUB_APP_PRIVATE_KEY_PATH');
    if (keyPath) {
        return fs.readFileSync(keyPath, 'utf-8');
    }
    throw new Error('One of GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH is required');
}

/**
 * This worker is meant to converge on the SAME collections laptops/CI already
 * write to via CODE_CHUNKS_COLLECTION_KEY_SOURCE=git-remote (see context.ts's
 * getCollectionName). Running with the default (path-based) hashing would
 * silently create a parallel, orphaned collection per repo instead of
 * updating the real one - fail fast rather than let that happen quietly.
 */
function validateCollectionKeySource(): void {
    const keySource = envManager.get('CODE_CHUNKS_COLLECTION_KEY_SOURCE');
    if (keySource?.trim().toLowerCase() !== 'git-remote') {
        throw new Error(
            `CODE_CHUNKS_COLLECTION_KEY_SOURCE must be set to 'git-remote' for this worker ` +
            `(found: ${keySource ? `'${keySource}'` : 'unset'}). Without it, this worker would index ` +
            `into collections keyed off its own pod-internal checkout path instead of each repo's git ` +
            `identity, creating parallel collections that searchers never see.`
        );
    }
}

export function loadConfig(): SyncWorkerConfig {
    validateCollectionKeySource();

    const excludeReposRaw = envManager.get('SYNC_EXCLUDE_REPOS') || '';

    return {
        githubAppId: requireEnv('GITHUB_APP_ID'),
        githubAppPrivateKey: loadGithubAppPrivateKey(),
        githubAppInstallationId: Number(requireEnv('GITHUB_APP_INSTALLATION_ID')),

        githubOrg: envManager.get('GITHUB_ORG'),
        excludeRepos: excludeReposRaw.split(',').map((r) => r.trim()).filter((r) => r.length > 0),
        includeArchived: (envManager.get('SYNC_INCLUDE_ARCHIVED') || '').toLowerCase() === 'true',
        includeForks: (envManager.get('SYNC_INCLUDE_FORKS') || '').toLowerCase() === 'true',

        reposDir: envManager.get('SYNC_REPOS_DIR') || '/data/repos',

        embeddingProvider: (envManager.get('EMBEDDING_PROVIDER') as SyncWorkerConfig['embeddingProvider']) || 'OpenAI',
        embeddingModel: envManager.get('EMBEDDING_MODEL') || '',
        openaiApiKey: envManager.get('OPENAI_API_KEY'),
        openaiBaseUrl: envManager.get('OPENAI_BASE_URL'),
        voyageaiApiKey: envManager.get('VOYAGEAI_API_KEY'),
        geminiApiKey: envManager.get('GEMINI_API_KEY'),
        geminiBaseUrl: envManager.get('GEMINI_BASE_URL'),
        openrouterApiKey: envManager.get('OPENROUTER_API_KEY'),
        ollamaModel: envManager.get('OLLAMA_MODEL'),
        ollamaHost: envManager.get('OLLAMA_HOST'),
        ollamaDimension: getPositiveIntegerFromEnv('EMBEDDING_DIMENSION'),
        bedrockRegion: envManager.get('BEDROCK_REGION') || envManager.get('AWS_REGION'),
        bedrockAccessKeyId: envManager.get('BEDROCK_ACCESS_KEY_ID'),
        bedrockSecretAccessKey: envManager.get('BEDROCK_SECRET_ACCESS_KEY'),
        bedrockSessionToken: envManager.get('BEDROCK_SESSION_TOKEN'),
        bedrockEndpoint: envManager.get('BEDROCK_ENDPOINT'),
        bedrockDimension: getPositiveIntegerFromEnv('BEDROCK_EMBEDDING_DIMENSION'),

        milvusAddress: envManager.get('MILVUS_ADDRESS'),
        milvusToken: envManager.get('MILVUS_TOKEN'),
        collectionNameOverride: envManager.get('CODE_CHUNKS_COLLECTION_NAME_OVERRIDE')
    };
}
