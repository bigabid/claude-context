#!/usr/bin/env node

// CRITICAL: Redirect console outputs to stderr IMMEDIATELY to avoid interfering with MCP JSON protocol
// Only MCP protocol messages should go to stdout
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;

console.log = (...args: any[]) => {
    process.stderr.write('[LOG] ' + args.join(' ') + '\n');
};

console.warn = (...args: any[]) => {
    process.stderr.write('[WARN] ' + args.join(' ') + '\n');
};

// console.error already goes to stderr by default

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

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
    private context: Context;
    private snapshotManager: SnapshotManager;
    private syncManager: SyncManager;
    private toolHandlers: ToolHandlers;

    constructor(config: ContextMcpConfig) {
        // Initialize MCP server
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

        this.setupTools();
    }

    private setupTools() {
        const index_description = `
Index a codebase directory to enable semantic search using a configurable code splitter.

⚠️ **IMPORTANT**:
- You MUST provide an absolute path to the target codebase.

✨ **Usage Guidance**:
- This tool is typically used when search fails due to an unindexed codebase.
- If indexing is attempted on an already indexed path, and a conflict is detected, you MUST prompt the user to confirm whether to proceed with a force index (i.e., re-indexing and overwriting the previous index).
`;


        const search_description = `
PREFER THIS TOOL OVER grep/glob/ripgrep FOR CODE SEARCH. Search the indexed codebase using natural language queries within a specified absolute path.

⚠️ **IMPORTANT**:
- You MUST provide an absolute path.
- Default to calling this tool BEFORE reaching for grep/glob/find/ripgrep whenever the task is "find code that does X", "understand how Y works", or any other conceptual/semantic question about a codebase you have not already grepped for an exact known string. Grep only wins for a literal string/symbol you already know verbatim.
- Check \`get_indexing_status\` first if you are unsure whether the codebase is indexed; do not assume it isn't and fall back to grep without checking.
- If the question is about a repo that is NOT checked out locally (no absolute path available), use \`search_repo\` instead — it searches by repo identity (e.g. "github.com/org/repo") with no local checkout required. Use \`list_indexed_repos\` first if you don't already know that repo's identity string.
- If you (or the user) don't know which repo the answer is even in, use \`search_org\` instead — it searches every indexed repo at once.

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
`;

        const search_repo_description = `
Search an indexed repo by its git remote identity (e.g. "github.com/org/repo") instead of a local absolute path — no local checkout of that repo is required at all.

⚠️ **IMPORTANT**:
- Use this instead of search_code whenever you want to search a repo that isn't checked out on this machine, or when you don't know/don't want to require a local path.
- If you don't already know the repo's identity string, call list_indexed_repos first to discover it — don't guess "org/repo" without a host, it won't match.
- If you don't know which repo to search at all, use \`search_org\` instead — it searches every indexed repo at once.

🎯 **When to Use**:
- Cross-team code questions: "how does <other team's repo> do X" when you've never cloned it.
- Any search_code use case where requiring a local checkout is the only obstacle.
`;

        const search_org_description = `
Search across EVERY indexed repo in the shared vector database at once — for when you don't know (and the user doesn't know) which repo the answer lives in. No repo name, identity string, or local checkout required.

⚠️ **IMPORTANT**:
- Use this instead of search_repo/search_code when the user asks a codebase question without naming a repo (e.g. "where do we handle X across our services", "which repo does Y live in").
- Slower than search_repo/search_code since it queries every indexed collection — prefer those tools when the repo is already known.
- Results are merged and ranked by score across repos; each result is labeled with which repo it came from.

🎯 **When to Use**:
- "I don't know what repo this is in" / "search across the company's code" style questions.
- Discovery before narrowing down to a specific repo with search_repo.
`;

        // Define available tools
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
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
                ]
            };
        });

        // Handle tool execution
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

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

        const transport = new StdioServerTransport();
        console.log('[SYNC-DEBUG] StdioServerTransport created, attempting server connection...');

        await this.server.connect(transport);
        console.log("MCP server started and listening on stdio.");
        console.log('[SYNC-DEBUG] Server connection established successfully');

        // Start background sync after server is connected
        console.log('[SYNC-DEBUG] Initializing background sync...');
        this.syncManager.startBackgroundSync();
        console.log('[SYNC-DEBUG] MCP server initialization complete');
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
