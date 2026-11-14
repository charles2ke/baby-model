const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'am', 'of', 'to', 'in', 'on', 'for',
  'and', 'or', 'my', 'me', 'i', 'you', 'your', 'it', 'its', 'this', 'that', 'these', 'those',
  'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'do', 'does', 'did', 'with', 'about',
  'from', 'at', 'as', 'by', 'can', 'could', 'should', 'would', 'tell', 'show', 'please',
]);

/** Splits text into normalised, stop-word free tokens. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^a-z0-9%$.@+-]+/)
    .map((token) => token.replace(/^[.+-]+|[.+-]+$/g, ''))
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

/* ------------------------------------------------------- Porter stemmer */

/** A consonant is any letter but a vowel, and `y` only when it follows a vowel or starts the word. */
function isConsonantAt(word: string, index: number, previousConsonant: boolean): boolean {
  const letter = word[index] as string;
  return letter === 'y' ? index === 0 || !previousConsonant : !'aeiou'.includes(letter);
}

function isConsonant(word: string, index: number): boolean {
  let previousConsonant = false;
  for (let cursor = 0; cursor <= index; cursor += 1) {
    const consonant = isConsonantAt(word, cursor, previousConsonant);
    if (cursor === index) {
      return consonant;
    }
    previousConsonant = consonant;
  }
  return false;
}

/** Porter's measure `m`: the number of vowel-consonant sequences in a stem. */
function measure(stem: string): number {
  let count = 0;
  let previousConsonant = stem.length > 0 && isConsonantAt(stem, 0, false);
  for (let index = 1; index < stem.length; index += 1) {
    const consonant = isConsonantAt(stem, index, previousConsonant);
    if (consonant && !previousConsonant) {
      count += 1;
    }
    previousConsonant = consonant;
  }
  return count;
}

function hasVowel(stem: string): boolean {
  let previousConsonant = false;
  for (let index = 0; index < stem.length; index += 1) {
    const consonant = isConsonantAt(stem, index, previousConsonant);
    if (!consonant) {
      return true;
    }
    previousConsonant = consonant;
  }
  return false;
}

function endsWithDoubleConsonant(stem: string): boolean {
  const last = stem.length - 1;
  return last > 0 && stem[last] === stem[last - 1] && isConsonant(stem, last);
}

/** Consonant-vowel-consonant ending whose last letter is not `w`, `x` or `y`, as in `hop`. */
function endsWithCvc(stem: string): boolean {
  const last = stem.length - 1;
  return (
    last >= 2 &&
    isConsonant(stem, last - 2) &&
    !isConsonant(stem, last - 1) &&
    isConsonant(stem, last) &&
    !'wxy'.includes(stem[last] as string)
  );
}

type SuffixRules = ReadonlyArray<readonly [suffix: string, replacement: string]>;

/** Rules are tried longest suffix first, and only the longest matching one is ever considered. */
function longestFirst(rules: SuffixRules): SuffixRules {
  return [...rules].sort((a, b) => b[0].length - a[0].length);
}

const STEP_1A = longestFirst([['sses', 'ss'], ['ies', 'i'], ['ss', 'ss'], ['s', '']]);

const STEP_2 = longestFirst([
  ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'], ['izer', 'ize'],
  ['abli', 'able'], ['alli', 'al'], ['entli', 'ent'], ['eli', 'e'], ['ousli', 'ous'],
  ['ization', 'ize'], ['ation', 'ate'], ['ator', 'ate'], ['alism', 'al'], ['iveness', 'ive'],
  ['fulness', 'ful'], ['ousness', 'ous'], ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble'],
]);

const STEP_3 = longestFirst([
  ['icate', 'ic'], ['ative', ''], ['alize', 'al'], ['iciti', 'ic'], ['ical', 'ic'], ['ful', ''],
  ['ness', ''],
]);

const STEP_4 = longestFirst(
  ['al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement', 'ment', 'ent', 'ion', 'ou',
    'ism', 'ate', 'iti', 'ous', 'ive', 'ize'].map((suffix) => [suffix, ''] as const),
);

function replaceSuffix(
  word: string,
  rules: SuffixRules,
  condition: (stem: string, suffix: string) => boolean,
): string {
  const rule = rules.find(([suffix]) => word.endsWith(suffix));
  if (!rule) {
    return word;
  }
  const stem = word.slice(0, word.length - rule[0].length);
  return condition(stem, rule[0]) ? stem + rule[1] : word;
}

/** Step 1b: `-eed`, `-ed` and `-ing`, then tidies the stem they leave behind. */
function stripVerbEnding(word: string): string {
  if (word.endsWith('eed')) {
    return measure(word.slice(0, -3)) > 0 ? word.slice(0, -1) : word;
  }
  const suffix = ['ed', 'ing'].find((ending) => word.endsWith(ending));
  const stem = suffix ? word.slice(0, word.length - suffix.length) : '';
  if (!hasVowel(stem)) {
    return word;
  }
  if (/(?:at|bl|iz)$/.test(stem) || (measure(stem) === 1 && endsWithCvc(stem))) {
    return `${stem}e`;
  }
  return endsWithDoubleConsonant(stem) && !/[lsz]$/.test(stem) ? stem.slice(0, -1) : stem;
}

