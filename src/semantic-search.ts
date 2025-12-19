/**
 * Semantic Search with Hybrid RRF
 *
 * Preserves Gannon's kung fu from the original Memento implementation:
 * - Vector similarity search for semantic understanding
 * - BM25-style keyword search for exact matching
 * - Reciprocal Rank Fusion (RRF) to intelligently combine results
 * - Items appearing in both searches get boosted (the "context aware" magic)
 */

import { Neo4jHttpClient } from './neo4j-client';
import { formatTimestamp } from './utils/date-utils';

export interface SearchOptions {
  limit?: number;
  minSimilarity?: number;
  entityTypes?: string[];
  hybridSearch?: boolean;
  rrfK?: number; // RRF constant, default 60
}

export interface Entity {
  name: string;
  entityType: string;
  observations: string[];
  id?: string;
  version?: number;
  createdAt?: number;
  updatedAt?: number;
  created?: string | null;  // Human-readable date
  updated?: string | null;  // Human-readable date
}

export interface Relation {
  from: string;
  to: string;
  relationType: string;
}

export interface SearchResult {
  entities: Entity[];
  relations: Relation[];
  total?: number;
  timeTaken?: number;
}

/**
 * Hybrid search with Reciprocal Rank Fusion
 *
 * This is where the magic happens:
 * 1. Vector search finds semantically similar entities
 * 2. Keyword search finds exact matches in names and observations
 * 3. RRF combines them: items in BOTH lists get higher scores
 */
export async function hybridSearchWithRRF(
  neo4j: Neo4jHttpClient,
  queryVector: number[],
  queryText: string,
  options: SearchOptions = {}
): Promise<SearchResult> {
  const limit = options.limit || 10;
  const rrfK = options.rrfK || 60; // Default k constant from Gannon's implementation
  const startTime = Date.now();

  try {
    // Step 1: Vector similarity search
    // Uses Neo4j's vector index to find semantically similar entities
    const vectorResults = await neo4j.query<{
      id: string;
      entityType: string;
      vectorScore: number;
    }>(
      `
      CALL db.index.vector.queryNodes(
        'entity_embeddings',
        $limit,
        $embedding
      )
      YIELD node, score
      RETURN node.name AS id, node.entityType AS entityType, score AS vectorScore
      ORDER BY score DESC
    `,
      {
        limit: Math.floor(limit * 2), // Get more candidates for RRF
        embedding: queryVector,
      }
    );

    // Step 2: BM25-style keyword search
    // Searches both entity names and observations with weighting:
    // - Name matches get 2.0x boost
    // - Each observation match adds 0.5
    const keywordResults = await neo4j.query<{
      id: string;
      entityType: string;
      bm25Score: number;
    }>(
      `
      MATCH (e:Entity)
      WHERE e.name CONTAINS $queryText
        OR ANY(obs IN e.observations WHERE obs CONTAINS $queryText)
      WITH e,
        CASE
          WHEN e.name CONTAINS $queryText THEN 2.0
          ELSE 1.0
        END AS nameBoost,
        size([obs IN e.observations WHERE obs CONTAINS $queryText]) AS obsMatches
      WITH e, (nameBoost + (obsMatches * 0.5)) AS bm25Score
      WHERE bm25Score > 0
      RETURN e.name AS id, e.entityType AS entityType, bm25Score
      ORDER BY bm25Score DESC
      LIMIT $limit
    `,
      {
        queryText,
        limit: Math.floor(limit * 2),
      }
    );

    // Step 3: Reciprocal Rank Fusion (RRF)
    // The kung fu: combining rankings from both searches
    // Formula: 1 / (k + rank + 1)
    // Items in both lists get their scores SUMMED
    const rrfScores = new Map<
      string,
      {
        score: number;
        entityType: string;
        vectorScore?: number;
        bm25Score?: number;
      }
    >();

    // Add vector search results
    vectorResults.forEach((record, index) => {
      const rrfScore = 1 / (rrfK + index + 1);
      rrfScores.set(record.id, {
        score: rrfScore,
        entityType: record.entityType,
        vectorScore: record.vectorScore,
      });
    });

    // Add keyword search results (combining with existing if present)
    keywordResults.forEach((record, index) => {
      const rrfScore = 1 / (rrfK + index + 1);
      const existing = rrfScores.get(record.id);

      if (existing) {
        // THIS IS THE MAGIC: items in both lists get boosted
        rrfScores.set(record.id, {
          score: existing.score + rrfScore, // SUM the scores
          entityType: record.entityType,
          vectorScore: existing.vectorScore,
          bm25Score: record.bm25Score,
        });
      } else {
        rrfScores.set(record.id, {
          score: rrfScore,
          entityType: record.entityType,
          bm25Score: record.bm25Score,
        });
      }
    });

    // Step 4: Sort by combined RRF score and take top results
    const sortedResults = Array.from(rrfScores.entries())
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limit);

    // Step 5: Get full entity data for top results
    if (sortedResults.length === 0) {
      return {
        entities: [],
        relations: [],
        total: 0,
        timeTaken: Date.now() - startTime,
      };
    }

    const entityNames = sortedResults.map(([name]) => name);

    // Get full entity details
    const entities = await neo4j.query<{
      name: string;
      entityType: string;
      observations: string;
      id: string;
      version: number;
      createdAt: number;
      updatedAt: number;
    }>(
      `
      MATCH (e:Entity)
      WHERE e.name IN $names
      AND e.validTo IS NULL
      RETURN e.name AS name, e.entityType AS entityType,
             e.observations AS observations, e.id AS id,
             e.version AS version, e.createdAt AS createdAt,
             e.updatedAt AS updatedAt
    `,
      { names: entityNames }
    );

    // Get relations between the entities
    const relations = await neo4j.query<{
      fromName: string;
      toName: string;
      relationType: string;
    }>(
      `
      MATCH (from:Entity)-[r:RELATES_TO]->(to:Entity)
      WHERE from.name IN $names
      AND to.name IN $names
      AND r.validTo IS NULL
      RETURN from.name AS fromName, to.name AS toName, r.relationType AS relationType
    `,
      { names: entityNames }
    );

    return {
      entities: entities.map((e) => ({
        name: e.name,
        entityType: e.entityType,
        observations: (() => {
          try {
            return JSON.parse(e.observations);
          } catch (error) {
            console.error(`Failed to parse observations for entity ${e.name}:`, error);
            return [];
          }
        })(),
        id: e.id,
        version: e.version,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        created: formatTimestamp(e.createdAt),
        updated: formatTimestamp(e.updatedAt),
      })),
      relations: relations.map((r) => ({
        from: r.fromName,
        to: r.toName,
        relationType: r.relationType,
      })),
      total: entities.length,
      timeTaken: Date.now() - startTime,
    };
  } catch (error) {
    console.error('Hybrid search failed:', error);
    throw error;
  }
}

