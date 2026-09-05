import type { Db, Statement } from './db.js';
import {
  decrypt,
  encrypt,
  generateDataKey,
  hashPassword,
  hashToken,
  randomToken,
  unwrapDataKey,
  verifyPassword,
} from './crypto.js';
import { chunkText } from './text.js';
import type { IndexedChunk } from './model.js';

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  wrapped_key: string;
  created_at: string;
}

export interface SessionInfo {
  token: string;
  csrfToken: string;
  userId: number;
  expiresAt: number;
}

export interface DocumentSummary {
  id: number;
  title: string;
  category: string;
  byteSize: number;
  createdAt: string;
}

export const CATEGORIES = ['health', 'finance', 'professional', 'education', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * Hash of a value nobody can authenticate against. Verifying against it makes
 * failed logins for unknown accounts as expensive as for existing ones.
 */
const DUMMY_PASSWORD_HASH = hashPassword(randomToken());

/** Normalises an email address for storage and lookup. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Every statement the store runs, compiled once when the store is created. */
const SQL = {
  insertAudit: 'INSERT INTO audit_log (user_id, action, detail, created_at) VALUES (?, ?, ?, ?)',
  insertUser: 'INSERT INTO users (email, password_hash, wrapped_key, created_at) VALUES (?, ?, ?, ?)',
  selectUserByEmail: 'SELECT * FROM users WHERE email = ?',
  selectUserById: 'SELECT * FROM users WHERE id = ?',
  insertSession:
    'INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
  selectSession: 'SELECT * FROM sessions WHERE token_hash = ?',
  deleteSession: 'DELETE FROM sessions WHERE token_hash = ?',
  deleteSessionsForUser: 'DELETE FROM sessions WHERE user_id = ?',
  insertDocument:
    'INSERT INTO documents (user_id, title, category, byte_size, content_encrypted, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  insertChunk: 'INSERT INTO chunks (document_id, user_id, position, text_encrypted) VALUES (?, ?, ?, ?)',
  listDocuments:
    'SELECT id, title, category, byte_size, created_at FROM documents WHERE user_id = ? ORDER BY id DESC',
  selectDocumentContent: 'SELECT title, content_encrypted FROM documents WHERE id = ? AND user_id = ?',
  deleteDocument: 'DELETE FROM documents WHERE id = ? AND user_id = ?',
  deleteChunksForDocument: 'DELETE FROM chunks WHERE document_id = ? AND user_id = ?',
  chunksForUser: `SELECT c.id AS chunk_id, c.document_id, c.position, c.text_encrypted, d.title, d.category
     FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE c.user_id = ? ORDER BY c.id`,
  deleteChunksForUser: 'DELETE FROM chunks WHERE user_id = ?',
  deleteDocumentsForUser: 'DELETE FROM documents WHERE user_id = ?',
  deleteUser: 'DELETE FROM users WHERE id = ?',
  anonymiseAudit: 'UPDATE audit_log SET user_id = NULL WHERE user_id = ?',
  exportDocuments:
    'SELECT id, title, category, byte_size, content_encrypted, created_at FROM documents WHERE user_id = ? ORDER BY id',
} as const;

type StatementName = keyof typeof SQL;

export class Store {
  /**
   * SQL is compiled once per store instead of on every request: preparing a
   * statement is the dominant cost of these small queries.
   */
  private readonly statements: Record<StatementName, Statement>;

  constructor(
    private readonly db: Db,
    private readonly masterKey: Buffer,
  ) {
    this.statements = Object.fromEntries(
      Object.entries(SQL).map(([name, sql]) => [name, db.prepare(sql)]),
    ) as Record<StatementName, Statement>;
  }

  private statement(name: StatementName): Statement {
    return this.statements[name];
  }

  audit(userId: number | null, action: string, detail = ''): void {
    this.statement('insertAudit').run(userId, action, detail, new Date().toISOString());
  }

  createUser(email: string, password: string): UserRow {
    const dataKey = generateDataKey();
    const info = this.statement('insertUser')
      .run(
        normaliseEmail(email),
        hashPassword(password),
        encrypt(this.masterKey, dataKey.toString('base64')),
        new Date().toISOString(),
      );
    this.audit(Number(info.lastInsertRowid), 'user.register');
    return this.getUserById(Number(info.lastInsertRowid)) as UserRow;
  }

  getUserByEmail(email: string): UserRow | undefined {
    return this.statement('selectUserByEmail').get(normaliseEmail(email)) as UserRow | undefined;
  }

  getUserById(id: number): UserRow | undefined {
    return this.statement('selectUserById').get(id) as UserRow | undefined;
  }

  /** Verifies credentials without revealing whether the email exists. */
  authenticate(email: string, password: string): UserRow | undefined {
    const user = this.getUserByEmail(email);
    if (!user) {
      // Spend comparable time so that account enumeration is not possible.
      verifyPassword(password, DUMMY_PASSWORD_HASH);
      return undefined;
    }
    return verifyPassword(password, user.password_hash) ? user : undefined;
  }

  dataKeyFor(user: UserRow): Buffer {
    return unwrapDataKey(this.masterKey, user.wrapped_key);
  }

  createSession(userId: number, ttlMs: number): SessionInfo {
    const token = randomToken();
    const csrfToken = randomToken(24);
    const expiresAt = Date.now() + ttlMs;
    this.statement('insertSession')
      .run(hashToken(token), userId, csrfToken, expiresAt, new Date().toISOString());
    return { token, csrfToken, userId, expiresAt };
  }

  getSession(token: string): SessionInfo | undefined {
    const row = this.statement('selectSession').get(hashToken(token)) as
      | { token_hash: string; user_id: number; csrf_token: string; expires_at: number }
      | undefined;
    if (!row) {
      return undefined;
    }
    if (row.expires_at <= Date.now()) {
      this.deleteSession(token);
      return undefined;
    }
    return {
      token,
      csrfToken: row.csrf_token,
      userId: row.user_id,
      expiresAt: row.expires_at,
    };
  }

  deleteSession(token: string): void {
    this.statement('deleteSession').run(hashToken(token));
  }

  deleteSessionsForUser(userId: number): void {
    this.statement('deleteSessionsForUser').run(userId);
  }

  addDocument(
    user: UserRow,
    title: string,
    category: Category,
    content: string,
  ): DocumentSummary {
    const dataKey = this.dataKeyFor(user);
    const createdAt = new Date().toISOString();
    const byteSize = Buffer.byteLength(content, 'utf8');
    const insertDocument = this.statement('insertDocument');
    const insertChunk = this.statement('insertChunk');
    const documentId = this.db.transaction(() => {
      const info = insertDocument.run(
        user.id,
        title,
        category,
        byteSize,
        encrypt(dataKey, content),
        createdAt,
      );
      const id = Number(info.lastInsertRowid);
      chunkText(content).forEach((chunk, index) => {
        insertChunk.run(id, user.id, index, encrypt(dataKey, chunk));
      });
      return id;
    })();
    this.audit(user.id, 'document.create', `document=${documentId}`);
    return { id: documentId, title, category, byteSize, createdAt };
  }

  listDocuments(userId: number): DocumentSummary[] {
    const rows = this.statement('listDocuments').all(userId) as Array<{
      id: number;
      title: string;
      category: string;
      byte_size: number;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      category: row.category,
      byteSize: row.byte_size,
      createdAt: row.created_at,
    }));
  }

  /** Returns a document only when it belongs to the requesting user. */
  getDocumentContent(user: UserRow, documentId: number): { title: string; content: string } | undefined {
    const row = this.statement('selectDocumentContent').get(documentId, user.id) as { title: string; content_encrypted: string } | undefined;
    if (!row) {
      return undefined;
    }
    return { title: row.title, content: decrypt(this.dataKeyFor(user), row.content_encrypted) };
  }

  deleteDocument(user: UserRow, documentId: number): boolean {
    const result = this.statement('deleteDocument').run(documentId, user.id);
    if (result.changes === 0) {
      return false;
    }
    this.statement('deleteChunksForDocument').run(documentId, user.id);
    this.audit(user.id, 'document.delete', `document=${documentId}`);
    return true;
  }

  /** Loads and decrypts every chunk owned by the given user. */
  chunksForUser(user: UserRow): IndexedChunk[] {
    const dataKey = this.dataKeyFor(user);
    const rows = this.statement('chunksForUser').all(user.id) as Array<{
      chunk_id: number;
      document_id: number;
      position: number;
      text_encrypted: string;
      title: string;
      category: string;
    }>;
    return rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      documentTitle: row.title,
      category: row.category,
      position: row.position,
      text: decrypt(dataKey, row.text_encrypted),
    }));
  }

  /** Deletes the account and everything derived from it (GDPR erasure). */
  deleteAccount(userId: number): void {
    this.db.transaction(() => {
      this.statement('deleteChunksForUser').run(userId);
      this.statement('deleteDocumentsForUser').run(userId);
      this.statement('deleteSessionsForUser').run(userId);
      this.statement('deleteUser').run(userId);
      this.statement('anonymiseAudit').run(userId);
    })();
    this.audit(null, 'account.delete', 'erased');
  }

  /** Exports all data of a user for data-portability requests. */
  exportAccount(user: UserRow): {
    email: string;
    createdAt: string;
    documents: Array<DocumentSummary & { content: string }>;
  } {
    const dataKey = this.dataKeyFor(user);
    const rows = this.statement('exportDocuments').all(user.id) as Array<{
      id: number;
      title: string;
      category: string;
      byte_size: number;
      content_encrypted: string;
      created_at: string;
    }>;
    this.audit(user.id, 'account.export');
    return {
      email: user.email,
      createdAt: user.created_at,
      documents: rows.map((row) => ({
        id: row.id,
        title: row.title,
        category: row.category,
        byteSize: row.byte_size,
        createdAt: row.created_at,
        content: decrypt(dataKey, row.content_encrypted),
      })),
    };
  }
}
