import type { Category } from './store.js';

/**
 * Real-world integrations: the file formats people actually get out of the
 * systems that hold their data — patient portals and Apple Health (HL7 FHIR),
 * banks and card issuers (CSV statements), mail clients (RFC 5322 `.eml`) and
 * calendars (iCalendar `.ics`).
 *
 * Every connector runs locally, in this process: the export file is turned
 * into plain, readable text and then stored through the normal encrypted
 * document pipeline. Nothing is fetched from, or sent to, a third party, so
 * importing from a provider never means handing that provider a token or
 * handing this vault's contents to anybody else.
 */

/** A conversion failure that is the user's file's fault, not the server's. */
export class IntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationError';
  }
}

export interface ImportedDocument {
  title: string;
  content: string;
}

export interface Integration {
  id: string;
  label: string;
  description: string;
  defaultCategory: Category;
  /** File extensions the provider exports, used for the file picker filter. */
  fileExtensions: string[];
  convert(raw: string): ImportedDocument;
}

export type IntegrationSummary = Omit<Integration, 'convert'>;

function requireText(raw: string): string {
  const text = raw.trim();
  if (text.length === 0) {
    throw new IntegrationError('The exported file is empty');
  }
  return text;
}

/** Joins the lines a connector produced, dropping empties, into a document. */
function document(title: string, lines: string[]): ImportedDocument {
  const content = lines.filter((line) => line.trim().length > 0).join('\n');
  if (content.length === 0) {
    throw new IntegrationError('Nothing could be read from that export');
  }
  return { title, content };
}

/* ------------------------------------------------------------------ FHIR */

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** `CodeableConcept` renders as its text, or the first coding display/code. */
function concept(value: unknown): string {
  const node = asObject(value);
  if (!node) {
    return '';
  }
  const text = asString(node.text);
  if (text) {
    return text;
  }
  const coding = asObject(asArray(node.coding)[0]);
  return coding ? asString(coding.display) || asString(coding.code) : '';
}

/** Renders the value of an `Observation` in a human-readable form. */
function observationValue(resource: Json): string {
  const quantity = asObject(resource.valueQuantity);
  if (quantity && typeof quantity.value === 'number') {
    return `${quantity.value}${asString(quantity.unit) ? ` ${asString(quantity.unit)}` : ''}`;
  }
  const string = asString(resource.valueString);
  if (string) {
    return string;
  }
  return concept(resource.valueCodeableConcept);
}

function when(resource: Json, ...fields: string[]): string {
  for (const field of fields) {
    const value = asString(resource[field]);
    if (value) {
      return value;
    }
  }
  const period = asObject(resource.effectivePeriod);
  return period ? asString(period.start) : '';
}

/** Appends `on <date>` when the resource carries one. */
function dated(sentence: string, date: string): string {
  return date ? `${sentence} (recorded ${date})` : sentence;
}

function patientName(resource: Json): string {
  const name = asObject(asArray(resource.name)[0]);
  if (!name) {
    return '';
  }
  const given = asArray(name.given).map(asString).filter(Boolean).join(' ');
  return [given, asString(name.family)].filter(Boolean).join(' ') || asString(name.text);
}

