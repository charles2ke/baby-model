import { describe, expect, it } from 'vitest';
import {
  NO_ANSWER,
  answerQuestion,
  extractRelevantSentences,
  rankChunks,
  type IndexedChunk,
} from '../../server/src/lib/model.js';

const chunk = (id: number, text: string, title = 'doc', category = 'health'): IndexedChunk => ({
  chunkId: id,
  documentId: id,
  documentTitle: title,
  category,
  position: 0,
  text,
});

const corpus: IndexedChunk[] = [
  chunk(1, 'My HDL cholesterol was 62 mg/dL at the annual check-up in March.', 'Blood panel'),
  chunk(2, 'The mortgage rate on the apartment is 3.4 percent fixed.', 'Mortgage', 'finance'),
  chunk(3, 'I completed a masters degree in statistics in 2019.', 'Diploma', 'education'),
];

describe('model', () => {
  it('ranks the most relevant chunk first', () => {
    const ranked = rankChunks('what is my cholesterol', corpus);
    expect(ranked[0].documentTitle).toBe('Blood panel');
    expect(ranked[0].score).toBeGreaterThan(0);
  });

  it('returns nothing for empty questions or empty corpora', () => {
    expect(rankChunks('the a of', corpus)).toEqual([]);
    expect(rankChunks('cholesterol', [])).toEqual([]);
  });

  it('orders equally scored chunks deterministically', () => {
    const duplicates = [chunk(2, 'tuition fee statement'), chunk(1, 'tuition fee statement')];
    expect(rankChunks('tuition fee', duplicates).map((c) => c.chunkId)).toEqual([1, 2]);
  });

  it('answers with grounded excerpts and citations', () => {
    const result = answerQuestion('what is my mortgage rate', corpus);
    expect(result.grounded).toBe(true);
    expect(result.answer).toContain('3.4 percent');
    expect(result.citations[0].documentTitle).toBe('Mortgage');
    expect(result.citations[0].category).toBe('finance');
  });

  it('refuses to answer when the documents do not contain the information', () => {
    const result = answerQuestion('who won the world cup in 1998', corpus);
    expect(result).toEqual({ answer: NO_ANSWER, grounded: false, citations: [] });
  });

  it('refuses when the best match is below the confidence threshold', () => {
    const result = answerQuestion('cholesterol', corpus, 0.99);
    expect(result.grounded).toBe(false);
  });

  it('deduplicates repeated excerpts in the composed answer', () => {
    const repeated = [
      chunk(1, 'Vaccination record: tetanus booster given in 2021.'),
      chunk(2, 'Vaccination record: tetanus booster given in 2021.'),
    ];
    const result = answerQuestion('tetanus booster', repeated);
    expect(result.answer).toBe('Vaccination record: tetanus booster given in 2021.');
    expect(result.citations).toHaveLength(2);
  });

  it('falls back to the chunk start when no sentence matches', () => {
    expect(extractRelevantSentences('unrelated terms', 'First line. Second line.')).toBe(
      'First line. Second line.',
    );
  });
});
