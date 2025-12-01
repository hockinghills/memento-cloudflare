# CodeRabbit Review Instructions

This file ports a critical hybrid search implementation from the original Memento MCP server to Cloudflare Workers.

## Context
The original Memento uses Reciprocal Rank Fusion (RRF) to combine:
- Vector similarity search (semantic understanding)
- BM25 keyword search (exact matching in names and observations)

This combination creates "context aware" search that feels like it "reads your mind" - items appearing in BOTH result lists get boosted scores.

## Critical Review Points

1. **RRF Algorithm Correctness**
   - Formula should be: `1 / (k + rank + 1)` where k defaults to 60
   - Scores for items appearing in both lists should be SUMMED
   - Verify the implementation in `hybridSearchWithRRF()` matches this

2. **BM25 Weighting Preservation**
   - Name matches should get 2.0x boost
   - Each observation match should add 0.5 to the score
   - Check the Cypher query in the keyword search section

3. **HTTP Query API Compatibility**
   - Original used Neo4j Bolt driver with session management
   - This uses HTTP Query API with fetch()
   - Are there any semantic differences that could break the search behavior?

4. **Edge Cases**
   - Empty result handling
   - Vector/keyword search failures
   - JSON parsing of observations field

## What Success Looks Like
The search should produce the same ranking behavior as the original - items that match both semantically AND literally should rise to the top, creating that "knows what you're thinking" experience.