/**
 * Pure vector search (no keyword component)
 */
export async function vectorSearch(
  neo4j: Neo4jHttpClient,
  queryVector: number[],
  options: SearchOptions = {}
): Promise<SearchResult> {
  const limit = options.limit || 10;
  const minSimilarity = options.minSimilarity || 0.6;
  const startTime = Date.now();

  try {
    const vectorResults = await neo4j.query<{
      name: string;
      entityType: string;
      score: number;
    }>(
      `
      CALL db.index.vector.queryNodes(
        'entity_embeddings',
        $limit,
        $embedding
      )
      YIELD node, score
      WHERE score >= $minScore
      RETURN node.name AS name, node.entityType AS entityType, score
      ORDER BY score DESC
    `,
      {
        limit,
        embedding: queryVector,
        minScore: minSimilarity,
      }
    );

    if (vectorResults.length === 0) {
      return {
        entities: [],
        relations: [],
        total: 0,
        timeTaken: Date.now() - startTime,
      };
    }

    const entityNames = vectorResults.map((r) => r.name);

    // Get full entity details
    const entities = await neo4j.query<{
      name: string;
      entityType: string;
      observations: string;
      id: string;
      version: number;
      createdAt: number;
      updatedAt: number;
    }>(
      `
      MATCH (e:Entity)
      WHERE e.name IN $names
      AND e.validTo IS NULL
      RETURN e.name AS name, e.entityType AS entityType,
             e.observations AS observations, e.id AS id,
             e.version AS version, e.createdAt AS createdAt,
             e.updatedAt AS updatedAt
    `,
      { names: entityNames }
    );

    // Get relations
    const relations = await neo4j.query<{
      fromName: string;
      toName: string;
      relationType: string;
    }>(
      `
      MATCH (from:Entity)-[r:RELATES_TO]->(to:Entity)
      WHERE from.name IN $names
      AND to.name IN $names
      AND r.validTo IS NULL
      RETURN from.name AS fromName, to.name AS toName, r.relationType AS relationType
    `,
      { names: entityNames }
    );

    return {
      entities: entities.map((e) => ({
        name: e.name,
        entityType: e.entityType,
        observations: (() => {
          try {
            return JSON.parse(e.observations);
          } catch (error) {
            console.error(`Failed to parse observations for entity ${e.name}:`, error);
            return [];
          }
        })(),
        id: e.id,
        version: e.version,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        created: formatTimestamp(e.createdAt),
        updated: formatTimestamp(e.updatedAt),
      })),
      relations: relations.map((r) => ({
        from: r.fromName,
        to: r.toName,
        relationType: r.relationType,
      })),
      total: entities.length,
      timeTaken: Date.now() - startTime,
    };
  } catch (error) {
    console.error('Vector search failed:', error);
    throw error;
  }
}