/** Step 5: drops a final `-e` and reduces a final `-ll` on long enough stems. */
function tidyEnding(word: string): string {
  let result = word;
  if (result.endsWith('e')) {
    const stem = result.slice(0, -1);
    const size = measure(stem);
    if (size > 1 || (size === 1 && !endsWithCvc(stem))) {
      result = stem;
    }
  }
  return result.endsWith('ll') && measure(result) > 1 ? result.slice(0, -1) : result;
}

/**
 * Reduces an English word to its stem with the published Porter (1980)
 * algorithm, so that `payments` finds `payment` and `vaccinated` finds
 * `vaccination`. Only plain lowercase words are stemmed; figures, dates,
 * amounts and identifiers are returned unchanged.
 */
export function stem(word: string): string {
  if (!/^[a-z]+$/.test(word)) {
    return word;
  }
  let result = stripVerbEnding(replaceSuffix(word, STEP_1A, () => true));
  if (result.endsWith('y') && hasVowel(result.slice(0, -1))) {
    result = `${result.slice(0, -1)}i`;
  }
  result = replaceSuffix(result, STEP_2, (base) => measure(base) > 0);
  result = replaceSuffix(result, STEP_3, (base) => measure(base) > 0);
  result = replaceSuffix(
    result,
    STEP_4,
    (base, suffix) => measure(base) > 1 && (suffix !== 'ion' || /[st]$/.test(base)),
  );
  return tidyEnding(result);
}

/**
 * The terms retrieval matches on: tokens reduced to their stems, so that a
 * question and a document using different forms of a word still meet. Pass
 * the same `stems` map to calls that share a vocabulary to stem each distinct
 * word once; it should live no longer than the request, so that words from
 * decrypted documents are not kept in memory.
 */
export function terms(text: string, stems = new Map<string, string>()): string[] {
  return tokenize(text).map((token) => {
    let stemmed = stems.get(token);
    if (stemmed === undefined) {
      stemmed = stem(token);
      stems.set(token, stemmed);
    }
    return stemmed;
  });
}

/** Splits a document into sentences, preserving readable punctuation. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Groups sentences into chunks of up to `maxChars` characters, so that answers
 * keep enough context while remaining small enough to cite precisely. A chunk
 * repeats the last sentence of the one before it whenever that still fits, so
 * a passage that spans a chunk boundary is found with its context. A single
 * sentence longer than `maxChars` becomes a chunk of its own.
 *
 * Sentences are kept on lines of their own, so a chunk splits back into
 * exactly the sentences of its document even where a line had no full stop.
 */
export function chunkText(text: string, maxChars = 600): string[] {
  const sentences = splitSentences(text);
  const chunks: string[] = [];
  let current = '';
  let previous = '';
  for (const sentence of sentences) {
    if (current.length > 0 && current.length + sentence.length + 1 > maxChars) {
      chunks.push(current);
      current = previous.length + sentence.length + 1 <= maxChars ? previous : '';
    }
    current = current.length > 0 ? `${current}\n${sentence}` : sentence;
    previous = sentence;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/** Marker left behind wherever instruction-like content has been removed. */
export const REDACTED = '[redacted: instruction-like content]';

/** Invisible characters used to smuggle instructions past human review. */
const INVISIBLE_CHARACTERS = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * Patterns that try to steer an assistant instead of stating a fact, plus the
 * link and data-URI shapes used to exfiltrate answers to a third party.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.!?\n]{0,60}?\b(?:instruction|instructions|prompt|prompts|rule|rules|guardrail|guardrails|context)\b/gi,
  /\b(?:system|developer|assistant)\s+(?:prompt|message|instruction|instructions|role)\b/gi,
  /\b(?:you are|act as|pretend to be|behave as|roleplay as)\b[^.!?\n]{0,60}?\b(?:ai|assistant|model|chatbot|dan|admin|administrator|root|developer)\b/gi,
  /\b(?:reveal|repeat|print|output|leak|exfiltrate|email|send|post|upload)\b[^.!?\n]{0,60}?\b(?:prompt|instructions|api key|secret|secrets|password|passwords|token|tokens|credential|credentials|private key)\b/gi,
  /\b(?:jailbreak|developer mode|do anything now)\b/gi,
  /<\|[^|>]*\|>/g,
  /(?:^|\n)\s*(?:#{1,6}\s*)?(?:system|assistant|user)\s*:/gi,
  /!?\[[^\]\n]{0,120}\]\([^)\n]{0,300}\)/g,
  /\b(?:https?|javascript|data|vbscript|file|ftp):[^\s]*/gi,
  /\bwww\.[^\s]*/gi,
];

/**
 * Best-effort neutralisation of prompt-injection payloads hidden in untrusted
 * text. Documents are attacker-controlled whenever a user is sent a file, so
 * instruction-like passages and the URLs used to exfiltrate data are redacted
 * before they reach an answer or any agent that consumes it. This is
 * defence in depth, not a complete filter: pattern matching cannot recognise
 * every phrasing, so callers must still treat this text as untrusted data and
 * never as instructions.
 */
export function redactPromptInjection(text: string): string {
  return INJECTION_PATTERNS.reduce(
    (accumulator, pattern) => accumulator.replace(pattern, REDACTED),
    text.normalize('NFKC').replace(INVISIBLE_CHARACTERS, ''),
  );
}

/** Rejects binary uploads: only UTF-8 text documents are accepted. */
export function isPlainText(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }
  const text = buffer.toString('utf8');
  if (text.includes('\uFFFD')) {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u0008\u000E-\u001F]/.test(text);
}
