/**
 * Memento MCP Worker with GitHub OAuth
 *
 * Knowledge graph memory system with semantic search
 * Preserves Gannon's hybrid RRF search kung fu using Neo4j + VoyageAI
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Props, ExtendedEnv } from "./types";
import { GitHubHandler } from "./auth/github-handler";
import { registerAllTools } from "./tools/register-tools";

/**
 * Memento MCP Agent
 * Stateful Durable Object for maintaining MCP sessions
 */
export class MementoMCP extends McpAgent<ExtendedEnv, Record<string, never>, Props> {
  server = new McpServer({
    name: "Memento Knowledge Graph MCP Server",
    version: "1.0.0",
  });

  /**
   * Initialize MCP tools
   */
  async init() {
    try {
      registerAllTools(this.server, this.env, this.props);
    } catch (error) {
      console.error("Failed to register MCP tools:", error);
      throw error; // Re-throw to prevent silently broken DO
    }
  }
}

/**
 * OAuth Provider wrapping Memento MCP
 * Dual transport: /mcp (Streamable HTTP) and /sse (legacy)
 */

// Handler type for OAuthProvider - uses ExtendedEnv for type safety
interface TypedHandler {
  fetch(request: Request, env: ExtendedEnv, ctx: ExecutionContext): Promise<Response>;
}

const sseHandler: TypedHandler = {
  fetch(request: Request, env: ExtendedEnv, ctx: ExecutionContext): Promise<Response> {
    return MementoMCP.serveSSE('/sse').fetch(request, env, ctx);
  }
};

const mcpHandler: TypedHandler = {
  fetch(request: Request, env: ExtendedEnv, ctx: ExecutionContext): Promise<Response> {
    return MementoMCP.serve('/mcp').fetch(request, env, ctx);
  }
};

const defaultHandler: TypedHandler = {
  fetch(request: Request, env: ExtendedEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Handle OAuth Protected Resource Metadata (RFC 8707)
    // Must be public (no auth) for Claude Code token refresh
    if (url.pathname === '/.well-known/oauth-protected-resource') {
      const metadata = {
        resource: `${url.origin}/mcp`,
        authorization_servers: [url.origin],
        scopes_supported: ["offline_access"],
        bearer_methods_supported: ["header"],
      };
      return Promise.resolve(new Response(JSON.stringify(metadata), {
        headers: { "Content-Type": "application/json" },
      }));
    }

    return GitHubHandler.fetch(request, env, ctx);
  }
};

export default new OAuthProvider({
  apiHandlers: {
    '/sse': sseHandler,
    '/mcp': mcpHandler,
  },
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: defaultHandler,
  tokenEndpoint: "/token",
});