const FHIR_RENDERERS: Record<string, (resource: Json) => string> = {
  Patient: (resource) =>
    [
      `Patient: ${patientName(resource) || 'unnamed'}`,
      asString(resource.birthDate) ? `born ${asString(resource.birthDate)}` : '',
      asString(resource.gender) ? `gender ${asString(resource.gender)}` : '',
    ]
      .filter(Boolean)
      .join(', '),
  Observation: (resource) => {
    const label = concept(resource.code) || 'Observation';
    const value = observationValue(resource);
    return dated(value ? `${label}: ${value}` : `${label}: recorded`, when(resource, 'effectiveDateTime', 'issued'));
  },
  Condition: (resource) =>
    dated(
      `Condition: ${concept(resource.code) || 'unspecified'}${
        concept(resource.clinicalStatus) ? `, status ${concept(resource.clinicalStatus)}` : ''
      }`,
      when(resource, 'onsetDateTime', 'recordedDate'),
    ),
  MedicationRequest: (resource) => {
    const dosage = asObject(asArray(resource.dosageInstruction)[0]);
    const instruction = dosage ? asString(dosage.text) : '';
    return dated(
      `Medication: ${concept(resource.medicationCodeableConcept) || 'unspecified'}${
        instruction ? `, ${instruction}` : ''
      }`,
      when(resource, 'authoredOn'),
    );
  },
  AllergyIntolerance: (resource) =>
    dated(
      `Allergy: ${concept(resource.code) || 'unspecified'}${
        asString(resource.criticality) ? `, criticality ${asString(resource.criticality)}` : ''
      }`,
      when(resource, 'recordedDate'),
    ),
  Immunization: (resource) =>
    dated(
      `Immunisation: ${concept(resource.vaccineCode) || 'unspecified'}`,
      when(resource, 'occurrenceDateTime'),
    ),
  Procedure: (resource) =>
    dated(`Procedure: ${concept(resource.code) || 'unspecified'}`, when(resource, 'performedDateTime')),
  DiagnosticReport: (resource) =>
    dated(
      `Report: ${concept(resource.code) || 'unspecified'}${
        asString(resource.conclusion) ? `. ${asString(resource.conclusion)}` : ''
      }`,
      when(resource, 'effectiveDateTime', 'issued'),
    ),
};

function renderFhirResource(resource: Json): string {
  const type = asString(resource.resourceType);
  const renderer = FHIR_RENDERERS[type];
  if (renderer) {
    return renderer(resource);
  }
  // Unknown resource types still carry facts worth keeping, so they are kept
  // in a minimal, readable form rather than dropped.
  return type ? `${type}: ${concept(resource.code) || asString(resource.id) || 'recorded'}` : '';
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(requireText(raw));
  } catch {
    throw new IntegrationError('That file is not valid JSON');
  }
}

/** Accepts a FHIR `Bundle`, an array of resources, or a single resource. */
function fhirResources(parsed: unknown): Json[] {
  const root = asObject(parsed);
  if (root && asString(root.resourceType) === 'Bundle') {
    return asArray(root.entry)
      .map((entry) => asObject(asObject(entry)?.resource))
      .filter((resource): resource is Json => resource !== undefined);
  }
  if (Array.isArray(parsed)) {
    return parsed.map(asObject).filter((resource): resource is Json => resource !== undefined);
  }
  if (root) {
    return [root];
  }
  throw new IntegrationError('That file does not contain FHIR resources');
}

const fhirIntegration: Integration = {
  id: 'fhir',
  label: 'Health records (HL7 FHIR)',
  description:
    'A FHIR R4 bundle exported from a patient portal, hospital record or Apple Health: observations, conditions, medications, allergies, immunisations and reports.',
  defaultCategory: 'health',
  fileExtensions: ['.json'],
  convert(raw) {
    const resources = fhirResources(parseJson(raw));
    const patient = resources.find((resource) => asString(resource.resourceType) === 'Patient');
    const name = patient ? patientName(patient) : '';
    return document(
      name ? `Health records for ${name}` : 'Health records (FHIR export)',
      resources.map(renderFhirResource),
    );
  },
};

/* ------------------------------------------------------------- Bank CSV */

/** Picks the delimiter a bank used: comma, semicolon or tab. */
export function detectDelimiter(header: string): string {
  const candidates = [',', ';', '\t'];
  return candidates.reduce((best, candidate) =>
    header.split(candidate).length > header.split(best).length ? candidate : best,
  );
}

/** Splits CSV text into logical records, keeping newlines inside quoted fields intact. */
export function splitCsvRecords(text: string): string[] {
  const records: string[] = [];
  let record = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      quoted = !quoted;
      record += character;
    } else if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && text[index + 1] === '\n') {
        index += 1;
      }
      records.push(record);
      record = '';
    } else {
      record += character;
    }
  }
  records.push(record);
  return records;
}

/** Splits one CSV line, honouring quoted fields and doubled quotes. */
export function parseCsvLine(line: string, delimiter = ','): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === delimiter) {
      fields.push(field.trim());
      field = '';
    } else {
      field += character;
    }
  }
  fields.push(field.trim());
  return fields;
}

