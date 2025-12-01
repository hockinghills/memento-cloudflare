// Test if Neo4j vector search works via HTTP Query API

const VOYAGE_API_KEY = 'pa-69bzYhe0xyi6r0oniZJfB2SN5hQ675mZdZ0c8VK6FCb';
const NEO4J_URL = 'https://2430c020.databases.neo4j.io/db/neo4j/query/v2';
const NEO4J_AUTH = 'Basic ' + Buffer.from('neo4j:4kKs4iTLH4Aw-WyfIKTKeLYFIq9cfg8IM0I1_Ix2n_4').toString('base64');

async function test() {
  console.log('Step 1: Generating test embedding...');

  // Generate a test embedding
  const embeddingResponse = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: 'test search query',
      model: 'voyage-3-large',
      output_dimension: 2048,
    }),
  });

  if (!embeddingResponse.ok) {
    console.error('Embedding generation failed:', await embeddingResponse.text());
    return;
  }

  const embeddingData = await embeddingResponse.json();
  const testVector = embeddingData.data[0].embedding;
  console.log(`Generated embedding with ${testVector.length} dimensions`);
  console.log('First 5 values:', testVector.slice(0, 5));

  console.log('\nStep 2: Testing vector search via HTTP Query API...');

  // Test vector search via HTTP
  const vectorQuery = {
    statement: `
      CALL db.index.vector.queryNodes(
        'entity_embeddings',
        3,
        $embedding
      )
      YIELD node, score
      RETURN node.name AS name, score
      LIMIT 3
    `,
    parameters: {
      embedding: testVector,
    },
  };

  const queryResponse = await fetch(NEO4J_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': NEO4J_AUTH,
    },
    body: JSON.stringify(vectorQuery),
  });

  const queryData = await queryResponse.json();

  if (!queryResponse.ok) {
    console.error('Vector search FAILED via HTTP Query API');
    console.error('Response:', JSON.stringify(queryData, null, 2));
    console.error('\nThis means we cannot use CALL db.index.vector.queryNodes() via HTTP');
    console.error('We need a different approach for the Worker implementation');
    return;
  }

  console.log('Vector search SUCCEEDED via HTTP Query API!');
  console.log('Results:', JSON.stringify(queryData, null, 2));
  console.log('\nThe kung fu can be preserved!');
}

test().catch(console.error);
