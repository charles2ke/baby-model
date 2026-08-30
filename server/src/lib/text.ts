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
