import { splitSentences, tokenize } from './text.js';

/**
 * Skills, in the shape Claude's Agent Skills use: a name, a description that
 * says when the skill applies, and the procedure itself. Here the procedure is
 * deterministic code that runs in this process — a skill may only reorganise
 * sentences that were already extracted from the user's own documents, so a
 * skill can never introduce outside knowledge or break the grounding promise.
 */
export interface Skill {
  id: string;
  name: string;
  /** When to use the skill, phrased the way a `SKILL.md` description is. */
  description: string;
  /** Question words that trigger the skill. */
  triggers: string[];
  /**
   * Rewrites the grounded excerpts. Returning `undefined` means the skill had
   * nothing to contribute, and the plain extractive answer is kept.
   */
  apply(excerpts: string[]): string | undefined;
}

export type SkillSummary = Omit<Skill, 'triggers' | 'apply'>;

/** A month name or a numeric date, used to order a timeline. */
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december',
];

const DATE_PATTERN = new RegExp(
  `\\b(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{2,4}|(?:${MONTHS.join('|')})\\b(?:[^.!?]{0,12}?\\b\\d{4})?|\\d{4})\\b`,
  'i',
);

/** Amounts as they appear in statements: `$1,240.50`, `1240.50 USD`, `12%`, `12 percent`. */
const AMOUNT_PATTERN = /[$£€]\s?-?\d[\d,]*(?:\.\d+)?|-?\d[\d,]*(?:\.\d+)?\s?(?:usd|eur|gbp|%|percent)/gi;

function sentencesOf(excerpts: string[]): string[] {
  return excerpts.flatMap((excerpt) => splitSentences(excerpt));
}

function dateValue(year: number, month = 0, day = 0): number {
  if (!Number.isFinite(year)) {
    return Number.POSITIVE_INFINITY;
  }
  return year * 10000 + month * 100 + day;
}

function normaliseYear(year: number): number {
  if (year < 100) {
    return year >= 70 ? 1900 + year : 2000 + year;
  }
  return year;
}

/** Sorts by the matched date; numeric dates are interpreted as month/day/year. */
function dateSortValue(date: string): number {
  const value = date.toLowerCase();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) {
    return dateValue(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }
  const numeric = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(value);
  if (numeric) {
    return dateValue(normaliseYear(Number(numeric[3])), Number(numeric[1]), Number(numeric[2]));
  }
  const monthIndex = MONTHS.findIndex((month) => value.startsWith(month));
  if (monthIndex >= 0) {
    const numbers = value.match(/\d{1,4}/g)?.map(Number) ?? [];
    const year = numbers.find((number) => number > 31 || String(number).length === 4);
    const day = numbers.find((number) => number !== year && number >= 1 && number <= 31) ?? 0;
    return dateValue(year ?? Number.POSITIVE_INFINITY, monthIndex + 1, day);
  }
  return dateValue(Number(value));
}

export const SKILLS: Skill[] = [
  {
    id: 'summarise',
    name: 'Summarise documents',
    description:
      'Use when the question asks for a summary, an overview or the key points of the stored documents, to list the matching sentences as bullet points.',
    triggers: ['summary', 'summarise', 'summarize', 'overview', 'recap', 'key', 'points', 'brief'],
    apply(excerpts) {
      const sentences = sentencesOf(excerpts);
      if (sentences.length < 2) {
        return undefined;
      }
      return sentences.map((sentence) => `• ${sentence}`).join('\n');
    },
  },
  {
    id: 'timeline',
    name: 'Build a timeline',
    description:
      'Use when the question asks when something happened, or for a history, a timeline or the order of events, to list the dated sentences oldest first.',
    triggers: ['when', 'timeline', 'history', 'chronology', 'chronological', 'order', 'events', 'since'],
    apply(excerpts) {
      const dated = sentencesOf(excerpts)
        .map((sentence) => ({ sentence, date: DATE_PATTERN.exec(sentence)?.[0] }))
        .filter((entry): entry is { sentence: string; date: string } => entry.date !== undefined);
      if (dated.length === 0) {
        return undefined;
      }
      return dated
        .map((entry, index) => ({ ...entry, index }))
        .sort((a, b) => dateSortValue(a.date) - dateSortValue(b.date) || a.index - b.index)
        .map(({ sentence }) => `• ${sentence}`)
        .join('\n');
    },
  },
  {
    id: 'figures',
    name: 'Pull out the figures',
    description:
      'Use when the question asks for amounts, balances, rates or other numbers, to list the sentences that carry a figure together with the figures themselves.',
    triggers: ['amount', 'amounts', 'balance', 'balances', 'total', 'totals', 'cost', 'price',
      'rate', 'rates', 'figure', 'figures', 'much', 'many', 'number', 'numbers'],
    apply(excerpts) {
      const lines = sentencesOf(excerpts)
        .map((sentence) => ({ sentence, figures: sentence.match(AMOUNT_PATTERN) ?? [] }))
        .filter(({ figures }) => figures.length > 0)
        .map(({ sentence, figures }) => `• ${figures.join(', ')} — ${sentence}`);
      return lines.length > 0 ? lines.join('\n') : undefined;
    },
  },
];

/** The skills a client may see, without their implementation. */
export function listSkills(): SkillSummary[] {
  return SKILLS.map(({ id, name, description }) => ({ id, name, description }));
}

/**
 * Picks the single skill whose triggers the question uses most. Ties are
 * broken by declaration order so that the same question always routes to the
 * same skill.
 */
export function selectSkill(question: string, skills: Skill[] = SKILLS): Skill | undefined {
  const asked = new Set(tokenize(question));
  if (/\bwhen\b/i.test(question.normalize('NFKC'))) {
    asked.add('when');
  }
  let best: { skill: Skill; matches: number } | undefined;
  for (const skill of skills) {
    const matches = skill.triggers.filter((trigger) => asked.has(trigger)).length;
    if (matches > 0 && (best === undefined || matches > best.matches)) {
      best = { skill, matches };
    }
  }
  return best?.skill;
}
