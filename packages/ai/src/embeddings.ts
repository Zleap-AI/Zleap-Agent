/**
 * Minimal embeddings client for OpenAI-compatible `/embeddings` endpoints, plus
 * a deterministic offline embedder for tests and for running without an
 * embedding endpoint configured. Kept dependency-free (fetch only).
 */

export type EmbedRequest = {
  baseUrl: string;
  apiKey: string;
  model: string;
  input: string[];
  signal?: AbortSignal;
};

export type EmbedResult = {
  embeddings: number[][];
  model: string;
};

type OpenAiEmbeddingResponse = {
  data?: Array<{ embedding: number[]; index: number }>;
  model?: string;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** Call an OpenAI-compatible embeddings endpoint. Throws on HTTP/parse errors. */
export async function embed(request: EmbedRequest): Promise<EmbedResult> {
  if (!request.baseUrl) {
    throw new Error('embed: baseUrl is required');
  }
  if (!request.apiKey) {
    throw new Error('embed: apiKey is required');
  }
  if (request.input.length === 0) {
    return { embeddings: [], model: request.model };
  }

  const response = await fetch(`${normalizeBaseUrl(request.baseUrl)}/embeddings`, {
    method: 'POST',
    signal: request.signal,
    headers: {
      Authorization: `Bearer ${request.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: request.model, input: request.input }),
  });

  if (!response.ok) {
    throw new Error(`embed: HTTP ${response.status}: ${await response.text()}`);
  }

  const json = (await response.json()) as OpenAiEmbeddingResponse;
  const rows = [...(json.data ?? [])].sort((a, b) => a.index - b.index);
  return { embeddings: rows.map((row) => row.embedding), model: json.model ?? request.model };
}

/**
 * Deterministic, dependency-free embedding for offline use and tests. Hashes
 * tokens into `dim` buckets and L2-normalizes — similar texts share buckets, so
 * cosine similarity is meaningful enough to exercise recall ordering.
 */
export function fauxEmbed(text: string, dim = 64): number[] {
  const vector = new Array<number>(dim).fill(0);
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const bucket = Math.abs(hash) % dim;
    vector[bucket] += 1;
  }
  return l2normalize(vector);
}

export function l2normalize(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  if (norm === 0) {
    return vector;
  }
  return vector.map((value) => value / norm);
}

/** Cosine similarity of two equal-length vectors (1 = identical direction). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
