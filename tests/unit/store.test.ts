import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../server/src/lib/db.js';
import { Store, normaliseEmail } from '../../server/src/lib/store.js';
import { generateDataKey } from '../../server/src/lib/crypto.js';

const tempDirs: string[] = [];

function makeStore(): Store {
  return new Store(openDatabase(':memory:'), generateDataKey());
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('database', () => {
  it('creates the schema on disk with restrictive permissions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-model-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'nested', 'app.db');
    const db = openDatabase(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 });
    db.close();
  });
});

describe('store', () => {
  it('normalises emails', () => {
    expect(normaliseEmail('  User@Example.COM ')).toBe('user@example.com');
  });

  it('registers users and authenticates them', () => {
    const store = makeStore();
    const user = store.createUser('User@Example.com', 'a-very-long-password');
    expect(user.email).toBe('user@example.com');
    expect(user.password_hash).not.toContain('a-very-long-password');
    expect(store.authenticate('user@example.com', 'a-very-long-password')?.id).toBe(user.id);
    expect(store.authenticate('user@example.com', 'wrong-password-here')).toBeUndefined();
    expect(store.authenticate('nobody@example.com', 'a-very-long-password')).toBeUndefined();
    expect(store.getUserById(9999)).toBeUndefined();
  });

  it('stores documents encrypted and only returns them to their owner', () => {
    const db = openDatabase(':memory:');
    const store = new Store(db, generateDataKey());
    const owner = store.createUser('owner@example.com', 'a-very-long-password');
    const other = store.createUser('other@example.com', 'another-long-password');
    const doc = store.addDocument(owner, 'Blood panel', 'health', 'HDL cholesterol was 62 mg/dL.');

    const raw = db.prepare('SELECT content_encrypted FROM documents WHERE id = ?').get(doc.id) as {
      content_encrypted: string;
    };
    expect(raw.content_encrypted).not.toContain('cholesterol');

    expect(store.getDocumentContent(owner, doc.id)?.content).toContain('cholesterol');
    expect(store.getDocumentContent(other, doc.id)).toBeUndefined();
    expect(store.listDocuments(owner.id)).toHaveLength(1);
    expect(store.listDocuments(other.id)).toHaveLength(0);
    expect(store.chunksForUser(other)).toHaveLength(0);
    expect(store.chunksForUser(owner)[0].documentTitle).toBe('Blood panel');
  });

  it('deletes documents only for their owner', () => {
    const store = makeStore();
    const owner = store.createUser('owner@example.com', 'a-very-long-password');
    const other = store.createUser('other@example.com', 'another-long-password');
    const doc = store.addDocument(owner, 'Payslip', 'finance', 'Net pay 4200 EUR per month.');
    expect(store.deleteDocument(other, doc.id)).toBe(false);
    expect(store.deleteDocument(owner, doc.id)).toBe(true);
    expect(store.deleteDocument(owner, doc.id)).toBe(false);
    expect(store.chunksForUser(owner)).toHaveLength(0);
  });

  it('manages sessions, expiry and revocation', () => {
    const store = makeStore();
    const user = store.createUser('user@example.com', 'a-very-long-password');
    const session = store.createSession(user.id, 60_000);
    expect(store.getSession(session.token)?.userId).toBe(user.id);
    expect(store.getSession('unknown-token')).toBeUndefined();

    store.deleteSession(session.token);
    expect(store.getSession(session.token)).toBeUndefined();

    const expired = store.createSession(user.id, -1);
    expect(store.getSession(expired.token)).toBeUndefined();

    const revoked = store.createSession(user.id, 60_000);
    store.deleteSessionsForUser(user.id);
    expect(store.getSession(revoked.token)).toBeUndefined();
  });

  it('exports and erases all account data', () => {
    const db = openDatabase(':memory:');
    const store = new Store(db, generateDataKey());
    const user = store.createUser('user@example.com', 'a-very-long-password');
    store.addDocument(user, 'Transcript', 'education', 'Graduated with distinction in 2019.');
    store.createSession(user.id, 60_000);

    const exported = store.exportAccount(user);
    expect(exported.email).toBe('user@example.com');
    expect(exported.documents[0].content).toContain('distinction');

    store.deleteAccount(user.id);
    expect(store.getUserById(user.id)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM documents').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM chunks').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE user_id IS NOT NULL').get(),
    ).toEqual({ n: 0 });
  });
});
