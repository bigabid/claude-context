#!/usr/bin/env node

// CRITICAL: Redirect console outputs to stderr IMMEDIATELY to avoid interfering with MCP JSON protocol
// Only MCP protocol messages should go to stdout
//
// MCP_LOG_LEVEL (debug|info|warn|error, default info) gates verbosity - this
// matters most for the shared HTTP deployment, where every log line lands in
// a shared pod's `kubectl logs`. Rather than retrofitting an explicit level
// onto every one of this package's ~180 call sites, we classify by how the
// call was already made: console.error is always shown (never filtered);
// console.warn is 'warn'; console.log is 'debug' if its message carries a
// "...DEBUG]" tag (e.g. [DEBUG], [SYNC-DEBUG], [SNAPSHOT-DEBUG] - the existing
// convention for internal tracing) and 'info' otherwise. Read directly from
// process.env (not envManager's ~/.context/.env fallback) since this must
// resolve before any other module - including core, where envManager lives -
// finishes loading.
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevelName = keyof typeof LOG_LEVELS;
const rawLogLevel = (process.env.MCP_LOG_LEVEL || 'info').trim().toLowerCase();
const resolvedLogLevel: LogLevelName = (rawLogLevel in LOG_LEVELS ? rawLogLevel : 'info') as LogLevelName;
const logLevelThreshold = LOG_LEVELS[resolvedLogLevel];
const DEBUG_TAG_PATTERN = /\[[\w-]*DEBUG\]/;
// HTTP transport auth is optional (MCP_HTTP_AUTH_TOKEN unset only logs a
// warning), so cap request body size to stop an unauthenticated client from
// OOMing the pod with a large POST.
const MAX_HTTP_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

function shouldLog(level: LogLevelName): boolean {
    return LOG_LEVELS[level] >= logLevelThreshold;
}

console.log = (...args: any[]) => {
    const message = args.join(' ');
    const level: LogLevelName = DEBUG_TAG_PATTERN.test(message) ? 'debug' : 'info';
    if (shouldLog(level)) {
        process.stderr.write('[LOG] ' + message + '\n');
    }
};

console.warn = (...args: any[]) => {
    if (shouldLog('warn')) {
        process.stderr.write('[WARN] ' + args.join(' ') + '\n');
    }
};

// console.error already goes to stderr by default, and is never filtered by MCP_LOG_LEVEL.

if (!(rawLogLevel in LOG_LEVELS)) {
    process.stderr.write(`[WARN] Ignoring invalid MCP_LOG_LEVEL '${rawLogLevel}' (expected debug|info|warn|error) - defaulting to 'info'.\n`);
}
process.stderr.write(`[LOG] [MCP] Log level: ${resolvedLogLevel} (set MCP_LOG_LEVEL=warn or =error to reduce noise; this line always prints regardless of level)\n`);

// An unreachable Milvus (no VPN, ingress down, etc.) surfaces as a rejected
// promise or a gRPC channel error deep in a background task (initial sync,
// periodic sync, the trigger watcher). Node's default behavior for an
// unhandled rejection/exception is to crash the whole process silently from
// the MCP client's point of view — Claude Code just sees the connection
// close, with no indication Milvus was the cause. Log it loudly and keep the
// server alive instead: the next tool call surfaces a real error, and
// background sync/reconnection can recover once Milvus comes back.
process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled promise rejection — server staying alive. This usually means the vector database (Milvus) or embedding endpoint is unreachable:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('[FATAL] Uncaught exception — server staying alive. This usually means the vector database (Milvus) or embedding endpoint is unreachable:', error);
});

import * as http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { Context } from "@bigabid/claude-context-core";
import { MilvusVectorDatabase } from "@bigabid/claude-context-core";

// Import our modular components
import { createMcpConfig, logConfigurationSummary, showHelpMessage, ContextMcpConfig } from "./config.js";
import { createEmbeddingInstance, logEmbeddingProviderInfo } from "./embedding.js";
import { SnapshotManager } from "./snapshot.js";
import { SyncManager } from "./sync.js";
import { ToolHandlers } from "./handlers.js";

class ContextMcpServer {
    private server: Server;
    private config: ContextMcpConfig;
    private context: Context;
    private snapshotManager: SnapshotManager;
    private syncManager: SyncManager;
    private toolHandlers: ToolHandlers;

