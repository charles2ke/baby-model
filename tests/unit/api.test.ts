import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp, SESSION_COOKIE, parseCookies } from '../../server/src/app.js';
import { openDatabase } from '../../server/src/lib/db.js';
import { generateDataKey } from '../../server/src/lib/crypto.js';
import type { AppConfig } from '../../server/src/lib/config.js';
import { NO_ANSWER } from '../../server/src/lib/model.js';

const PASSWORD = 'a-very-long-password';

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dataDir: '/tmp/baby-model-test',
    databaseFile: ':memory:',
    masterKey: generateDataKey(),
    secureCookies: false,
    maxUploadBytes: 64 * 1024,
    sessionTtlMs: 60_000,
    ...overrides,
  };
}

interface Session {
  cookie: string;
  csrfToken: string;
}

async function register(app: Express, email: string): Promise<Session> {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: PASSWORD })
    .expect(201);
  return {
    cookie: (response.headers['set-cookie'] as unknown as string[])[0].split(';')[0],
    csrfToken: response.body.csrfToken,
  };
}

function authed(app: Express, method: 'get' | 'post' | 'delete', url: string, session: Session) {
  return request(app)[method](url).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrfToken);
}

describe('api', () => {
  let app: Express;

  beforeEach(() => {
    app = createApp({ config: testConfig(), db: openDatabase(':memory:') });
  });

  it('builds a default application from the environment', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-model-app-'));
    const previous = { ...process.env };
    process.env.DATA_DIR = dir;
    process.env.DATABASE_FILE = path.join(dir, 'app.db');
    try {
      await request(createApp()).get('/api/health').expect(200, { status: 'ok' });
    } finally {
      process.env = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses cookies defensively', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('a=1; b=two%20words; broken')).toEqual({ a: '1', b: 'two words' });
    expect(parseCookies('bad=%E0%A4%A')).toEqual({ bad: '%E0%A4%A' });
  });

  it('serves the web portal and a health probe', async () => {
    await request(app).get('/api/health').expect(200, { status: 'ok' });
    const page = await request(app).get('/').expect(200);
    expect(page.text).toContain('baby-model');
    await request(app).get('/api/unknown').expect(404);
  });

  it('sets hardened security headers', async () => {
    const response = await request(app).get('/api/health');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('registers a user and issues an http-only session cookie', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ email: 'user@example.com', password: PASSWORD })
      .expect(201);
    const cookie = (response.headers['set-cookie'] as unknown as string[])[0];
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain('Secure');
    expect(response.body.csrfToken).toBeTruthy();
  });

  it('marks cookies as secure when configured for https', async () => {
    const secureApp = createApp({
      config: testConfig({ secureCookies: true }),
      db: openDatabase(':memory:'),
    });
    const response = await request(secureApp)
      .post('/api/auth/register')
      .send({ email: 'user@example.com', password: PASSWORD })
      .expect(201);
    expect((response.headers['set-cookie'] as unknown as string[])[0]).toContain('Secure');
  });

  it('enables trust proxy only when explicitly configured', () => {
    const previous = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = '1';
    try {
      const proxiedApp = createApp({ config: testConfig(), db: openDatabase(':memory:') });
      expect(proxiedApp.get('trust proxy')).toBe(1);
    } finally {
      if (previous === undefined) {
        delete process.env.TRUST_PROXY;
      } else {
        process.env.TRUST_PROXY = previous;
      }
    }
  });

  it('validates registration input and rejects duplicates', async () => {
    await request(app).post('/api/auth/register').send({ email: 'nope', password: 'short' }).expect(400);
    await register(app, 'user@example.com');
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'USER@example.com', password: PASSWORD })
      .expect(409);
  });

  it('logs in, reports the session and logs out', async () => {
    await register(app, 'user@example.com');
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@example.com', password: PASSWORD })
      .expect(200);
    const session: Session = {
      cookie: (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0],
      csrfToken: login.body.csrfToken,
    };
    await authed(app, 'get', '/api/auth/me', session).expect(200, {
      email: 'user@example.com',
      csrfToken: session.csrfToken,
    });
    const logout = await authed(app, 'post', '/api/auth/logout', session).expect(200);
    expect((logout.headers['set-cookie'] as unknown as string[])[0]).toContain('Max-Age=0');
    await authed(app, 'get', '/api/auth/me', session).expect(401);
  });

  it('rejects invalid logins without revealing whether the account exists', async () => {
    await register(app, 'user@example.com');
    await request(app).post('/api/auth/login').send({ email: 'x', password: 'y' }).expect(400);
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@example.com', password: 'wrong-password-value' })
      .expect(401);
    const unknownUser = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@example.com', password: PASSWORD })
      .expect(401);
    expect(wrongPassword.body).toEqual(unknownUser.body);
  });

  it('requires authentication for every private endpoint', async () => {
    await request(app).get('/api/documents').expect(401);
    await request(app).post('/api/ask').send({ question: 'anything' }).expect(401);
    await request(app).get('/api/account/export').expect(401);
    await request(app).get('/api/documents').set('Cookie', `${SESSION_COOKIE}=forged`).expect(401);
  });

  it('rejects state changing requests without a valid CSRF token', async () => {
    const session = await register(app, 'user@example.com');
    await request(app)
      .post('/api/documents')
      .set('Cookie', session.cookie)
      .send({ title: 'x', category: 'health', content: 'y' })
      .expect(403);
    await request(app)
      .post('/api/documents')
      .set('Cookie', session.cookie)
      .set('X-CSRF-Token', 'wrong-token')
      .send({ title: 'x', category: 'health', content: 'y' })
      .expect(403);
  });

  it('stores documents from JSON and from uploaded files', async () => {
    const session = await register(app, 'user@example.com');
    await authed(app, 'post', '/api/documents', session)
      .send({ title: 'Blood panel', category: 'health', content: 'HDL cholesterol was 62 mg/dL.' })
      .expect(201);
    const upload = await authed(app, 'post', '/api/documents', session)
      .field('category', 'finance')
      .attach('file', Buffer.from('The mortgage rate is 3.4 percent.'), 'mortgage.txt')
      .expect(201);
    expect(upload.body.document.title).toBe('mortgage.txt');

    const list = await authed(app, 'get', '/api/documents', session).expect(200);
    expect(list.body.documents.map((d: { title: string }) => d.title)).toEqual([
      'mortgage.txt',
      'Blood panel',
    ]);
  });

  it('rejects invalid or binary documents', async () => {
    const session = await register(app, 'user@example.com');
    await authed(app, 'post', '/api/documents', session)
      .send({ title: '', category: 'health', content: '' })
      .expect(400);
    await authed(app, 'post', '/api/documents', session)
      .send({ title: 'x', category: 'not-a-category', content: 'text' })
      .expect(400);
    await authed(app, 'post', '/api/documents', session)
      .field('category', 'health')
      .attach('file', Buffer.from([0x00, 0x01, 0x02]), 'binary.bin')
      .expect(415);
  });

  it('rejects uploads that exceed the configured limit', async () => {
    const smallApp = createApp({
      config: testConfig({ maxUploadBytes: 512 }),
      db: openDatabase(':memory:'),
    });
    const session = await register(smallApp, 'user@example.com');
    await authed(smallApp, 'post', '/api/documents', session)
      .field('category', 'health')
      .attach('file', Buffer.alloc(4096, 'a'), 'big.txt')
      .expect(413);
  });

  it('rejects malformed JSON bodies', async () => {
    const session = await register(app, 'user@example.com');
    await authed(app, 'post', '/api/ask', session)
      .set('Content-Type', 'application/json')
      .send('{ not json')
      .expect(400);
  });

  it('never exposes another user documents', async () => {
    const owner = await register(app, 'owner@example.com');
    const intruder = await register(app, 'intruder@example.com');
    const created = await authed(app, 'post', '/api/documents', owner)
      .send({ title: 'Payslip', category: 'finance', content: 'Net pay is 4200 EUR.' })
      .expect(201);
    const id = created.body.document.id;

    await authed(app, 'get', `/api/documents/${id}`, owner).expect(200);
    await authed(app, 'get', `/api/documents/${id}`, intruder).expect(404);
    await authed(app, 'delete', `/api/documents/${id}`, intruder).expect(404);
    await authed(app, 'get', '/api/documents/not-a-number', intruder).expect(404);
    await authed(app, 'delete', '/api/documents/not-a-number', intruder).expect(404);

    const answer = await authed(app, 'post', '/api/ask', intruder)
      .send({ question: 'what is my net pay' })
      .expect(200);
    expect(answer.body.grounded).toBe(false);
    expect(answer.body.answer).toBe(NO_ANSWER);
  });

  it('answers questions only from the signed-in user documents', async () => {
    const session = await register(app, 'user@example.com');
    await authed(app, 'post', '/api/documents', session)
      .send({
        title: 'Blood panel',
        category: 'health',
        content: 'My HDL cholesterol was 62 mg/dL in March 2024.',
      })
      .expect(201);

    await authed(app, 'post', '/api/ask', session).send({ question: 'ab' }).expect(400);

    const grounded = await authed(app, 'post', '/api/ask', session)
      .send({ question: 'what was my cholesterol' })
      .expect(200);
    expect(grounded.body.grounded).toBe(true);
    expect(grounded.body.answer).toContain('62 mg/dL');
    expect(grounded.body.citations[0].documentTitle).toBe('Blood panel');

    const refused = await authed(app, 'post', '/api/ask', session)
      .send({ question: 'who won the 1998 world cup' })
      .expect(200);
    expect(refused.body.answer).toBe(NO_ANSWER);
  });

  it('deletes documents for their owner', async () => {
    const session = await register(app, 'user@example.com');
    const created = await authed(app, 'post', '/api/documents', session)
      .send({ title: 'Notes', category: 'other', content: 'Some private notes.' })
      .expect(201);
    await authed(app, 'delete', `/api/documents/${created.body.document.id}`, session).expect(200);
    const list = await authed(app, 'get', '/api/documents', session).expect(200);
    expect(list.body.documents).toEqual([]);
  });

  it('exports and erases the account', async () => {
    const session = await register(app, 'user@example.com');
    await authed(app, 'post', '/api/documents', session)
      .send({ title: 'Transcript', category: 'education', content: 'Graduated in 2019.' })
      .expect(201);

    const exported = await authed(app, 'get', '/api/account/export', session).expect(200);
    expect(exported.body.email).toBe('user@example.com');
    expect(exported.body.documents[0].content).toBe('Graduated in 2019.');

    await authed(app, 'delete', '/api/account', session).expect(200);
    await authed(app, 'get', '/api/auth/me', session).expect(401);
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@example.com', password: PASSWORD })
      .expect(401);
  });

  it('rate limits repeated authentication attempts', async () => {
    process.env.AUTH_RATE_LIMIT = '2';
    const limitedApp = createApp({ config: testConfig(), db: openDatabase(':memory:') });
    delete process.env.AUTH_RATE_LIMIT;
    const attempt = () =>
      request(limitedApp).post('/api/auth/login').send({ email: 'user@example.com', password: PASSWORD });
    await attempt();
    await attempt();
    await attempt().expect(429);
  });
});