const COLUMN_PATTERNS = {
  date: /^(date|booking date|value date|transaction date|posted|completed date|started date)$/i,
  description: /(description|details|narrative|payee|merchant|memo|reference|particulars|name)/i,
  amount: /^(amount|value|transaction amount|betrag)$/i,
  debit: /(debit|withdrawal|paid out|money out|charge)/i,
  credit: /(credit|deposit|paid in|money in)/i,
  currency: /currency/i,
  balance: /balance/i,
} as const;

type ColumnName = keyof typeof COLUMN_PATTERNS;

function findColumns(header: string[]): Partial<Record<ColumnName, number>> {
  const columns: Partial<Record<ColumnName, number>> = {};
  header.forEach((cell, index) => {
    for (const [name, pattern] of Object.entries(COLUMN_PATTERNS) as Array<[ColumnName, RegExp]>) {
      if (columns[name] === undefined && pattern.test(cell)) {
        columns[name] = index;
      }
    }
  });
  return columns;
}

/** Parses `1.234,56`, `1,234.56`, `(12.00)` and `-12.00` into a number. */
export function parseAmount(value: string): number | undefined {
  const text = value.replace(/\s|[A-Za-z$€£¥]/g, '');
  if (text.length === 0) {
    return undefined;
  }
  const negative = text.startsWith('(') && text.endsWith(')');
  let digits = negative ? text.slice(1, -1) : text;
  if (/,\d{1,2}$/.test(digits) && !/\.\d{1,2}$/.test(digits)) {
    digits = digits.replace(/\./g, '').replace(',', '.');
  } else {
    digits = digits.replace(/,/g, '');
  }
  const parsed = Number(digits);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return negative ? -parsed : parsed;
}

function cell(row: string[], index: number | undefined): string {
  return index === undefined ? '' : (row[index] ?? '').trim();
}

function rowAmount(row: string[], columns: Partial<Record<ColumnName, number>>): number | undefined {
  const amount = parseAmount(cell(row, columns.amount));
  if (amount !== undefined) {
    return amount;
  }
  const credit = parseAmount(cell(row, columns.credit));
  if (credit !== undefined) {
    return Math.abs(credit);
  }
  const debit = parseAmount(cell(row, columns.debit));
  return debit === undefined ? undefined : -Math.abs(debit);
}

function formatAmount(amount: number, currency: string, signed = true): string {
  const rendered = `${signed && amount > 0 ? '+' : ''}${amount.toFixed(2)}`;
  return currency ? `${rendered} ${currency}` : rendered;
}

const bankCsvIntegration: Integration = {
  id: 'bank-csv',
  label: 'Bank or card statement (CSV)',
  description:
    'A transaction export from a bank, credit card or payment account. Dates, descriptions, amounts, currencies and balances are recognised automatically.',
  defaultCategory: 'finance',
  fileExtensions: ['.csv'],
  convert(raw) {
    const lines = splitCsvRecords(requireText(raw))
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const delimiter = detectDelimiter(lines[0] as string);
    const columns = findColumns(parseCsvLine(lines[0] as string, delimiter));
    if (columns.date === undefined || (columns.amount === undefined && columns.debit === undefined && columns.credit === undefined)) {
      throw new IntegrationError('That CSV has no recognisable date and amount columns');
    }
    let paidIn = 0;
    let paidOut = 0;
    let currency = '';
    const statement: string[] = [];
    for (const line of lines.slice(1)) {
      const row = parseCsvLine(line, delimiter);
      const amount = rowAmount(row, columns);
      if (amount === undefined) {
        continue;
      }
      currency = cell(row, columns.currency) || currency;
      const date = cell(row, columns.date);
      const description = cell(row, columns.description) || 'Transaction';
      const balance = parseAmount(cell(row, columns.balance));
      if (amount >= 0) {
        paidIn += amount;
      } else {
        paidOut -= amount;
      }
      statement.push(
        `On ${date}, ${description}: ${formatAmount(amount, currency)}${
          balance === undefined ? '' : `, balance ${formatAmount(balance, currency, false)}`
        }.`,
      );
    }
    if (statement.length === 0) {
      throw new IntegrationError('That CSV has no transactions');
    }
    const suffix = currency ? ` ${currency}` : '';
    return document('Account statement (CSV import)', [
      `Statement with ${statement.length} transactions, ${paidIn.toFixed(2)}${suffix} paid in and ${paidOut.toFixed(2)}${suffix} paid out.`,
      ...statement,
    ]);
  },
};