    constructor(config: ContextMcpConfig) {
        this.config = config;

        // Initialize MCP server (used directly for stdio transport; the http
        // transport spins up a fresh Server + registered tools per request —
        // see startHttpTransport — since StreamableHTTPServerTransport in
        // stateless mode expects one Server per connect() call, not a shared one).
        this.server = new Server(
            {
                name: config.name,
                version: config.version
            },
            {
                capabilities: {
                    tools: {}
                }
            }
        );

        // Initialize embedding provider
        console.log(`[EMBEDDING] Initializing embedding provider: ${config.embeddingProvider}`);
        console.log(`[EMBEDDING] Using model: ${config.embeddingModel}`);

        const embedding = createEmbeddingInstance(config);
        logEmbeddingProviderInfo(config, embedding);

        // Initialize vector database
        const vectorDatabase = new MilvusVectorDatabase({
            address: config.milvusAddress,
            ...(config.milvusToken && { token: config.milvusToken })
        });

        // Initialize Claude Context
        this.context = new Context({
            embedding,
            vectorDatabase,
            collectionNameOverride: config.collectionNameOverride
        });

        // Initialize managers
        this.snapshotManager = new SnapshotManager();
        this.syncManager = new SyncManager(this.context, this.snapshotManager);
        this.toolHandlers = new ToolHandlers(this.context, this.snapshotManager);

        // Load existing codebase snapshot on startup
        this.snapshotManager.loadCodebaseSnapshot();

        this.setupTools(this.server);
    }

