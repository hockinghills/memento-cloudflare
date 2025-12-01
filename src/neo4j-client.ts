/**
 * Neo4j HTTP Client for Query API v2
 *
 * Uses Neo4j Aura's Query API over HTTPS instead of Bolt protocol.
 * This allows usage in Cloudflare Workers which don't support arbitrary TCP.
 */

export interface Neo4jConfig {
  uri: string;
  user: string;
  password: string;
}

export interface QueryResult {
  data: {
    fields: string[];
    values: any[][];
  };
  bookmarks?: string[];
}

export class Neo4jHttpClient {
  private config: Neo4jConfig;
  private authHeader: string;

  constructor(config: Neo4jConfig) {
    this.config = config;
    // Create Basic Auth header
    this.authHeader = 'Basic ' + btoa(`${config.user}:${config.password}`);
  }

  /**
   * Execute a Cypher query
   */
  async query<T = any>(
    statement: string,
    parameters: Record<string, any> = {}
  ): Promise<T[]> {
    const response = await fetch(this.config.uri, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': this.authHeader,
      },
      body: JSON.stringify({
        statement,
        parameters,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Neo4j query failed (${response.status}): ${errorText}`
      );
    }

    const result: QueryResult = await response.json();

    // Transform rows into objects
    return result.data.values.map((row) => {
      const obj: any = {};
      result.data.fields.forEach((field, i) => {
        obj[field] = row[i];
      });
      return obj as T;
    });
  }

  /**
   * Execute a query and return raw result
   */
  async queryRaw(
    statement: string,
    parameters: Record<string, any> = {}
  ): Promise<QueryResult> {
    const response = await fetch(this.config.uri, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': this.authHeader,
      },
      body: JSON.stringify({
        statement,
        parameters,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Neo4j query failed (${response.status}): ${errorText}`
      );
    }

    return await response.json();
  }

  /**
   * Execute multiple queries in a transaction
   */
  async transaction(queries: Array<{ statement: string; parameters?: Record<string, any> }>) {
    // Query API v2 doesn't support explicit transactions the same way
    // For now, execute sequentially
    // TODO: Investigate if there's a better way to handle this
    const results = [];
    for (const query of queries) {
      const result = await this.query(query.statement, query.parameters || {});
      results.push(result);
    }
    return results;
  }
}
