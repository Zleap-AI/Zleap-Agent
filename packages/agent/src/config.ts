export type EmbeddingConfig = {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  dimension?: number;
};

export type PersistenceConfig = {
  databaseUrl?: string;
  embedding?: EmbeddingConfig;
};
