import type { Db } from './db.js';
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

export class Store {
  constructor(
    private readonly db: Db,
    private readonly masterKey: Buffer,
  ) {}

  audit(userId: number | null, action: string, detail = ''): void {
    this.db
      .prepare('INSERT INTO audit_log (user_id, action, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(userId, action, detail, new Date().toISOString());
  }

  createUser(email: string, password: string): UserRow {
    const dataKey = generateDataKey();
    const info = this.db
      .prepare(
        'INSERT INTO users (email, password_hash, wrapped_key, created_at) VALUES (?, ?, ?, ?)',
      )
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
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(normaliseEmail(email)) as
      | UserRow
      | undefined;
  }

  getUserById(id: number): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
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
    this.db
      .prepare(
        'INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(hashToken(token), userId, csrfToken, expiresAt, new Date().toISOString());
    return { token, csrfToken, userId, expiresAt };
  }

  getSession(token: string): SessionInfo | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token)) as
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
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  deleteSessionsForUser(userId: number): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  addDocument(
    user: UserRow,
    title: string,
    category: Category,
    content: string,
  ): DocumentSummary {
    const dataKey = this.dataKeyFor(user);
    const createdAt = new Date().toISOString();
    const insertDocument = this.db.prepare(
      'INSERT INTO documents (user_id, title, category, byte_size, content_encrypted, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insertChunk = this.db.prepare(
      'INSERT INTO chunks (document_id, user_id, position, text_encrypted) VALUES (?, ?, ?, ?)',
    );
    const run = this.db.transaction(() => {
      const info = insertDocument.run(
        user.id,
        title,
        category,
        Buffer.byteLength(content, 'utf8'),
        encrypt(dataKey, content),
        createdAt,
      );
      const documentId = Number(info.lastInsertRowid);
      chunkText(content).forEach((chunk, index) => {
        insertChunk.run(documentId, user.id, index, encrypt(dataKey, chunk));
      });
      return documentId;
    });
    const documentId = run();
    this.audit(user.id, 'document.create', `document=${documentId}`);
    return {
      id: documentId,
      title,
      category,
      byteSize: Buffer.byteLength(content, 'utf8'),
      createdAt,
    };
  }

  listDocuments(userId: number): DocumentSummary[] {
    const rows = this.db
      .prepare(
        'SELECT id, title, category, byte_size, created_at FROM documents WHERE user_id = ? ORDER BY id DESC',
      )
      .all(userId) as Array<{
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
    const row = this.db
      .prepare('SELECT title, content_encrypted FROM documents WHERE id = ? AND user_id = ?')
      .get(documentId, user.id) as { title: string; content_encrypted: string } | undefined;
    if (!row) {
      return undefined;
    }
    return { title: row.title, content: decrypt(this.dataKeyFor(user), row.content_encrypted) };
  }

  deleteDocument(user: UserRow, documentId: number): boolean {
    const result = this.db
      .prepare('DELETE FROM documents WHERE id = ? AND user_id = ?')
      .run(documentId, user.id);
    if (result.changes === 0) {
      return false;
    }
    this.db.prepare('DELETE FROM chunks WHERE document_id = ? AND user_id = ?').run(documentId, user.id);
    this.audit(user.id, 'document.delete', `document=${documentId}`);
    return true;
  }

  /** Loads and decrypts every chunk owned by the given user. */
  chunksForUser(user: UserRow): IndexedChunk[] {
    const dataKey = this.dataKeyFor(user);
    const rows = this.db
      .prepare(
        `SELECT c.id AS chunk_id, c.document_id, c.position, c.text_encrypted, d.title, d.category
         FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE c.user_id = ? ORDER BY c.id`,
      )
      .all(user.id) as Array<{
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
    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM chunks WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM documents WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      this.db.prepare('UPDATE audit_log SET user_id = NULL WHERE user_id = ?').run(userId);
    });
    run();
    this.audit(null, 'account.delete', 'erased');
  }

  /** Exports all data of a user for data-portability requests. */
  exportAccount(user: UserRow): {
    email: string;
    createdAt: string;
    documents: Array<DocumentSummary & { content: string }>;
  } {
    const dataKey = this.dataKeyFor(user);
    const rows = this.db
      .prepare(
        'SELECT id, title, category, byte_size, content_encrypted, created_at FROM documents WHERE user_id = ? ORDER BY id',
      )
      .all(user.id) as Array<{
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
