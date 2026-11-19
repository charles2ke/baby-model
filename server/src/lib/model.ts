import { selectSkill } from './skills.js';
import { redactPromptInjection, splitSentences, terms } from './text.js';

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
  /** The skill that shaped the answer, when one applied to the question. */
  skill?: { id: string; name: string };
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

/** How much a term tells chunks apart: rare terms weigh more than common ones. */
type TermWeight = (term: string) => number;

/**
 * Ranks the user's chunks against a question using TF-IDF cosine similarity
 * over stemmed terms. The corpus is always limited to the chunks handed in by
 * the caller, which are scoped to a single owner, so no cross-user information
 * can leak.
 */
export function rankChunks(question: string, chunks: IndexedChunk[]): ScoredChunk[] {
  return scoreChunks(question, chunks).ranked;
}

/** Ranks the chunks and also returns the term weights the ranking used. */
function scoreChunks(
  question: string,
  chunks: IndexedChunk[],
): { ranked: ScoredChunk[]; idf: TermWeight } {
  const documentFrequency = new Map<string, number>();
  // The inverse document frequency of a term never changes within a call, so
  // it is computed once instead of once per chunk.
  const idfCache = new Map<string, number>();
  const idf: TermWeight = (term) => {
    let value = idfCache.get(term);
    if (value === undefined) {
      value = Math.log((chunks.length + 1) / ((documentFrequency.get(term) ?? 0) + 1)) + 1;
      idfCache.set(term, value);
    }
    return value;
  };

  const queryTerms = terms(question);
  if (queryTerms.length === 0 || chunks.length === 0) {
    return { ranked: [], idf };
  }
  const stems = new Map<string, string>();
  const chunkTerms = chunks.map((chunk) => {
    const termsOfChunk = terms(chunk.text, stems);
    for (const term of new Set(termsOfChunk)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
    return { chunk, terms: termsOfChunk };
  });

  const queryVector = buildVector(queryTerms, idf);
  const queryMagnitude = magnitude(queryVector);
  const ranked = chunkTerms
    .map(({ chunk, terms: termsOfChunk }) => ({
      ...chunk,
      score: cosine(queryVector, queryMagnitude, buildVector(termsOfChunk, idf)),
    }))
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score || a.chunkId - b.chunkId);
  return { ranked, idf };
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

function cosine(a: Map<string, number>, magnitudeA: number, b: Map<string, number>): number {
  let dot = 0;
  for (const [token, weight] of a) {
    dot += weight * (b.get(token) ?? 0);
  }
  if (dot === 0) {
    return 0;
  }
  return dot / (magnitudeA * magnitude(b));
}

function magnitude(vector: Map<string, number>): number {
  let sum = 0;
  for (const weight of vector.values()) {
    sum += weight * weight;
  }
  return Math.sqrt(sum);
}

/** The most sentences quoted from a single chunk. */
const SENTENCES_PER_EXCERPT = 3;

/**
 * Picks the sentences of a chunk that best match the question, as they appear
 * in the document.
 *
 * A sentence scores the weight of every distinct question term it contains,
 * so the sentence naming the rare term asked about beats sentences that only
 * repeat a common one. Sentences scoring under half of the best are left out,
 * and the rest keep their document order so the excerpt still reads as the
 * document does.
 */
function selectSentences(question: string, chunkText: string, weight: TermWeight): string[] {
  const queryTerms = new Set(terms(question));
  const sentences = splitSentences(chunkText);
  const matching = sentences
    .map((sentence, index) => {
      const termsOfSentence = new Set(terms(sentence));
      const score = [...queryTerms]
        .filter((term) => termsOfSentence.has(term))
        .reduce((sum, term) => sum + weight(term), 0);
      return { sentence, index, score };
    })
    .filter(({ score }) => score > 0);
  const best = matching.reduce((top, { score }) => Math.max(top, score), 0);
  return matching.length > 0
    ? matching
        .filter(({ score }) => score >= best / 2)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, SENTENCES_PER_EXCERPT)
        .sort((a, b) => a.index - b.index)
        .map(({ sentence }) => sentence)
    : sentences.slice(0, SENTENCES_PER_EXCERPT);
}

/**
 * Quotes the sentences of a chunk that best match the question, with any
 * instruction-like content redacted so that a malicious document cannot take
 * over this answer or any agent that later reads it.
 */
export function extractRelevantSentences(
  question: string,
  chunkText: string,
  weight: TermWeight = () => 1,
): string {
  return redactPromptInjection(selectSentences(question, chunkText, weight).join(' '));
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
  const scoring = scoreChunks(safeQuestion, chunks);
  const ranked = scoring.ranked.filter((chunk) => chunk.score >= minimumScore);
  if (ranked.length === 0) {
    return { answer: NO_ANSWER, grounded: false, citations: [] };
  }
  // Neighbouring chunks of one document overlap, so the same passage can match
  // more than once; a chunk is only cited when it quotes a sentence of its
  // document that a better match has not already quoted.
  const quoted = new Map<number, Set<string>>();
  const top = ranked
    .slice(0, 3)
    .map((chunk) => ({ chunk, sentences: selectSentences(safeQuestion, chunk.text, scoring.idf) }))
    .filter(({ chunk, sentences }) => {
      const seen = quoted.get(chunk.documentId) ?? new Set<string>();
      quoted.set(chunk.documentId, seen);
      const fresh = sentences.filter((sentence) => !seen.has(sentence));
      fresh.forEach((sentence) => seen.add(sentence));
      return fresh.length > 0;
    });
  // The answer quotes every sentence once. Each passage is redacted as a whole,
  // so instruction-like text split across lines of a document is still caught.
  const answered = new Set<string>();
  const excerpts = top
    .map(({ sentences }) => {
      const fresh = sentences.filter((sentence) => !answered.has(sentence));
      fresh.forEach((sentence) => answered.add(sentence));
      return fresh;
    })
    .filter((fresh) => fresh.length > 0)
    .map((fresh) => redactPromptInjection(fresh.join(' ')));
  const answer = excerpts.join(' ');
  // A skill may only reshape sentences that are already grounded in the user's
  // documents, so applying one cannot add anything the documents do not say.
  const skill = selectSkill(safeQuestion);
  const shaped = skill?.apply(excerpts);
  return {
    answer: shaped ?? answer,
    ...(skill && shaped !== undefined ? { skill: { id: skill.id, name: skill.name } } : {}),
    grounded: true,
    citations: top.map(({ chunk, sentences }) => ({
      documentId: chunk.documentId,
      documentTitle: redactPromptInjection(chunk.documentTitle),
      category: chunk.category,
      position: chunk.position,
      excerpt: redactPromptInjection(sentences.join(' ')),
      score: Number(chunk.score.toFixed(4)),
    })),
  };
}
