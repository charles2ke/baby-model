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

/** Splits a document into sentences, preserving readable punctuation. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Groups sentences into overlapping chunks so that answers keep enough context
 * while remaining small enough to cite precisely.
 */
export function chunkText(text: string, maxChars = 600): string[] {
  const sentences = splitSentences(text);
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current.length > 0 && current.length + sentence.length + 1 > maxChars) {
      chunks.push(current);
      current = '';
    }
    current = current.length > 0 ? `${current} ${sentence}` : sentence;
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
