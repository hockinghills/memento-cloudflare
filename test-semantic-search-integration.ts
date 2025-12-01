/**
 * Integration test for semantic search implementation
 *
 * Tests the hybrid RRF search against live Neo4j database
 * to verify it produces the expected "mind reading" behavior.
 */

import { fileURLToPath } from 'node:url';
import { Neo4jHttpClient } from './src/neo4j-client';
import { hybridSearchWithRRF } from './src/semantic-search';
import { VoyageEmbeddingService } from './src/embedding-service';

interface TestConfig {
  neo4jUri: string;
  neo4jUser: string;
  neo4jPassword: string;
  voyageApiKey: string;
}

async function loadConfig(): Promise<TestConfig> {
  // Load from environment or .env file
  const dotenv = await import('dotenv');
  dotenv.config();

  return {
    neo4jUri: process.env.NEO4J_URI || '',
    neo4jUser: process.env.NEO4J_USER || '',
    neo4jPassword: process.env.NEO4J_PASSWORD || '',
    voyageApiKey: process.env.VOYAGE_API_KEY || '',
  };
}

async function testHybridSearch(
  neo4j: Neo4jHttpClient,
  embedding: VoyageEmbeddingService,
  query: string
): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing query: "${query}"`);
  console.log('='.repeat(60));

  // Generate embedding for query
  const queryVector = await embedding.generateEmbedding(query);
  console.log(`Generated embedding vector (${queryVector.length} dimensions)`);

  // Perform hybrid search
  const startTime = Date.now();
  const results = await hybridSearchWithRRF(
    neo4j,
    queryVector,
    query,
    { limit: 5, rrfK: 60 }
  );
  const duration = Date.now() - startTime;

  console.log(`\nSearch completed in ${duration}ms`);
  console.log(`Found ${results.total} entities`);

  // Display results
  results.entities.forEach((entity, index) => {
    console.log(`\n${index + 1}. ${entity.name} (${entity.entityType})`);
    console.log(`   Observations: ${entity.observations.length}`);
    if (entity.observations.length > 0) {
      const preview = entity.observations[0].substring(0, 100);
      console.log(`   First: ${preview}${entity.observations[0].length > 100 ? '...' : ''}`);
    }
  });

  // Display relations
  if (results.relations.length > 0) {
    console.log(`\nRelations found: ${results.relations.length}`);
    results.relations.forEach((rel) => {
      console.log(`  ${rel.from} --[${rel.relationType}]--> ${rel.to}`);
    });
  }
}

async function main() {
  console.log('Semantic Search Integration Test');
  console.log('=================================\n');

  // Load configuration
  const config = await loadConfig();

  if (!config.neo4jUri || !config.neo4jUser || !config.neo4jPassword) {
    throw new Error('Missing Neo4j credentials. Set NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD');
  }

  if (!config.voyageApiKey) {
    throw new Error('Missing VoyageAI API key. Set VOYAGE_API_KEY');
  }

  // Initialize services
  const neo4j = new Neo4jHttpClient({
    uri: config.neo4jUri,
    user: config.neo4jUser,
    password: config.neo4jPassword,
  });

  const embedding = new VoyageEmbeddingService({ apiKey: config.voyageApiKey });

  // Test queries that should demonstrate hybrid search strength
  const testQueries = [
    // Should match both semantically and literally
    'collaboration patterns with Willie',

    // Should find semantic matches even with different wording
    'working together effectively',

    // Should boost exact name matches via BM25
    'TeamBadass',

    // Should combine vector + keyword for best results
    'memory systems and knowledge graphs',
  ];

  try {
    for (const query of testQueries) {
      await testHybridSearch(neo4j, embedding, query);

      // Small delay between queries to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log('\n' + '='.repeat(60));
    console.log('All tests completed successfully!');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\nTest failed:', error);
    throw error;
  }
}

// Run tests if executed directly
const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] === currentFile) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { main as runIntegrationTests };
