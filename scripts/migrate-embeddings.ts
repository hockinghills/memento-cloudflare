/**
 * Embedding Migration Script
 *
 * Regenerates all entity embeddings using the new voyage-3.5 model.
 * This is a one-time migration to upgrade from voyage-3-large to voyage-3.5.
 *
 * Same architecture, better fuel for Gannon's hybrid RRF search.
 *
 * Usage:
 *   npx tsx scripts/migrate-embeddings.ts
 *
 * Or with custom batch size and delay:
 *   BATCH_SIZE=5 BATCH_DELAY_MS=2000 npx tsx scripts/migrate-embeddings.ts
 */

import 'dotenv/config';

// Configuration from environment
const NEO4J_URI = process.env.NEO4J_URI!;
const NEO4J_USER = process.env.NEO4J_USER!;
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD!;
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY!;

// Migration settings - conservative defaults to avoid rate limits
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '10', 10);
const BATCH_DELAY_MS = parseInt(process.env.BATCH_DELAY_MS || '1500', 10);
const VOYAGE_MODEL = 'voyage-3.5';
const EMBEDDING_DIMENSIONS = 2048;

// Validate environment
function validateEnv(): void {
  const required = ['NEO4J_URI', 'NEO4J_USER', 'NEO4J_PASSWORD', 'VOYAGE_API_KEY'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    console.error('Missing required environment variables:', missing.join(', '));
    console.error('Please ensure .env file exists with these values.');
    process.exit(1);
  }
}

// Neo4j HTTP Query API client (same pattern as neo4j-client.ts)
interface QueryResult {
  data: {
    fields: string[];
    values: any[][];
  };
}

async function neo4jQuery<T>(statement: string, parameters: Record<string, any> = {}): Promise<T[]> {
  const authHeader = 'Basic ' + Buffer.from(`${NEO4J_USER}:${NEO4J_PASSWORD}`).toString('base64');

  const response = await fetch(NEO4J_URI, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': authHeader,
    },
    body: JSON.stringify({ statement, parameters }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Neo4j query failed (${response.status}): ${errorText}`);
  }

  const result: QueryResult = await response.json();

  return result.data.values.map((row) => {
    const obj: any = {};
    result.data.fields.forEach((field, i) => {
      obj[field] = row[i];
    });
    return obj as T;
  });
}

// VoyageAI embedding generation (same pattern as embedding-service.ts)
async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const response = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: texts,
      model: VOYAGE_MODEL,
      output_dimension: EMBEDDING_DIMENSIONS,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`VoyageAI embedding failed (${response.status}): ${errorText}`);
  }

  const result = await response.json();

  if (!result.data || !Array.isArray(result.data)) {
    throw new Error('Invalid response from VoyageAI API');
  }

  return result.data.map((item: any) => item.embedding);
}

// Entity interface
interface Entity {
  name: string;
  entityType: string;
  observations: string;
}

// Build embedding text for an entity (same format used in create_entities tool)
function buildEmbeddingText(entity: Entity): string {
  let observations: string[];
  try {
    observations = JSON.parse(entity.observations);
  } catch {
    observations = [entity.observations];
  }
  return `${entity.name} (${entity.entityType}): ${observations.join(' ')}`;
}

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Main migration function
async function migrateEmbeddings(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Embedding Migration: voyage-3-large -> voyage-3.5');
  console.log('='.repeat(60));
  console.log(`Model: ${VOYAGE_MODEL}`);
  console.log(`Dimensions: ${EMBEDDING_DIMENSIONS}`);
  console.log(`Batch Size: ${BATCH_SIZE}`);
  console.log(`Batch Delay: ${BATCH_DELAY_MS}ms`);
  console.log('='.repeat(60));

  // Step 1: Fetch all entities
  console.log('\n[1/3] Fetching all entities from Neo4j...');

  const entities = await neo4jQuery<Entity>(`
    MATCH (e:Entity)
    WHERE e.validTo IS NULL
    RETURN e.name AS name, e.entityType AS entityType, e.observations AS observations
  `);

  console.log(`Found ${entities.length} entities to migrate.`);

  if (entities.length === 0) {
    console.log('No entities to migrate. Exiting.');
    return;
  }

  // Step 2: Process in batches
  console.log('\n[2/3] Generating new embeddings with voyage-3.5...');

  const totalBatches = Math.ceil(entities.length / BATCH_SIZE);
  let successCount = 0;
  let failCount = 0;
  const errors: { name: string; error: string }[] = [];

  for (let i = 0; i < entities.length; i += BATCH_SIZE) {
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batch = entities.slice(i, i + BATCH_SIZE);

    console.log(`\nBatch ${batchNum}/${totalBatches} (${batch.length} entities):`);

    try {
      // Build texts for embedding
      const texts = batch.map(buildEmbeddingText);

      // Generate embeddings
      const embeddings = await generateEmbeddings(texts);

      // Update each entity's embedding in Neo4j
      for (let j = 0; j < batch.length; j++) {
        const entity = batch[j];
        const embedding = embeddings[j];

        try {
          await neo4jQuery(
            `
            MATCH (e:Entity {name: $name})
            WHERE e.validTo IS NULL
            SET e.embedding = $embedding, e.embeddingUpdatedAt = $timestamp
            `,
            {
              name: entity.name,
              embedding: embedding,
              timestamp: Date.now(),
            }
          );

          successCount++;
          console.log(`  [OK] ${entity.name}`);
        } catch (updateError: any) {
          failCount++;
          const errorMsg = updateError.message || String(updateError);
          errors.push({ name: entity.name, error: errorMsg });
          console.error(`  [FAIL] ${entity.name}: ${errorMsg}`);
        }
      }
    } catch (batchError: any) {
      // If batch embedding fails, mark all as failed
      for (const entity of batch) {
        failCount++;
        const errorMsg = batchError.message || String(batchError);
        errors.push({ name: entity.name, error: errorMsg });
        console.error(`  [FAIL] ${entity.name}: ${errorMsg}`);
      }
    }

    // Rate limiting delay between batches (except for last batch)
    if (i + BATCH_SIZE < entities.length) {
      console.log(`  Waiting ${BATCH_DELAY_MS}ms before next batch...`);
      await sleep(BATCH_DELAY_MS);
    }
  }

  // Step 3: Summary
  console.log('\n[3/3] Migration Summary');
  console.log('='.repeat(60));
  console.log(`Total entities: ${entities.length}`);
  console.log(`Successfully migrated: ${successCount}`);
  console.log(`Failed: ${failCount}`);

  if (errors.length > 0) {
    console.log('\nFailed entities:');
    for (const { name, error } of errors) {
      console.log(`  - ${name}: ${error}`);
    }
  }

  if (failCount === 0) {
    console.log('\nMigration completed successfully!');
    console.log('All entity embeddings have been upgraded to voyage-3.5 (2048 dimensions).');
  } else {
    console.log('\nMigration completed with errors.');
    console.log('Please review failed entities and retry if needed.');
    process.exit(1);
  }
}

// Run migration
validateEnv();
migrateEmbeddings().catch((error) => {
  console.error('\nMigration failed with error:', error);
  process.exit(1);
});
