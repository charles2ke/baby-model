import { describe, expect, it } from 'vitest';
import { SKILLS, listSkills, selectSkill } from '../../server/src/lib/skills.js';

const skill = (id: string) => {
  const found = SKILLS.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`unknown skill ${id}`);
  }
  return found;
};

describe('skills', () => {
  it('lists skills without their implementation', () => {
    const listed = listSkills();
    expect(listed.map((entry) => entry.id)).toEqual(['summarise', 'timeline', 'figures']);
    for (const entry of listed) {
      expect(entry.description).toMatch(/^Use when/);
      expect(entry).not.toHaveProperty('apply');
      expect(entry).not.toHaveProperty('triggers');
    }
  });

  it('routes a question to the skill it uses the most triggers of', () => {
    expect(selectSkill('give me a summary of my records')?.id).toBe('summarise');
    expect(selectSkill('what is the history of my events')?.id).toBe('timeline');
    expect(selectSkill('when did my tetanus booster happen')?.id).toBe('timeline');
    expect(selectSkill('how much was the total amount')?.id).toBe('figures');
  });

  it('selects no skill when the question triggers none', () => {
    expect(selectSkill('what is my cholesterol')).toBeUndefined();
  });

  it('breaks ties by declaration order', () => {
    const first = { ...skill('summarise'), id: 'first' };
    const second = { ...skill('summarise'), id: 'second' };
    expect(selectSkill('summary', [first, second])?.id).toBe('first');
  });

  it('turns several excerpts into bullet points', () => {
    expect(skill('summarise').apply(['One thing happened. Another did.'])).toBe(
      '• One thing happened.\n• Another did.',
    );
  });

  it('declines to summarise a single sentence', () => {
    expect(skill('summarise').apply(['Only one sentence.'])).toBeUndefined();
  });

  it('orders dated sentences oldest first', () => {
    const excerpts = [
      'Event in 2022.',
      'Event on 12/06/2021.',
      'Event on 12/05/21.',
      'Event on March 5 2021.',
      'Event in March 2021.',
      'Event in January 2021.',
      'Booster given on 2015-04-02.',
      'Event on 12/05/99.',
      'Graduated in 2019.',
    ];
    expect(skill('timeline').apply(excerpts)).toBe(
      '• Event on 12/05/99.\n'
      + '• Booster given on 2015-04-02.\n'
      + '• Graduated in 2019.\n'
      + '• Event in January 2021.\n'
      + '• Event in March 2021.\n'
      + '• Event on March 5 2021.\n'
      + '• Event on 12/05/21.\n'
      + '• Event on 12/06/2021.\n'
      + '• Event in 2022.',
    );
  });

  it('keeps the original order for equally dated sentences', () => {
    expect(skill('timeline').apply(['Second in 2020.', 'First in 2020.'])).toBe(
      '• Second in 2020.\n• First in 2020.',
    );
  });

  it('puts sentences without a year last', () => {
    expect(skill('timeline').apply(['Seen in March.', 'Seen in 2019.'])).toBe(
      '• Seen in 2019.\n• Seen in March.',
    );
  });

  it('declines to build a timeline without dates', () => {
    expect(skill('timeline').apply(['No date at all here.'])).toBeUndefined();
  });

  it('pulls the figures out of the sentences that carry them', () => {
    expect(skill('figures').apply(['Rent was $1,240.50 in May. Rate was 3.4 percent.'])).toBe(
      '• $1,240.50 — Rent was $1,240.50 in May.\n• 3.4 percent — Rate was 3.4 percent.',
    );
  });

  it('declines to pull figures when there are none', () => {
    expect(skill('figures').apply(['No numbers in this sentence.'])).toBeUndefined();
  });
});
