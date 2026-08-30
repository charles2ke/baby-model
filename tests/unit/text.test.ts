import { describe, expect, it } from 'vitest';
import { chunkText, isPlainText, splitSentences, tokenize } from '../../server/src/lib/text.js';

describe('text', () => {
  it('tokenises and removes stop words', () => {
    expect(tokenize('What is my HDL cholesterol level?')).toEqual(['hdl', 'cholesterol', 'level']);
  });

  it('keeps figures and identifiers intact', () => {
    expect(tokenize('Balance: $1,240.50 as of 2024-05-01')).toEqual([
      'balance',
      '$1',
      '240.50',
      '2024-05-01',
    ]);
  });

  it('splits sentences on punctuation and newlines', () => {
    expect(splitSentences('One. Two!\nThree?  ')).toEqual(['One.', 'Two!', 'Three?']);
  });

  it('chunks long text without losing content', () => {
    const sentence = 'Sentence number filler text here.';
    const chunks = chunkText(Array.from({ length: 40 }, () => sentence).join(' '), 120);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toContain(sentence);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(120 + sentence.length);
    }
  });

  it('returns no chunks for empty text', () => {
    expect(chunkText('   ')).toEqual([]);
  });

  it('detects plain text and rejects binary content', () => {
    expect(isPlainText(Buffer.from('hello world', 'utf8'))).toBe(true);
    expect(isPlainText(Buffer.from([]))).toBe(false);
    expect(isPlainText(Buffer.from([0x00, 0x01, 0x02]))).toBe(false);
    expect(isPlainText(Buffer.from([0xff, 0xfe, 0xfd]))).toBe(false);
  });
});
