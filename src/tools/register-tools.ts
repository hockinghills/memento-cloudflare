import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Props, ExtendedEnv } from "../types";
import { registerMementoTools } from "./memento-tools";

/**
 * Register all MCP tools
 */
export function registerAllTools(server: McpServer, env: ExtendedEnv, props: Props) {
  // Register Memento knowledge graph tools
  registerMementoTools(server, env, props);
}
