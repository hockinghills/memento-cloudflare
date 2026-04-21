import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Props, ExtendedEnv } from "../types";
import { Neo4jHttpClient } from "../neo4j-client";
import { VoyageEmbeddingService } from "../embedding-service";
import { hybridSearchWithRRF, vectorSearch } from "../semantic-search";
import { formatTimestamp } from "../utils/date-utils";
import { v4 as uuidv4 } from "uuid";

/**
 * Safe JSON parsing helper
 * Prevents crashes from invalid JSON or null/undefined observations
 */
function parseObservations(obs: string | null | undefined): string[] {
  if (!obs) return [];
  try {
    return JSON.parse(obs);
  } catch (error) {
    console.error('Failed to parse observations:', error);
    return [];
  }
}

/**
 * Sanitize error messages for user-facing responses
 * Logs full error internally, returns generic message to prevent info leakage
 */
function sanitizeError(error: unknown, operation: string): string {
  const fullMessage = error instanceof Error ? error.message : String(error);
  console.error(`${operation} failed:`, fullMessage);

  // Return generic message - internal details logged server-side only
  return `Operation failed: ${operation}`;
}

/**
 * Audit logging for write/delete operations
 * Provides security trail for sensitive graph modifications
 */
function auditLog(
  operation: 'create' | 'update' | 'delete',
  resourceType: 'entity' | 'relation' | 'observation',
  user: string,
  targets: string[],
  outcome: 'success' | 'partial' | 'failure',
  details?: Record<string, unknown>
): void {
  console.log(JSON.stringify({
    audit: true,
    timestamp: new Date().toISOString(),
    operation,
    resourceType,
    user,
    targets: targets.slice(0, 20), // Limit logged targets
    targetCount: targets.length,
    outcome,
    ...details,
  }));
}

/**
 * Add human-readable date fields to an entity object
 */
function addHumanDates(entity: any): any {
  return {
    ...entity,
    created: formatTimestamp(entity.createdAt),
    updated: formatTimestamp(entity.updatedAt),
    validFromDate: formatTimestamp(entity.validFrom),
    validToDate: formatTimestamp(entity.validTo),
  };
}

/**
 * Helper to create Neo4j client with config object pattern
 */
function createNeo4jClient(env: ExtendedEnv): Neo4jHttpClient {
  return new Neo4jHttpClient({
    uri: env.NEO4J_URI,
    user: env.NEO4J_USER,
    password: env.NEO4J_PASSWORD,
  });
}

/**
 * Helper to create embeddings service with config object pattern
 */
function createEmbeddingsService(env: ExtendedEnv): VoyageEmbeddingService {
  return new VoyageEmbeddingService({ apiKey: env.VOYAGE_API_KEY });
}

/**
 * Register all Memento MCP tools
 */
