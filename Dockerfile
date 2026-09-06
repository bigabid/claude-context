# syntax=docker/dockerfile:1

# Builds @bigabid/claude-context-mcp as a standalone image for hosting behind
# the Streamable HTTP transport (MCP_TRANSPORT=http). See packages/mcp/README.md
# for the stdio (default) usage this image does NOT cover.
#
# Multi-arch build (linux/amd64 + linux/arm64): the TypeScript compile is
# arch-independent output, so it's pinned to $BUILDPLATFORM and runs natively
# exactly once regardless of how many --platform targets are requested. Only
# the "deps" stage (which resolves tree-sitter's native bindings) actually
# runs per TARGETPLATFORM, since those bindings are architecture-specific.

FROM --platform=$BUILDPLATFORM node:22-slim AS ts-builder

RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /repo
COPY . .

RUN pnpm install --frozen-lockfile

RUN pnpm --filter @bigabid/claude-context-core build \
    && pnpm --filter @bigabid/claude-context-mcp build

FROM node:22-slim AS deps

# tree-sitter grammars ship prebuilt binaries for common platforms; these
# build tools are a fallback in case no prebuild matches this stage's arch.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /repo
COPY . .

# Resolves node_modules (including tree-sitter's native bindings) for THIS
# stage's actual platform - unlike ts-builder, this stage is not pinned to
# BUILDPLATFORM, so under `docker buildx build --platform=...` it runs once
# per target arch and each gets the right prebuilt binaries.
RUN pnpm install --frozen-lockfile

# dist/ is arch-independent JS - copy it in from the natively-built stage
# instead of recompiling under (possibly emulated) TARGETPLATFORM.
COPY --from=ts-builder /repo/packages/core/dist packages/core/dist
COPY --from=ts-builder /repo/packages/mcp/dist packages/mcp/dist

# Materializes a self-contained deploy of the mcp package (real files, not
# workspace symlinks) at /out/mcp, including its @bigabid/claude-context-core
# dependency, so the runtime stage doesn't need pnpm or the rest of the repo.
RUN pnpm --filter @bigabid/claude-context-mcp deploy --prod --legacy /out/mcp

FROM node:22-slim AS runtime

RUN useradd --uid 10001 --user-group --create-home --shell /usr/sbin/nologin appuser

WORKDIR /app
COPY --from=deps /out/mcp .

ENV MCP_TRANSPORT=http \
    MCP_HTTP_PORT=3000 \
    MCP_HTTP_PATH=/mcp \
    CLAUDE_CONTEXT_BACKGROUND_SYNC=false \
    NODE_ENV=production

EXPOSE 3000
USER appuser

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.MCP_HTTP_PORT||3000,path:'/healthz'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["node", "dist/index.js"]
