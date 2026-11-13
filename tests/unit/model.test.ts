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
    expect(result.skill).toEqual({ id: 'figures', name: 'Pull out the figures' });
    expect(result.answer).toBe(
      '• 3.4 percent — The mortgage rate on the apartment is 3.4 percent fixed.',
    );
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

  it('applies the matching skill to the grounded excerpts', () => {
    const dated = [
      chunk(1, 'Tetanus booster given in 2021.'),
      chunk(2, 'Tetanus booster first given in 2011.'),
    ];
    const result = answerQuestion('what is the history of my tetanus booster', dated);
    expect(result.skill).toEqual({ id: 'timeline', name: 'Build a timeline' });
    expect(result.answer).toBe(
      '• Tetanus booster first given in 2011.\n• Tetanus booster given in 2021.',
    );
    expect(result.citations).toHaveLength(2);
  });

  it('applies the timeline skill for when questions', () => {
    const dated = [chunk(1, 'Tetanus booster given in 2021.')];
    const result = answerQuestion('When did my tetanus booster happen?', dated);
    expect(result.skill).toEqual({ id: 'timeline', name: 'Build a timeline' });
    expect(result.answer).toBe('• Tetanus booster given in 2021.');
  });

  it('keeps the plain answer when the matched skill has nothing to add', () => {
    const result = answerQuestion('what is the history of my mortgage rate', corpus);
    expect(result.skill).toBeUndefined();
    expect(result.answer).toContain('3.4 percent');
  });

  it('falls back to the chunk start when no sentence matches', () => {
    expect(extractRelevantSentences('unrelated terms', 'First line. Second line.')).toBe(
      'First line. Second line.',
    );
  });

  it('matches questions to documents that use other forms of the words', () => {
    const records = [
      chunk(1, 'Payment of $120.50 to City Power on March 3.', 'Bank statement', 'finance'),
      chunk(2, 'Tetanus vaccination first given in 2011.', 'Health record'),
    ];
    expect(answerQuestion('What were my payments?', records).answer).toBe(
      'Payment of $120.50 to City Power on March 3.',
    );
    expect(answerQuestion('When was I vaccinated?', records).answer).toBe(
      '• Tetanus vaccination first given in 2011.',
    );
  });

  it('quotes the sentence that answers the question before others sharing a word', () => {
    const panel =
      'Cholesterol is measured every year. Cholesterol results go to the clinic. ' +
      'Cholesterol targets were discussed. LDL cholesterol was 98 mg/dL.';
    expect(extractRelevantSentences('What is my LDL cholesterol?', panel)).toBe(
      'Cholesterol is measured every year. Cholesterol results go to the clinic. LDL cholesterol was 98 mg/dL.',
    );
  });

  it('leaves out sentences that match far less than the best one', () => {
    const weight = (term: string) => (term === 'ldl' ? 3 : 1);
    expect(
      extractRelevantSentences(
        'LDL cholesterol',
        'Cholesterol is measured every year. LDL cholesterol was 98 mg/dL.',
        weight,
      ),
    ).toBe('LDL cholesterol was 98 mg/dL.');
  });

  it('weighs question terms by how rare they are across the documents', () => {
    const panels = [
      chunk(1, 'Cholesterol is measured every year. LDL cholesterol was 98 mg/dL.', 'Blood panel'),
      chunk(2, 'Cholesterol medication was reviewed.', 'Clinic letter'),
    ];
    const result = answerQuestion('What is my LDL cholesterol?', panels);
    expect(result.citations[0].excerpt).toBe('LDL cholesterol was 98 mg/dL.');
  });

  it('cites overlapping chunks of a document only for sentences not quoted yet', () => {
    const statement = [
      { ...chunk(1, 'Opening balance was $1,200.00. Payment of $120.50 to City Power on March 3.'), documentId: 7 },
      {
        ...chunk(2, 'Payment of $120.50 to City Power on March 3. Payment of $45.00 to Water Co on March 9.'),
        documentId: 7,
        position: 1,
      },
    ];
    const result = answerQuestion('What were my payments?', statement);
    expect(result.answer).toBe(
      'Payment of $120.50 to City Power on March 3. Payment of $45.00 to Water Co on March 9.',
    );
    expect(result.citations.map((citation) => citation.position)).toEqual([1]);
  });

  it('quotes each line of a note once when overlapping chunks match it', () => {
    const card = [
      { ...chunk(1, 'Allergies: penicillin\nBlood type: O positive'), documentId: 9 },
      { ...chunk(2, 'Blood type: O positive\nGP: Dr Byrne at Main Street clinic'), documentId: 9, position: 1 },
      { ...chunk(3, 'GP: Dr Byrne at Main Street clinic\nInsurance number HX-4471'), documentId: 9, position: 2 },
    ];
    const result = answerQuestion('What is my blood type and GP?', card);
    expect(result.answer).toBe('Blood type: O positive GP: Dr Byrne at Main Street clinic');
    expect(result.citations.map((citation) => citation.position)).toEqual([1]);
  });
});
