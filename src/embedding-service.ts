/**
 * VoyageAI Embedding Service
 *
 * Uses VoyageAI's voyage-3-large model (2048 dimensions)
 * This is the same embedding model used in the local Memento instance
 * to ensure semantic consistency.
 */

export interface EmbeddingServiceConfig {
  apiKey: string;
  model?: string;
  dimensions?: number;
}

export class VoyageEmbeddingService {
  private apiKey: string;
  private model: string;
  private dimensions: number;
  private baseUrl = 'https://api.voyageai.com/v1/embeddings';

  constructor(config: EmbeddingServiceConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model || 'voyage-3-large';
    this.dimensions = config.dimensions || 2048;
  }

  /**
   * Generate embedding for a text query
   */
  async generateEmbedding(text: string): Promise<number[]> {
    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          input: text,
          model: this.model,
          output_dimension: this.dimensions,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `VoyageAI embedding failed (${response.status}): ${errorText}`
        );
      }

      const result = await response.json();

      if (!result.data || !result.data[0] || !result.data[0].embedding) {
        throw new Error('Invalid response from VoyageAI API');
      }

      return result.data[0].embedding;
    } catch (error) {
      console.error('Failed to generate embedding:', error);
      throw error;
    }
  }

  /**
   * Generate embeddings for multiple texts in batch
   */
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          input: texts,
          model: this.model,
          output_dimension: this.dimensions,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `VoyageAI batch embedding failed (${response.status}): ${errorText}`
        );
      }

      const result = await response.json();

      if (!result.data || !Array.isArray(result.data)) {
        throw new Error('Invalid response from VoyageAI API');
      }

      return result.data.map((item: any) => item.embedding);
    } catch (error) {
      console.error('Failed to generate batch embeddings:', error);
      throw error;
    }
  }

  getModel(): string {
    return this.model;
  }

  getDimensions(): number {
    return this.dimensions;
  }
}