/* ----------------------------------------------------------------- Email */

/** Joins continuation lines back onto the header they belong to. */
function unfold(lines: string[]): string[] {
  const unfolded: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += ` ${line.trim()}`;
    } else {
      unfolded.push(line);
    }
  }
  return unfolded;
}

/** Decodes bytes using the named charset, falling back to UTF-8 for labels Node does not recognise. */
function decodeBytes(bytes: Uint8Array | number[], charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
  } catch {
    return Buffer.from(bytes).toString('utf8');
  }
}

/** Decodes the RFC 2047 encoded words mail clients use for non-ASCII headers. */
export function decodeEncodedWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_match, rawCharset, encoding, payload) => {
    // Strip the optional RFC 2231 language tag (e.g. "utf-8*en") before naming the charset.
    const charset = String(rawCharset).split('*')[0].trim();
    return encoding.toLowerCase() === 'b'
      ? decodeBytes(Buffer.from(payload, 'base64'), charset)
      : decodeQuotedPrintable(String(payload).replace(/_/g, ' '), charset);
  });
}

/**
 * Decodes quoted-printable text into the given charset (default UTF-8). Only the `=XX` byte
 * escapes carry the charset's raw bytes; RFC 2047 restricts literal (non-escaped) characters in
 * an encoded word to plain ASCII, so they are encoded as UTF-8, which is byte-identical to every
 * other charset for that range.
 */
export function decodeQuotedPrintable(text: string, charset = 'utf-8'): string {
  const joined = text.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let index = 0; index < joined.length; index += 1) {
    const character = joined[index] as string;
    const hex = joined.slice(index + 1, index + 3);
    if (character === '=' && /^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else {
      bytes.push(...Buffer.from(character, 'utf8'));
    }
  }
  return decodeBytes(bytes, charset);
}

const HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
};

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    // Entities are resolved in a single pass so that an escaped entity such as
    // `&amp;lt;` becomes the literal text `&lt;` rather than being unescaped twice.
    .replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/gi, (_entity, name: string) => HTML_ENTITIES[name.toLowerCase()] as string)
    .replace(/[ \t]+/g, ' ');
}

interface MimePart {
  headers: Record<string, string>;
  body: string;
}

function splitPart(text: string): MimePart {
  const lines = text.split(/\r?\n/);
  const separator = lines.indexOf('');
  const headerLines = unfold(separator === -1 ? lines : lines.slice(0, separator));
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const index = line.indexOf(':');
    if (index > 0) {
      headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
    }
  }
  return { headers, body: separator === -1 ? '' : lines.slice(separator + 1).join('\n') };
}

function decodePart(part: MimePart): string {
  const encoding = (part.headers['content-transfer-encoding'] ?? '').toLowerCase();
  if (encoding === 'base64') {
    return Buffer.from(part.body.replace(/\s/g, ''), 'base64').toString('utf8');
  }
  if (encoding === 'quoted-printable') {
    return decodeQuotedPrintable(part.body);
  }
  return part.body;
}

/** Returns the readable text of a message, preferring `text/plain` parts. */
function messageText(part: MimePart): string {
  const contentType = part.headers['content-type'] ?? 'text/plain';
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (boundary) {
    const parts = part.body
      .split(new RegExp(`^--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*$`, 'm'))
      .slice(1, -1)
      .map((section) => splitPart(section.replace(/^\r?\n/, '')));
    const typeOf = (child: MimePart): string => (child.headers['content-type'] ?? '').toLowerCase();
    const plain = parts.find((child) => typeOf(child).includes('text/plain'));
    const html = parts.find((child) => typeOf(child).includes('text/html'));
    return messageText(plain ?? html ?? (parts[0] as MimePart));
  }
  const decoded = decodePart(part);
  return /text\/html/i.test(contentType) ? stripHtml(decoded) : decoded;
}

