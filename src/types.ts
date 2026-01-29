import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
// Note: Env base type comes from @cloudflare/workers-types ambient declarations

/**
 * User props from GitHub OAuth
 */
export type Props = {
  login: string; // GitHub username
  name: string; // Display name
  email: string; // Email address
  accessToken: string; // GitHub access token
};

/**
 * Environment bindings
 */
export interface ExtendedEnv extends Env {
  // OAuth Provider binding
  OAUTH_PROVIDER: OAuthHelpers;

  // KV namespace for OAuth state
  OAUTH_KV: KVNamespace;

  // Neo4j connection
  NEO4J_URI: string;
  NEO4J_USER: string;
  NEO4J_PASSWORD: string;

  // VoyageAI for embeddings
  VOYAGE_API_KEY: string;

  // OAuth credentials
  OAUTH_CLIENT_ID: string;
  OAUTH_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;

  // Durable Object binding
  MCP_OBJECT: DurableObjectNamespace;
}
