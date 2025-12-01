/**
 * Memento MCP Worker
 *
 * Cloudflare Worker that exposes Memento's knowledge graph via MCP protocol
 * Preserves Gannon's hybrid search kung fu using HTTP Query API
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { Neo4jHttpClient } from './neo4j-client.js';
import { VoyageEmbeddingService } from './embedding-service.js';
import { hybridSearchWithRRF, vectorSearch, SearchResult } from './semantic-search.js';

interface Env {
  NEO4J_URI: string;
  NEO4J_USER: string;
  NEO4J_PASSWORD: string;
  VOYAGE_API_KEY: string;
  OAUTH_KV: KVNamespace;
}

/**
 * Create MCP server instance
 */
function createServer(neo4j: Neo4jHttpClient, embeddings: VoyageEmbeddingService) {
  const server = new Server(
    {
      name: 'memento-cloudflare',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'semantic_search',
          description:
            'Search the knowledge graph semantically using hybrid RRF (vector + keyword fusion). ' +
            'This is the powerful context-aware search that combines semantic understanding with exact matching.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query text',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results (default: 10)',
              },
              minSimilarity: {
                type: 'number',
                description: 'Minimum similarity threshold 0-1 (default: 0.6)',
              },
              hybridSearch: {
                type: 'boolean',
                description: 'Enable hybrid RRF search combining vector and keyword (default: true)',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'open_nodes',
          description: 'Retrieve specific entities by their exact names, including their relations',
          inputSchema: {
            type: 'object',
            properties: {
              names: {
                type: 'array',
                items: { type: 'string' },
                description: 'Array of entity names to retrieve',
              },
            },
            required: ['names'],
          },
        },
        {
          name: 'search_nodes',
          description: 'Text-based search for entities by name or observation content',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query text',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results (default: 10)',
              },
            },
            required: ['query'],
          },
        },
      ],
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'semantic_search': {
          const query = args.query as string;
          const limit = (args.limit as number) || 10;
          const minSimilarity = (args.minSimilarity as number) || 0.6;
          const useHybrid = args.hybridSearch !== false; // Default true

          // Generate query embedding
          const queryVector = await embeddings.generateEmbedding(query);

          let result: SearchResult;
          if (useHybrid) {
            // Use hybrid RRF search (the kung fu)
            result = await hybridSearchWithRRF(neo4j, queryVector, query, {
              limit,
              minSimilarity,
            });
          } else {
            // Pure vector search
            result = await vectorSearch(neo4j, queryVector, {
              limit,
              minSimilarity,
            });
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'open_nodes': {
          const names = args.names as string[];

          if (!names || names.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ entities: [], relations: [] }, null, 2),
                },
              ],
            };
          }

          // Get entities
          const entities = await neo4j.query(
            `
            MATCH (e:Entity)
            WHERE e.name IN $names
            AND e.validTo IS NULL
            RETURN e.name AS name, e.entityType AS entityType,
                   e.observations AS observations, e.id AS id,
                   e.version AS version, e.createdAt AS createdAt,
                   e.updatedAt AS updatedAt
          `,
            { names }
          );

          // Get relations
          const relations = await neo4j.query(
            `
            MATCH (from:Entity)-[r:RELATES_TO]->(to:Entity)
            WHERE from.name IN $names
            AND to.name IN $names
            AND r.validTo IS NULL
            RETURN from.name AS fromName, to.name AS toName, r.relationType AS relationType
          `,
            { names }
          );

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    entities: entities.map((e: any) => ({
                      ...e,
                      observations: JSON.parse(e.observations),
                    })),
                    relations,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'search_nodes': {
          const query = args.query as string;
          const limit = (args.limit as number) || 10;

          const entities = await neo4j.query(
            `
            MATCH (e:Entity)
            WHERE e.name CONTAINS $query
              OR ANY(obs IN e.observations WHERE obs CONTAINS $query)
            AND e.validTo IS NULL
            RETURN e.name AS name, e.entityType AS entityType,
                   e.observations AS observations
            LIMIT $limit
          `,
            { query, limit }
          );

          // Get relations between found entities
          const entityNames = entities.map((e: any) => e.name);
          const relations =
            entityNames.length > 0
              ? await neo4j.query(
                  `
              MATCH (from:Entity)-[r:RELATES_TO]->(to:Entity)
              WHERE from.name IN $names
              AND to.name IN $names
              AND r.validTo IS NULL
              RETURN from.name AS fromName, to.name AS toName, r.relationType AS relationType
            `,
                  { names: entityNames }
                )
              : [];

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    entities: entities.map((e: any) => ({
                      ...e,
                      observations: JSON.parse(e.observations),
                    })),
                    relations,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Worker entry point for local testing
 * For production, this will be wrapped with OAuth
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // For now, return basic info
    // We'll add SSE transport and OAuth next
    return new Response(
      JSON.stringify({
        name: 'memento-mcp-worker',
        status: 'ready',
        capabilities: ['semantic_search', 'open_nodes', 'search_nodes'],
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  },
};

// For local development/testing via stdio
if (import.meta.url === `file://${process.argv[1]}`) {
  const neo4j = new Neo4jHttpClient({
    uri: process.env.NEO4J_URI!,
    user: process.env.NEO4J_USER!,
    password: process.env.NEO4J_PASSWORD!,
  });

  const embeddings = new VoyageEmbeddingService({
    apiKey: process.env.VOYAGE_API_KEY!,
    model: 'voyage-3-large',
    dimensions: 2048,
  });

  const server = createServer(neo4j, embeddings);
  const transport = new StdioServerTransport();

  server.connect(transport).catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
  });
}