const emailIntegration: Integration = {
  id: 'email',
  label: 'Email message (.eml)',
  description:
    'A single message saved from Gmail, Outlook, Apple Mail or any IMAP client. Sender, recipients, subject, date and the text body are stored.',
  defaultCategory: 'professional',
  fileExtensions: ['.eml', '.txt'],
  convert(raw) {
    const message = splitPart(requireText(raw));
    if (message.headers.subject === undefined && message.headers.from === undefined) {
      throw new IntegrationError('That file is not an email message');
    }
    const header = (name: string): string => decodeEncodedWords(message.headers[name] ?? '');
    const subject = header('subject') || 'Email message';
    return document(`Email: ${subject}`.slice(0, 200), [
      `Subject: ${subject}`,
      header('from') ? `From: ${header('from')}` : '',
      header('to') ? `To: ${header('to')}` : '',
      header('cc') ? `Cc: ${header('cc')}` : '',
      header('date') ? `Date: ${header('date')}` : '',
      '',
      messageText(message).trim(),
    ]);
  },
};

/* ------------------------------------------------------------- iCalendar */

function unescapeIcal(value: string): string {
  return value
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/** `20240312T090000Z` and `20240312` become readable dates. */
export function formatIcalDate(value: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/.exec(value);
  if (!match) {
    return value;
  }
  const [, year, month, day, hour, minute] = match;
  return hour ? `${year}-${month}-${day} ${hour}:${minute}` : `${year}-${month}-${day}`;
}

const icalendarIntegration: Integration = {
  id: 'icalendar',
  label: 'Calendar export (.ics)',
  description:
    'An iCalendar file from Google Calendar, Outlook, Apple Calendar or a booking confirmation: appointments with their dates, locations and notes.',
  defaultCategory: 'professional',
  fileExtensions: ['.ics'],
  convert(raw) {
    const lines = unfold(requireText(raw).split(/\r?\n/));
    const events: string[] = [];
    let current: Record<string, string> | undefined;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^BEGIN:VEVENT$/i.test(trimmed)) {
        current = {};
        continue;
      }
      if (/^END:VEVENT$/i.test(trimmed)) {
        if (current) {
          const summary = current.summary ?? 'Appointment';
          const start = current.dtstart ? formatIcalDate(current.dtstart) : '';
          const end = current.dtend ? formatIcalDate(current.dtend) : '';
          events.push(
            [
              start ? `On ${start}` : 'Undated',
              end ? ` until ${end}` : '',
              `: ${summary}`,
              current.location ? `, at ${current.location}` : '',
              current.description ? `. ${current.description}` : '',
            ].join('') + '.',
          );
        }
        current = undefined;
        continue;
      }
      if (!current) {
        continue;
      }
      const index = trimmed.indexOf(':');
      if (index <= 0) {
        continue;
      }
      const name = (trimmed.slice(0, index).split(';')[0] as string).toLowerCase();
      current[name] = unescapeIcal(trimmed.slice(index + 1).trim());
    }
    if (events.length === 0) {
      throw new IntegrationError('That calendar contains no events');
    }
    return document('Calendar events (ICS import)', [
      `Calendar export with ${events.length} events.`,
      ...events,
    ]);
  },
};

export const INTEGRATIONS: Integration[] = [
  fhirIntegration,
  bankCsvIntegration,
  emailIntegration,
  icalendarIntegration,
];

export function listIntegrations(): IntegrationSummary[] {
  return INTEGRATIONS.map(({ convert: _convert, ...summary }) => summary);
}

/**
 * Runs a connector, turning any unexpected failure into a user-facing error so
 * that a malformed export can never surface an internal stack message.
 */
export function runIntegration(integration: Integration, raw: string): ImportedDocument {
  try {
    return integration.convert(raw);
  } catch (error) {
    if (error instanceof IntegrationError) {
      throw error;
    }
    throw new IntegrationError('That export could not be read');
  }
}

export function getIntegration(id: string): Integration | undefined {
  return INTEGRATIONS.find((integration) => integration.id === id);
}