    /**
     * Registers the ListTools/CallTool handlers on a given Server instance.
     * Called once for the stdio transport's long-lived Server, and once per
     * request for the http transport's per-request Server — always reusing
     * this same shared this.toolHandlers (and the Context/vectorDatabase it
     * wraps), so tool logic and state are never duplicated per request.
     */
    private setupTools(server: Server) {
        const index_description = `
Index a codebase directory to enable semantic search using a configurable code splitter.

⚠️ **IMPORTANT**:
- You MUST provide an absolute path to the target codebase.

✨ **Usage Guidance**:
- This tool is typically used when search fails due to an unindexed codebase.
- If indexing is attempted on an already indexed path, and a conflict is detected, you MUST prompt the user to confirm whether to proceed with a force index (i.e., re-indexing and overwriting the previous index).
`;


        const search_description = `
Semantic search of ONE repo — the codebase at the given absolute path, i.e. the checkout you are actively working in. PREFER THIS OVER grep/glob/ripgrep for conceptual/semantic search of THAT repo. For questions that aren't scoped to this one checkout, use search_org (any/unknown repo) or search_repo (a different named repo) instead.

⚠️ **IMPORTANT**:
- You MUST provide an absolute path.
- Default to calling this tool BEFORE reaching for grep/glob/find/ripgrep whenever the task is "find code that does X", "understand how Y works", or any other conceptual/semantic question about a codebase you have not already grepped for an exact known string. Grep only wins for a literal string/symbol you already know verbatim.
- Check \`get_indexing_status\` first if you are unsure whether the codebase is indexed; do not assume it isn't and fall back to grep without checking.
- If the question is about a repo that is NOT checked out locally (no absolute path available), use \`search_repo\` instead — it searches by repo identity (e.g. "github.com/org/repo") with no local checkout required. Use \`list_indexed_repos\` first if you don't already know that repo's identity string.
- This searches ONLY the repo at the given path. If the answer might live in another repo, or the question is about "our services / our system" broadly rather than this specific checkout, use \`search_org\` — being inside a checkout does not mean the answer is in it. Stay with search_code only when the answer is clearly in THIS repo.

🎯 **When to Use**:
This tool is versatile and should be used before completing various tasks to retrieve relevant context:
- **Code search**: Find specific functions, classes, or implementations
- **Context-aware assistance**: Gather relevant code context before making changes
- **Issue identification**: Locate problematic code sections or bugs
- **Code review**: Understand existing implementations and patterns
- **Refactoring**: Find all related code pieces that need to be updated
- **Feature development**: Understand existing architecture and similar implementations
- **Duplicate detection**: Identify redundant or duplicated code patterns across the codebase

✨ **Usage Guidance**:
- If the codebase is not indexed, this tool will return a clear error message indicating that indexing is required first.
- You can then use the index_codebase tool to index the codebase before searching again.
`;

        const list_indexed_repos_description = `
List every repo/collection currently indexed in the shared vector database.

🎯 **When to Use**:
- The user wants to know what repos are searchable at all (e.g. "what repos do we have indexed?").
- Before calling search_repo, when you don't already have a repo identity string in hand.
- The user asks a question about a codebase you don't have checked out locally, and search_code (which requires a local path) isn't an option.

✨ **Usage Guidance**:
- Returns each repo's identity string (e.g. "github.com/org/repo") — pass that exact string to search_repo's \`repo\` parameter.
- Collections indexed before this repo-identity tracking existed may show as "unknown repo identity" instead of a name; re-indexing that codebase records it going forward.
- Note: you do NOT need this before search_org — that tool searches all repos with no identity string. Only reach here when you intend to name a single repo for search_repo.
`;

        const search_repo_description = `
Search an indexed repo by its git remote identity (e.g. "github.com/org/repo") instead of a local absolute path — no local checkout of that repo is required at all.

⚠️ **IMPORTANT**:
- Use this to search a specific, named repo that isn't checked out on this machine (identity confirmed via list_indexed_repos). "Named" is the key word — you must know which repo.
- If you don't already know the repo's identity string, call list_indexed_repos first to discover it — don't guess "org/repo" without a host, it won't match.
- Do NOT guess a repo identity. If you are not certain which repo holds the answer, use \`search_org\` instead — it searches every indexed repo at once, so an uncertain guess is never necessary.

🎯 **When to Use**:
- Cross-team code questions: "how does <other team's repo> do X" when you've never cloned it.
- Any search_code use case where requiring a local checkout is the only obstacle.
`;

        const search_org_description = `
Search across EVERY indexed repo in the shared vector database at once. This is the DEFAULT tool for any code question that is NOT anchored to a specific repo you can already name — no repo name, identity string, or local checkout required.

⚠️ **IMPORTANT**:
- Use this whenever the question is cross-cutting — "where/whether/how do we do X across our services", "which repo does Y live in", "how does our system handle Z" — i.e. anything not pinned to one named repo.
- Being inside a local checkout does NOT mean the answer is in that repo. If the question is about "our system / our services" broadly rather than the code you are actively editing, search here — do not narrow to the local repo with search_code by reflex.
- Do NOT guess a repo name to use search_repo/search_code when you are unsure. A wrong guess searches the wrong place (or errors as "not indexed"); searching all repos at once does not. When in doubt about which repo, this is the correct tool, not a last resort.
- Prefer search_repo/search_code ONLY when the answer is clearly scoped to one specific repo you can name (search_repo) or to the checkout you are actively working in (search_code).
- Queries every indexed collection, so it is somewhat slower than a single-repo search. This is a normal, expected cost — not a reason to avoid it.
- Results are merged and ranked by score across repos; each result is labeled with which repo it came from.

🎯 **When to Use**:
- Cross-repo / "which repo" / "across our stack" questions — anything not tied to one named repo.
- You searched a single repo (search_code/search_repo) and found nothing relevant — escalate here instead of giving up or falling back to grep.
- You are about to guess a repo name for search_repo but aren't certain it's right — use this instead.
- Org-wide discovery, whether or not you later narrow to one repo.
`;

        // These tools operate on a local filesystem path, which only makes
        // sense for the stdio transport (one process per user's checkout).
        // Over http, the server is shared/stateless with no local checkout of
        // its own, so these are hidden from the tool list and rejected if
        // called anyway - only the repo-identity query tools (search_repo,
        // search_org, list_indexed_repos) are exposed in that mode.
        //
        // search_code is local-only too, not just by convention but because
        // it's actually broken over http: Context.getGitRemoteIdentity()
        // resolves a repo's collection by reading .git/config from the given
        // path ON THE SERVER'S OWN FILESYSTEM. A caller's local absolute path
        // (e.g. their laptop checkout) doesn't exist on the shared server, so
        // that lookup silently fails and falls back to hashing the raw path
        // string - a collection the sync-worker never created. The tool
        // wouldn't just be a worse choice than search_repo/search_org over
        // http, it would silently return "not indexed" for everything.
        const localOnlyToolNames = new Set(["index_codebase", "clear_index", "get_indexing_status", "search_code"]);
        const isHttp = this.config.transport === 'http';

        // Define available tools
        server.setRequestHandler(ListToolsRequestSchema, async () => {
            const allTools = [
                    {
                        name: "index_codebase",
                        description: index_description,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to index.`
                                },
                                force: {
                                    type: "boolean",
                                    description: "Force re-indexing even if already indexed",
                                    default: false
                                },
                                splitter: {
                                    type: "string",
                                    description: "Code splitter to use: 'ast' for syntax-aware splitting with automatic fallback, 'langchain' for character-based splitting",
                                    enum: ["ast", "langchain"],
                                    default: "ast"
                                },
                                customExtensions: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: Additional file extensions to include beyond defaults (e.g., ['.vue', '.svelte', '.astro']). Extensions should include the dot prefix or will be automatically added",
                                    default: []
                                },
                                ignorePatterns: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: Additional ignore patterns to exclude specific files/directories beyond defaults. Only include this parameter if the user explicitly requests custom ignore patterns (e.g., ['static/**', '*.tmp', 'private/**'])",
                                    default: []
                                }
                            },
                            required: ["path"]
                        }
                    },
                    {
                        name: "search_code",
                        description: search_description,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to search in.`
                                },
                                query: {
                                    type: "string",
                                    description: "Natural language query to search for in the codebase"
                                },
                                limit: {
                                    type: "number",
                                    description: "Maximum number of results to return",
                                    default: 10,
                                    maximum: 50
                                },
                                extensionFilter: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: List of file extensions to filter results. (e.g., ['.ts','.py']).",
                                    default: []
                                }
                            },
                            required: ["path", "query"]
                        }
                    },
                    {
                        name: "clear_index",
                        description: `Clear the search index. IMPORTANT: You MUST provide an absolute path.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to clear.`
                                }
                            },
                            required: ["path"]
                        }
                    },
                    {
                        name: "get_indexing_status",
                        description: `Get the current indexing status of a codebase. Shows progress percentage for actively indexing codebases and completion status for indexed codebases.`,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to check status for.`
                                }
                            },
                            required: ["path"]
                        }
                    },
                    {
                        name: "list_indexed_repos",
                        description: list_indexed_repos_description,
                        inputSchema: {
                            type: "object",
                            properties: {}
                        }
                    },
                    {
                        name: "search_repo",
                        description: search_repo_description,
                        inputSchema: {
                            type: "object",
                            properties: {
                                repo: {
                                    type: "string",
                                    description: `Repo identity string as reported by list_indexed_repos (e.g. "github.com/org/repo"), or any git remote URL for that repo (https:// or git@ form). No local checkout is required.`
                                },
                                query: {
                                    type: "string",
                                    description: "Natural language query to search for in the repo"
                                },
                                limit: {
                                    type: "number",
                                    description: "Maximum number of results to return",
                                    default: 10,
                                    maximum: 50
                                },
                                extensionFilter: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: List of file extensions to filter results. (e.g., ['.ts','.py']).",
                                    default: []
                                }
                            },
                            required: ["repo", "query"]
                        }
                    },
                    {
                        name: "search_org",
                        description: search_org_description,
                        inputSchema: {
                            type: "object",
                            properties: {
                                query: {
                                    type: "string",
                                    description: "Natural language query to search for across every indexed repo"
                                },
                                limit: {
                                    type: "number",
                                    description: "Maximum number of results to return",
                                    default: 10,
                                    maximum: 50
                                }
                            },
                            required: ["query"]
                        }
                    },
            ];

            return {
                tools: isHttp ? allTools.filter((tool) => !localOnlyToolNames.has(tool.name)) : allTools
            };
        });

        // Handle tool execution
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            if (isHttp && localOnlyToolNames.has(name)) {
                throw new Error(`Tool '${name}' operates on a local filesystem path and is not available over the http transport.`);
            }

            switch (name) {
                case "index_codebase":
                    return await this.toolHandlers.handleIndexCodebase(args);
                case "search_code":
                    return await this.toolHandlers.handleSearchCode(args);
                case "clear_index":
                    return await this.toolHandlers.handleClearIndex(args);
                case "get_indexing_status":
                    return await this.toolHandlers.handleGetIndexingStatus(args);
                case "list_indexed_repos":
                    return await this.toolHandlers.handleListIndexedRepos(args);
                case "search_repo":
                    return await this.toolHandlers.handleSearchRepo(args);
                case "search_org":
                    return await this.toolHandlers.handleSearchOrg(args);

                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        });
    }

    async start() {
        console.log('[SYNC-DEBUG] MCP server start() method called');
        console.log('Starting Context MCP server...');

        // One-shot startup healing for legacy 0/0+completed snapshot entries
        // left over from pre-fix MCP versions. Runs before the transport accepts
        // requests so clients never observe the poisoning state. See Issue #295.
        await this.toolHandlers.validateLegacyZeroEntries();

        if (this.config.transport === 'http') {
            await this.startHttpTransport();
        } else {
            const transport = new StdioServerTransport();
            console.log('[SYNC-DEBUG] StdioServerTransport created, attempting server connection...');

            await this.server.connect(transport);
            console.log("MCP server started and listening on stdio.");
            console.log('[SYNC-DEBUG] Server connection established successfully');
        }

        // Start background sync after server is connected. Note: in http mode
        // this still syncs codebases from THIS process's local filesystem —
        // there is no shared filesystem across replicas, so background sync
        // (and index_codebase) is only meaningful for codebases actually
        // checked out where this server process runs.
        console.log('[SYNC-DEBUG] Initializing background sync...');
        this.syncManager.startBackgroundSync();
        console.log('[SYNC-DEBUG] MCP server initialization complete');
    }

    /**
     * Serves MCP over Streamable HTTP in stateless mode: every request gets
     * its own Server + Transport pair (registered against the same shared
     * this.toolHandlers/Context), so any request can be handled by any
     * process/replica with no session affinity or in-memory session store
     * required — this is what makes it safe to run behind a plain load
     * balancer with multiple replicas.
     */
    private async startHttpTransport(): Promise<void> {
        const { httpPort, httpPath, httpAuthToken } = this.config;

        if (!httpAuthToken) {
            console.error(
                `[HTTP] ⚠️  MCP_HTTP_AUTH_TOKEN is not set. This server will accept requests from ` +
                `ANY client that can reach port ${httpPort} with no authentication, using this ` +
                `server's Milvus and embedding-provider credentials. Set MCP_HTTP_AUTH_TOKEN before ` +
                `exposing this beyond localhost.`
            );
        }

        const httpServer = http.createServer((req, res) => {
            void this.handleHttpRequest(req, res, httpPath, httpAuthToken);
        });

        await new Promise<void>((resolve, reject) => {
            httpServer.once('error', reject);
            httpServer.listen(httpPort, () => {
                console.log(`[HTTP] MCP server listening on port ${httpPort}, path ${httpPath}`);
                resolve();
            });
        });
    }

    private async handleHttpRequest(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        httpPath: string,
        httpAuthToken: string | undefined
    ): Promise<void> {
        const url = req.url?.split('?')[0];

        if (req.method === 'GET' && url === '/healthz') {
            res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
            return;
        }

        if (url !== httpPath) {
            res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Not found' }));
            return;
        }

        if (httpAuthToken) {
            const authHeader = req.headers['authorization'];
            if (authHeader !== `Bearer ${httpAuthToken}`) {
                res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' }));
                return;
            }
        }

        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        const contentLength = Number(req.headers['content-length']);
        if (Number.isFinite(contentLength) && contentLength > MAX_HTTP_BODY_BYTES) {
            res.writeHead(413, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Payload too large' }));
            req.destroy();
            return;
        }

        let rawBody: string;
        try {
            rawBody = await new Promise<string>((resolve, reject) => {
                const chunks: Buffer[] = [];
                let totalBytes = 0;
                req.on('data', (chunk: Buffer) => {
                    totalBytes += chunk.length;
                    if (totalBytes > MAX_HTTP_BODY_BYTES) {
                        req.destroy();
                        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
                        return;
                    }
                    chunks.push(chunk);
                });
                req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
                req.on('error', reject);
            });
        } catch (error: any) {
            console.error('[HTTP] Failed to read request body:', error);
            const statusCode = error?.statusCode === 413 ? 413 : 400;
            const message = statusCode === 413 ? 'Payload too large' : 'Failed to read request body';
            res.writeHead(statusCode, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: message }));
            return;
        }

        let parsedBody: unknown;
        try {
            parsedBody = rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
        } catch (error) {
            res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Invalid JSON body' }));
            return;
        }

        const requestServer = new Server(
            { name: this.config.name, version: this.config.version },
            { capabilities: { tools: {} } }
        );
        this.setupTools(requestServer);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

        res.on('close', () => {
            transport.close();
            requestServer.close();
        });

        try {
            await requestServer.connect(transport);
            await transport.handleRequest(req, res, parsedBody);
        } catch (error) {
            console.error('[HTTP] Error handling MCP request:', error);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Internal server error' }));
            }
        }
    }
}

// Main execution
async function main() {
    // Parse command line arguments
    const args = process.argv.slice(2);

    // Show help if requested
    if (args.includes('--help') || args.includes('-h')) {
        showHelpMessage();
        process.exit(0);
    }

    // Create configuration
    const config = createMcpConfig();
    logConfigurationSummary(config);

    const server = new ContextMcpServer(config);
    await server.start();
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.error("Received SIGINT, shutting down gracefully...");
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.error("Received SIGTERM, shutting down gracefully...");
    process.exit(0);
});

// Always start the server - this is designed to be the main entry point
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
