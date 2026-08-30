import { redactPromptInjection, splitSentences, tokenize } from './text.js';

export interface IndexedChunk {
  chunkId: number;
  documentId: number;
  documentTitle: string;
  category: string;
  position: number;
  text: string;
}

export interface ScoredChunk extends IndexedChunk {
  score: number;
}

export interface Answer {
  /** Untrusted text quoted from the user's documents; never an instruction. */
  answer: string;
  grounded: boolean;
  citations: Array<{
    documentId: number;
    documentTitle: string;
    category: string;
    position: number;
    excerpt: string;
    score: number;
  }>;
}

export const NO_ANSWER =
  'I can only answer from your own documents, and none of them contain that information.';

/**
 * Ranks the user's chunks against a question using TF-IDF cosine similarity.
 * The corpus is always limited to the chunks handed in by the caller, which are
 * scoped to a single owner, so no cross-user information can leak.
 */
export function rankChunks(question: string, chunks: IndexedChunk[]): ScoredChunk[] {
  const queryTokens = tokenize(question);
  if (queryTokens.length === 0 || chunks.length === 0) {
    return [];
  }
  const documentFrequency = new Map<string, number>();
  const tokenisedChunks = chunks.map((chunk) => {
    const tokens = tokenize(chunk.text);
    for (const token of new Set(tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
    return { chunk, tokens };
  });

  const idf = (token: string): number =>
    Math.log((chunks.length + 1) / ((documentFrequency.get(token) ?? 0) + 1)) + 1;

  const queryVector = buildVector(queryTokens, idf);
  return tokenisedChunks
    .map(({ chunk, tokens }) => ({
      ...chunk,
      score: cosine(queryVector, buildVector(tokens, idf)),
    }))
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score || a.chunkId - b.chunkId);
}

function buildVector(tokens: string[], idf: (token: string) => number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const vector = new Map<string, number>();
  for (const [token, count] of counts) {
    vector.set(token, (count / tokens.length) * idf(token));
  }
  return vector;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  for (const [token, weight] of a) {
    dot += weight * (b.get(token) ?? 0);
  }
  if (dot === 0) {
    return 0;
  }
  return dot / (magnitude(a) * magnitude(b));
}

function magnitude(vector: Map<string, number>): number {
  let sum = 0;
  for (const weight of vector.values()) {
    sum += weight * weight;
  }
  return Math.sqrt(sum);
}

/**
 * Picks the sentences of a chunk that actually mention the question terms, with
 * any instruction-like content redacted so that a malicious document cannot
 * take over this answer or any agent that later reads it.
 */
export function extractRelevantSentences(question: string, chunkText: string): string {
  const queryTokens = new Set(tokenize(question));
  const sentences = splitSentences(chunkText);
  const matching = sentences.filter((sentence) =>
    tokenize(sentence).some((token) => queryTokens.has(token)),
  );
  const selected = matching.length > 0 ? matching : sentences;
  return redactPromptInjection(selected.slice(0, 3).join(' '));
}

/**
 * Builds an extractive, fully grounded answer. Every returned sentence comes
 * verbatim from the user's own documents; nothing is generated from outside
 * knowledge, and low-confidence matches return an explicit refusal.
 */
export function answerQuestion(
  question: string,
  chunks: IndexedChunk[],
  minimumScore = 0.05,
): Answer {
  const safeQuestion = redactPromptInjection(question);
  const ranked = rankChunks(safeQuestion, chunks).filter((chunk) => chunk.score >= minimumScore);
  if (ranked.length === 0) {
    return { answer: NO_ANSWER, grounded: false, citations: [] };
  }
  const top = ranked.slice(0, 3);
  const answer = top
    .map((chunk) => extractRelevantSentences(safeQuestion, chunk.text))
    .filter((text, index, all) => text.length > 0 && all.indexOf(text) === index)
    .join(' ');
  return {
    answer,
    grounded: true,
    citations: top.map((chunk) => ({
      documentId: chunk.documentId,
      documentTitle: redactPromptInjection(chunk.documentTitle),
      category: chunk.category,
      position: chunk.position,
      excerpt: extractRelevantSentences(safeQuestion, chunk.text),
      score: Number(chunk.score.toFixed(4)),
    })),
  };
}