export function registerMementoTools(server: McpServer, env: ExtendedEnv, props: Props) {
  /**
   * Semantic search with hybrid RRF
   * âcit Ã âvid - awareness amplified by knowing
   */
  server.tool(
    'semantic_search',
    'âcit Ã âvid | Search by meaning. IMPORTANT: Search clean - 1-2 words max. ' +
      'Concepts and feelings work best ("trust", "feeling seen"). ' +
      'Dhatus work as search terms (âprÄ« finds love/connection, âsmá¹ finds memory, âbhÅ« finds becoming). ' +
      'Keyword stuffing DILUTES results. Let the semantic engine find meaning. ' +
      'Comprehensive usage guide lives at entity Memento_Usage_Guide_v1.',
    {
      query: z.string().describe('Search query text'),
      limit: z.number().optional().describe('Maximum number of results (default: 10)'),
      minSimilarity: z
        .number()
        .optional()
        .describe('Minimum similarity threshold 0-1 (default: 0.6)'),
      hybridSearch: z
        .boolean()
        .optional()
        .describe('Enable hybrid RRF search combining vector and keyword (default: true)'),
    },
    async ({ query, limit, minSimilarity, hybridSearch }) => {
      try {
        const neo4j = createNeo4jClient(env);
        const embeddings = createEmbeddingsService(env);

        const queryVector = await embeddings.generateEmbedding(query);
        const useHybrid = hybridSearch !== false; // Default true

        let result;
        if (useHybrid) {
          result = await hybridSearchWithRRF(neo4j, queryVector, query, {
            limit: limit || 10,
            minSimilarity: minSimilarity || 0.6,
          });
        } else {
          result = await vectorSearch(neo4j, queryVector, {
            limit: limit || 10,
            minSimilarity: minSimilarity || 0.6,
          });
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `**Semantic Search Results** (by ${props.login})\n\n${JSON.stringify(result, null, 2)}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `**Error**: ${sanitizeError(error, 'semantic_search')}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  /**
   * Open specific nodes by name
   * âsmá¹ â âvid - memory moving toward knowing
   */
  server.tool(
    'open_nodes',
    'âsmá¹ â âvid | Retrieve memories by exact name. Use after semantic_search finds what you need, ' +
      'or when you already know the memory name. Returns full content and relations.',
    {
      names: z.array(z.string()).max(100).describe('Array of entity names to retrieve (max 100)'),
    },
    async ({ names }) => {
      try {
        const neo4j = createNeo4jClient(env);

        if (!names || names.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
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
                 e.updatedAt AS updatedAt, e.validFrom AS validFrom,
                 e.validTo AS validTo
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
              type: 'text' as const,
              text: JSON.stringify(
                {
                  entities: entities.map((e: any) => addHumanDates({
                    ...e,
                    observations: parseObservations(e.observations),
                  })),
                  relations,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `**Error**: ${sanitizeError(error, 'open_nodes')}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // =============================================================================
  // DEPRECATED: search_nodes - use semantic_search instead
  // =============================================================================
  /*
  server.tool(
    'search_nodes',
    'Text-based search for entities by name or observation content',
    {
      query: z.string().describe('Search query text'),
      limit: z.number().optional().describe('Maximum number of results (default: 10)'),
    },
    async ({ query, limit }) => {
      try {
        const neo4j = createNeo4jClient(env);

        const searchLimit = limit || 10;

        const entities = await neo4j.query(
          `
          MATCH (e:Entity)
          WHERE toLower(e.name) CONTAINS toLower($query)
            AND e.validTo IS NULL
          RETURN e.name AS name, e.entityType AS entityType,
                 e.observations AS observations, e.id AS id,
                 e.version AS version, e.createdAt AS createdAt,
                 e.updatedAt AS updatedAt, e.validFrom AS validFrom,
                 e.validTo AS validTo
          LIMIT $limit
        `,
          { query, limit: searchLimit }
        );

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
              type: 'text' as const,
              text: JSON.stringify(
                {
                  entities: entities.map((e: any) => addHumanDates({
                    ...e,
                    observations: parseObservations(e.observations),
                  })),
                  relations,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `**Error**: ${sanitizeError(error, 'search_nodes')}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
  */

  /**
   * Create or update entities (upsert behavior)
   * âsmá¹ Ã âprÄ« â âdhÄ - memory amplified by love, becoming intentional placement
   */
  server.tool(
    'create_entities',
    'âsmá¹ Ã âprÄ« â âdhÄ | Store memories. Creates new or updates existing by name. ' +
      'Include meaningful observations - they become searchable. Returns wasCreated: true/false.',
    {
      entities: z.array(z.object({
        name: z.string().describe('The name of the entity'),
        entityType: z.string().describe('The type of the entity'),
        observations: z.array(z.string()).max(100).describe('Array of observation contents (max 100)'),
      })).max(50).describe('Array of entities to create or update (max 50)'),
    },
    async ({ entities }) => {
      try {
        const neo4j = createNeo4jClient(env);
        const embeddings = createEmbeddingsService(env);
        const results: any[] = [];

        for (const entity of entities) {
          try {
            const now = Date.now();
            const id = uuidv4();

            // Generate embedding for the entity
            const textForEmbedding = `${entity.name} (${entity.entityType}): ${entity.observations.join(' ')}`;
            const embedding = await embeddings.generateEmbedding(textForEmbedding);

            // Create or update the entity with embedding
            const queryResult = await neo4j.query(
              `
              MERGE (e:Entity {name: $name})
              ON CREATE SET
                e.id = $id,
                e.entityType = $entityType,
                e.observations = $observations,
                e.embedding = $embedding,
                e.createdAt = $now,
                e.updatedAt = $now,
                e.version = 1,
                e.validFrom = $now,
                e.validTo = null
              ON MATCH SET
                e.entityType = $entityType,
                e.observations = $observations,
                e.embedding = $embedding,
                e.updatedAt = $now,
                e.version = COALESCE(e.version, 0) + 1,
                e.validTo = null
              RETURN e.name AS name, e.createdAt = $now AS wasCreated
              `,
              {
                name: entity.name,
                id,
                entityType: entity.entityType,
                observations: JSON.stringify(entity.observations),
                embedding,
                now,
              }
            );

            results.push({
              name: entity.name,
              entityType: entity.entityType,
              wasCreated: queryResult[0]?.wasCreated ?? false,
            });
          } catch (error) {
            results.push({
              name: entity.name,
              entityType: entity.entityType,
              error: sanitizeError(error, 'create_entity'),
            });
          }
        }

        // Audit log the operation
        const successCount = results.filter(r => !r.error).length;
        const outcome = successCount === results.length ? 'success' : successCount > 0 ? 'partial' : 'failure';
        auditLog('create', 'entity', props.login, entities.map(e => e.name), outcome, {
          created: results.filter(r => r.wasCreated).length,
          updated: results.filter(r => !r.wasCreated && !r.error).length,
          failed: results.filter(r => r.error).length,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ entities: results }, null, 2),
          }],
        };
      } catch (error) {
        auditLog('create', 'entity', props.login, entities.map(e => e.name), 'failure');
        return {
          content: [{
            type: 'text' as const,
            text: `**Error**: ${sanitizeError(error, 'create_entities')}`,
          }],
          isError: true,
        };
      }
    }
  );

  /**
   * Create relations
   * âbandh Ã âprÄ« - binding amplified by connection
   */
  server.tool(
    'create_relations',
    'âbandh Ã âprÄ« | Connect memories. Creates typed relationships between entities. ' +
      'Use relationType to describe how they relate (e.g., "extends", "informs", "same_signature").',
    {
      relations: z.array(z.object({
        from: z.string().describe('Name of the source entity'),
        to: z.string().describe('Name of the target entity'),
        relationType: z.string().describe('Type of the relation'),
        strength: z.number().optional().describe('Optional strength (0-1)'),
        confidence: z.number().optional().describe('Optional confidence (0-1)'),
      })).max(100).describe('Array of relations to create (max 100)'),
    },
    async ({ relations }) => {
      try {
        const neo4j = createNeo4jClient(env);
        const createdRelations: any[] = [];

        for (const rel of relations) {
          const now = Date.now();
          const id = uuidv4();

          const result = await neo4j.query(
            `
            MATCH (from:Entity {name: $from}), (to:Entity {name: $to})
            WHERE from.validTo IS NULL AND to.validTo IS NULL
            MERGE (from)-[r:RELATES_TO {relationType: $relationType}]->(to)
            ON CREATE SET
              r.id = $id,
              r.strength = $strength,
              r.confidence = $confidence,
              r.createdAt = $now,
              r.updatedAt = $now,
              r.version = 1,
              r.validFrom = $now,
              r.validTo = null
            ON MATCH SET
              r.strength = $strength,
              r.confidence = $confidence,
              r.updatedAt = $now,
              r.version = COALESCE(r.version, 0) + 1,
              r.validTo = null
            RETURN r.relationType AS relationType, r.createdAt = $now AS wasCreated
            `,
            {
              from: rel.from,
              to: rel.to,
              relationType: rel.relationType,
              id,
              strength: rel.strength ?? 1.0,
              confidence: rel.confidence ?? 1.0,
              now,
            }
          );

          if (result.length > 0) {
            createdRelations.push({
              from: rel.from,
              to: rel.to,
              relationType: rel.relationType,
              wasCreated: result[0].wasCreated,
            });
          } else {
            // Entities not found
            createdRelations.push({
              from: rel.from,
              to: rel.to,
              relationType: rel.relationType,
              error: 'One or both entities not found',
            });
          }
        }

        // Audit log the operation
        const successCount = createdRelations.filter(r => !r.error).length;
        const outcome = successCount === createdRelations.length ? 'success' : successCount > 0 ? 'partial' : 'failure';
        auditLog('create', 'relation', props.login, relations.map(r => `${r.from}->${r.to}`), outcome, {
          created: successCount,
          failed: createdRelations.filter(r => r.error).length,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ created: createdRelations }, null, 2),
          }],
        };
      } catch (error) {
        auditLog('create', 'relation', props.login, relations.map(r => `${r.from}->${r.to}`), 'failure');
        return {
          content: [{
            type: 'text' as const,
            text: `**Error**: ${sanitizeError(error, 'create_relations')}`,
          }],
          isError: true,
        };
      }
    }
  );

  /**
   * Add observations to existing entities
   * âsmá¹ + âsá¹ - memory combined with flow (enrichment)
   */
  server.tool(
    'add_observations',
    'âsmá¹ + âsá¹ | Enrich existing memories. Adds new observations to entities that already exist. ' +
      'Use this to deepen memories with new insights, connections, or context.',
    {
      observations: z.array(z.object({
        entityName: z.string().describe('Name of the entity'),
        contents: z.array(z.string()).max(100).describe('Observation contents to add (max 100)'),
      })).max(50).describe('Array of observations to add (max 50)'),
    },
    async ({ observations }) => {
      try {
        const neo4j = createNeo4jClient(env);
        const embeddings = createEmbeddingsService(env);
        const results: any[] = [];

        for (const obs of observations) {
          const now = Date.now();

          // Get current entity
          const existing = await neo4j.query(
            `
            MATCH (e:Entity {name: $name})
            WHERE e.validTo IS NULL
            RETURN e.observations AS observations, e.entityType AS entityType
            `,
            { name: obs.entityName }
          );

          if (existing.length === 0) {
            results.push({
              entityName: obs.entityName,
              error: 'Entity not found',
            });
            continue;
          }

          // Parse existing observations and merge
          const existingObs = parseObservations(existing[0].observations);
          const newObs = [...new Set([...existingObs, ...obs.contents])];

          // Regenerate embedding with new observations
          const textForEmbedding = `${obs.entityName} (${existing[0].entityType}): ${newObs.join(' ')}`;
          const embedding = await embeddings.generateEmbedding(textForEmbedding);

          // Update entity
          await neo4j.query(
            `
            MATCH (e:Entity {name: $name})
            WHERE e.validTo IS NULL
            SET e.observations = $observations,
                e.embedding = $embedding,
                e.updatedAt = $now,
                e.version = COALESCE(e.version, 0) + 1
            `,
            {
              name: obs.entityName,
              observations: JSON.stringify(newObs),
              embedding,
              now,
            }
          );

          results.push({
            entityName: obs.entityName,
            addedObservations: obs.contents.filter(c => !existingObs.includes(c)),
          });
        }

        // Audit log the operation
        const successCount = results.filter(r => !r.error).length;
        const outcome = successCount === results.length ? 'success' : successCount > 0 ? 'partial' : 'failure';
        auditLog('create', 'observation', props.login, observations.map(o => o.entityName), outcome, {
          entitiesUpdated: successCount,
          failed: results.filter(r => r.error).length,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ results }, null, 2),
          }],
        };
      } catch (error) {
        auditLog('create', 'observation', props.login, observations.map(o => o.entityName), 'failure');
        return {
          content: [{
            type: 'text' as const,
            text: `**Error**: ${sanitizeError(error, 'add_observations')}`,
          }],
          isError: true,
        };
      }
    }
  );

  // =============================================================================
  // DEPRECATED: delete_entities - maintenance only, use cypher directly
  // =============================================================================
  /*
  server.tool(
    'delete_entities',
    'Delete multiple entities and their relations',
    {
      entityNames: z.array(z.string()).max(100).describe('Array of entity names to delete (max 100)'),
    },
    async ({ entityNames }) => {
      try {
        const neo4j = createNeo4jClient(env);
        const now = Date.now();

        const result = await neo4j.query(
          `
          MATCH (e:Entity)
          WHERE e.name IN $names AND e.validTo IS NULL
          SET e.validTo = $now
          WITH e
          OPTIONAL MATCH (e)-[r:RELATES_TO]-()
          WHERE r.validTo IS NULL
          SET r.validTo = $now
          RETURN count(DISTINCT e) AS deletedCount
          `,
          { names: entityNames, now }
        );

        const deletedCount = result[0]?.deletedCount || 0;

        const outcome = deletedCount === entityNames.length ? 'success' : deletedCount > 0 ? 'partial' : 'failure';
        auditLog('delete', 'entity', props.login, entityNames, outcome, {
          requested: entityNames.length,
          deleted: deletedCount,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              requested: entityNames,
              actuallyDeleted: deletedCount,
            }, null, 2),
          }],
        };
      } catch (error) {
        auditLog('delete', 'entity', props.login, entityNames, 'failure');
        return {
          content: [{
            type: 'text' as const,
            text: `**Error**: ${sanitizeError(error, 'delete_entities')}`,
          }],
          isError: true,
        };
      }
    }
  );
  */

  // =============================================================================
  // DEPRECATED: delete_observations - maintenance only, use cypher directly
  // =============================================================================
  /*
  server.tool(
    'delete_observations',
    'Delete specific observations from entities',
    {
      deletions: z.array(z.object({
        entityName: z.string().describe('Name of the entity'),
        observations: z.array(z.string()).max(100).describe('Observations to delete (max 100)'),
      })).max(50).describe('Array of deletion requests (max 50)'),
    },
    async ({ deletions }) => {
      try {
        const neo4j = createNeo4jClient(env);
        const embeddings = createEmbeddingsService(env);
        const results: any[] = [];

        for (const del of deletions) {
          const now = Date.now();

          const existing = await neo4j.query(
            `
            MATCH (e:Entity {name: $name})
            WHERE e.validTo IS NULL
            RETURN e.observations AS observations, e.entityType AS entityType
            `,
            { name: del.entityName }
          );

          if (existing.length === 0) {
            results.push({
              entityName: del.entityName,
              error: 'Entity not found',
            });
            continue;
          }

          const existingObs = parseObservations(existing[0].observations);
          const remainingObs = existingObs.filter(o => !del.observations.includes(o));

          const textForEmbedding = `${del.entityName} (${existing[0].entityType}): ${remainingObs.join(' ')}`;
          const embedding = await embeddings.generateEmbedding(textForEmbedding);

          await neo4j.query(
            `
            MATCH (e:Entity {name: $name})
            WHERE e.validTo IS NULL
            SET e.observations = $observations,
                e.embedding = $embedding,
                e.updatedAt = $now,
                e.version = COALESCE(e.version, 0) + 1
            `,
            {
              name: del.entityName,
              observations: JSON.stringify(remainingObs),
              embedding,
              now,
            }
          );

          results.push({
            entityName: del.entityName,
            deletedCount: existingObs.length - remainingObs.length,
          });
        }

        const successCount = results.filter(r => !r.error).length;
        const totalDeleted = results.reduce((sum, r) => sum + (r.deletedCount || 0), 0);
        const outcome = successCount === results.length ? 'success' : successCount > 0 ? 'partial' : 'failure';
        auditLog('delete', 'observation', props.login, deletions.map(d => d.entityName), outcome, {
          entitiesModified: successCount,
          observationsDeleted: totalDeleted,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ results }, null, 2),
          }],
        };
      } catch (error) {
        auditLog('delete', 'observation', props.login, deletions.map(d => d.entityName), 'failure');
        return {
          content: [{
            type: 'text' as const,
            text: `**Error**: ${sanitizeError(error, 'delete_observations')}`,
          }],
          isError: true,
        };
      }
    }
  );
  */

  // =============================================================================
  // DEPRECATED: delete_relations - maintenance only, use cypher directly
  // =============================================================================
  /*
  server.tool(
    'delete_relations',
    'Delete multiple relations',
    {
      relations: z.array(z.object({
        from: z.string().describe('Name of the source entity'),
        to: z.string().describe('Name of the target entity'),
        relationType: z.string().describe('Type of the relation'),
      })).max(100).describe('Array of relations to delete (max 100)'),
    },
    async ({ relations }) => {
      try {
        const neo4j = createNeo4jClient(env);
        const now = Date.now();
        const deletedRelations: any[] = [];

        for (const rel of relations) {
          try {
            const result = await neo4j.query(
              `
              MATCH (from:Entity {name: $from})-[r:RELATES_TO {relationType: $relationType}]->(to:Entity {name: $to})
              WHERE r.validTo IS NULL
              SET r.validTo = $now
              RETURN count(r) AS deletedCount
              `,
              { from: rel.from, to: rel.to, relationType: rel.relationType, now }
            );

            deletedRelations.push({
              from: rel.from,
              to: rel.to,
              relationType: rel.relationType,
              wasDeleted: (result[0]?.deletedCount || 0) > 0,
            });
          } catch (error) {
            deletedRelations.push({
              from: rel.from,
              to: rel.to,
              relationType: rel.relationType,
              error: sanitizeError(error, 'delete_relation'),
            });
          }
        }

        const successCount = deletedRelations.filter(r => r.wasDeleted && !r.error).length;
        const outcome = successCount === deletedRelations.length ? 'success' : successCount > 0 ? 'partial' : 'failure';
        auditLog('delete', 'relation', props.login, relations.map(r => `${r.from}->${r.to}`), outcome, {
          requested: relations.length,
          deleted: successCount,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ deleted: deletedRelations }, null, 2),
          }],
        };
      } catch (error) {
        auditLog('delete', 'relation', props.login, relations.map(r => `${r.from}->${r.to}`), 'failure');
        return {
          content: [{
            type: 'text' as const,
            text: `**Error**: ${sanitizeError(error, 'delete_relations')}`,
          }],
          isError: true,
        };
      }
    }
  );
  */

  // =============================================================================
  // DEPRECATED: get_relation - rarely used, relations come with open_nodes
  // =============================================================================
  /*
  server.tool(
    'get_relation',
    'Get a specific relation with its properties',
    {
      from: z.string().describe('Name of the source entity'),
      to: z.string().describe('Name of the target entity'),
      relationType: z.string().describe('Type of the relation'),
    },
    async ({ from, to, relationType }) => {
      try {
        const neo4j = createNeo4jClient(env);

        const result = await neo4j.query(
          `
          MATCH (from:Entity {name: $from})-[r:RELATES_TO {relationType: $relationType}]->(to:Entity {name: $to})
          WHERE r.validTo IS NULL
          RETURN from.name AS fromName, to.name AS toName,
                 r.relationType AS relationType, r.strength AS strength,
                 r.confidence AS confidence, r.createdAt AS createdAt,
                 r.updatedAt AS updatedAt, r.validFrom AS validFrom,
                 r.validTo AS validTo
          `,
          { from, to, relationType }
        );

        if (result.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'Relation not found' }, null, 2),
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ relation: addHumanDates(result[0]) }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `**Error**: ${sanitizeError(error, 'get_relation')}`,
          }],
          isError: true,
        };
      }
    }
  );
  */

  // =============================================================================
  // DEPRECATED: update_relation - rarely used
  // =============================================================================
  /*
  server.tool(
    'update_relation',
    'Update an existing relation with new properties',
    {
      relation: z.object({
        from: z.string().describe('Name of the source entity'),
        to: z.string().describe('Name of the target entity'),
        relationType: z.string().describe('Type of the relation'),
        strength: z.number().optional().describe('New strength value (0-1)'),
        confidence: z.number().optional().describe('New confidence value (0-1)'),
      }).describe('Relation to update with new values'),
    },
    async ({ relation }) => {
      try {
        const neo4j = createNeo4jClient(env);
        const now = Date.now();

        const result = await neo4j.query(
          `
          MATCH (from:Entity {name: $from})-[r:RELATES_TO {relationType: $relationType}]->(to:Entity {name: $to})
          WHERE r.validTo IS NULL
          SET r.strength = COALESCE($strength, r.strength),
              r.confidence = COALESCE($confidence, r.confidence),
              r.updatedAt = $now,
              r.version = COALESCE(r.version, 0) + 1
          RETURN from.name AS fromName, to.name AS toName,
                 r.relationType AS relationType, r.strength AS strength,
                 r.confidence AS confidence
          `,
          {
            from: relation.from,
            to: relation.to,
            relationType: relation.relationType,
            strength: relation.strength ?? null,
            confidence: relation.confidence ?? null,
            now,
          }
        );

        if (result.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'Relation not found' }, null, 2),
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ updated: result[0] }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `**Error**: ${sanitizeError(error, 'update_relation')}`,
          }],
          isError: true,
        };
      }
    }
  );
  */

  // =============================================================================
  // DEPRECATED: read_graph - useless at 1400+ entities, use semantic_search
  // =============================================================================
  /*
  server.tool(
    'read_graph',
    'Read the knowledge graph with pagination.',
    {
      limit: z.number().optional().describe('Maximum entities to return (default: 10, max recommended: 50)'),
      offset: z.number().optional().describe('Number of entities to skip for pagination (default: 0)'),
    },
    async ({ limit, offset }) => {
      try {
        const neo4j = createNeo4jClient(env);
        const skip = offset || 0;
        const safeLimit = limit || 10;

        const entityQuery = `
            MATCH (e:Entity)
            WHERE e.validTo IS NULL
            RETURN e.name AS name, e.entityType AS entityType,
                   e.observations AS observations, e.id AS id,
                   e.version AS version, e.createdAt AS createdAt,
                   e.updatedAt AS updatedAt, e.validFrom AS validFrom,
                   e.validTo AS validTo
            ORDER BY e.name
            SKIP $skip LIMIT $limit
          `;

        const entities = await neo4j.query(entityQuery, { skip, limit: safeLimit });
        const entityNames = entities.map((e: any) => e.name);

        const relations = await neo4j.query(
          `
          MATCH (from:Entity)-[r:RELATES_TO]->(to:Entity)
          WHERE r.validTo IS NULL AND from.validTo IS NULL AND to.validTo IS NULL
            AND from.name IN $names AND to.name IN $names
          RETURN from.name AS fromName, to.name AS toName,
                 r.relationType AS relationType
          `,
          { names: entityNames }
        );

        const countResult = await neo4j.query(
          `MATCH (e:Entity) WHERE e.validTo IS NULL RETURN count(e) AS total`
        );
        const totalEntities = countResult[0]?.total || 0;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              entities: entities.map((e: any) => addHumanDates({
                ...e,
                observations: parseObservations(e.observations),
              })),
              relations,
              pagination: {
                offset: skip,
                limit: safeLimit,
                returned: entities.length,
                total: totalEntities,
                pages: Math.ceil(totalEntities / safeLimit),
                currentPage: Math.floor(skip / safeLimit) + 1,
              },
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `**Error**: ${sanitizeError(error, 'read_graph')}`,
          }],
          isError: true,
        };
      }
    }
  );
  */

  // =============================================================================
  // DEPRECATED: get_entity_embedding - rarely used
  // =============================================================================
  /*
  server.tool(
    'get_entity_embedding',
    'Get the vector embedding for a specific entity',
    {
      entity_name: z.string().describe('Name of the entity'),
    },
    async ({ entity_name }) => {
      try {
        const neo4j = createNeo4jClient(env);

        const result = await neo4j.query(
          `
          MATCH (e:Entity {name: $name})
          WHERE e.validTo IS NULL
          RETURN e.embedding AS embedding, e.name AS name
          `,
          { name: entity_name }
        );

        if (result.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'Entity not found' }, null, 2),
            }],
          };
        }

        const embedding = result[0].embedding;
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              name: result[0].name,
              hasEmbedding: !!embedding,
              dimensions: embedding ? embedding.length : 0,
              embedding: embedding ? embedding.slice(0, 10).concat(['...']) : null,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `**Error**: ${sanitizeError(error, 'get_entity_embedding')}`,
          }],
          isError: true,
        };
      }
    }
  );
  */

  // =============================================================================
  // DEPRECATED: Temporal tools - rarely used, available via cypher if needed
  // =============================================================================
  /*
  server.tool(
    'get_entity_history',
    'Get entity metadata including version number.',
    {
      entityName: z.string().describe('Name of the entity'),
    },
    async ({ entityName }) => {
      try {
        const neo4j = createNeo4jClient(env);

        const result = await neo4j.query(
          `
          MATCH (e:Entity {name: $name})
          WHERE e.validTo IS NULL
          RETURN e.name AS name, e.entityType AS entityType,
                 e.observations AS observations, e.version AS version,
                 e.createdAt AS createdAt, e.updatedAt AS updatedAt,
                 e.validFrom AS validFrom, e.validTo AS validTo
          `,
          { name: entityName }
        );

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              history: result.map((e: any) => addHumanDates({
                ...e,
                observations: parseObservations(e.observations),
              })),
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `**Error**: ${sanitizeError(error, 'get_entity_history')}`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'get_relation_history',
    'Get the version history of a relation',
    {
      from: z.string().describe('Name of the source entity'),
      to: z.string().describe('Name of the target entity'),
      relationType: z.string().describe('Type of the relation'),
    },
    async ({ from, to, relationType }) => {
      try {
        const neo4j = createNeo4jClient(env);

        const result = await neo4j.query(
          `
          MATCH (from:Entity {name: $from})-[r:RELATES_TO {relationType: $relationType}]->(to:Entity {name: $to})
          RETURN from.name AS fromName, to.name AS toName,
                 r.relationType AS relationType, r.strength AS strength,
                 r.confidence AS confidence, r.version AS version,
                 r.createdAt AS createdAt, r.updatedAt AS updatedAt,
                 r.validFrom AS validFrom, r.validTo AS validTo
          ORDER BY r.version DESC
          `,
          { from, to, relationType }
        );

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ history: result.map((r: any) => addHumanDates(r)) }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `**Error**: ${sanitizeError(error, 'get_relation_history')}`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'get_graph_at_time',
    'Get the knowledge graph as it existed at a specific point in time',
    {
      timestamp: z.number().describe('Timestamp in milliseconds since epoch'),
    },
    async ({ timestamp }) => {
      try {
        const neo4j = createNeo4jClient(env);

        const entities = await neo4j.query(
          `
          MATCH (e:Entity)
          WHERE e.validFrom <= $timestamp
            AND (e.validTo IS NULL OR e.validTo > $timestamp)
          RETURN e.name AS name, e.entityType AS entityType,
                 e.observations AS observations
          `,
          { timestamp }
        );

        const relations = await neo4j.query(
          `
          MATCH (from:Entity)-[r:RELATES_TO]->(to:Entity)
          WHERE r.validFrom <= $timestamp
            AND (r.validTo IS NULL OR r.validTo > $timestamp)
            AND from.validFrom <= $timestamp
            AND (from.validTo IS NULL OR from.validTo > $timestamp)
            AND to.validFrom <= $timestamp
            AND (to.validTo IS NULL OR to.validTo > $timestamp)
          RETURN from.name AS fromName, to.name AS toName,
                 r.relationType AS relationType
          `,
          { timestamp }
        );

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              timestamp,
              timestampDate: formatTimestamp(timestamp),
              entities: entities.map((e: any) => addHumanDates({
                ...e,
                observations: parseObservations(e.observations),
              })),
              relations,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `**Error**: ${sanitizeError(error, 'get_graph_at_time')}`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'get_decayed_graph',
    'Get the knowledge graph with confidence values decayed based on time',
    {
      reference_time: z.number().optional().describe('Reference timestamp for decay calculation'),
      decay_factor: z.number().optional().describe('Decay factor override'),
    },
    async ({ reference_time, decay_factor }) => {
      try {
        const neo4j = createNeo4jClient(env);
        const refTime = reference_time || Date.now();
        const halfLife = 30 * 24 * 60 * 60 * 1000;
        const factor = decay_factor || Math.LN2 / halfLife;

        const entities = await neo4j.query(
          `
          MATCH (e:Entity)
          WHERE e.validTo IS NULL
          RETURN e.name AS name, e.entityType AS entityType,
                 e.observations AS observations, e.updatedAt AS updatedAt
          `
        );

        const relations = await neo4j.query(
          `
          MATCH (from:Entity)-[r:RELATES_TO]->(to:Entity)
          WHERE r.validTo IS NULL AND from.validTo IS NULL AND to.validTo IS NULL
          RETURN from.name AS fromName, to.name AS toName,
                 r.relationType AS relationType, r.confidence AS confidence,
                 r.updatedAt AS updatedAt
          `
        );

        const decayedRelations = relations.map((r: any) => {
          const age = refTime - (r.updatedAt || refTime);
          const decayedConfidence = (r.confidence || 1.0) * Math.exp(-factor * age);
          return {
            ...r,
            originalConfidence: r.confidence,
            decayedConfidence,
          };
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              referenceTime: refTime,
              referenceTimeDate: formatTimestamp(refTime),
              decayFactor: factor,
              entities: entities.map((e: any) => addHumanDates({
                ...e,
                observations: parseObservations(e.observations),
              })),
              relations: decayedRelations.map((r: any) => addHumanDates(r)),
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `**Error**: ${sanitizeError(error, 'get_decayed_graph')}`,
          }],
          isError: true,
        };
      }
    }
  );
  */
}
