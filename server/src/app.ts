import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { loadConfig, type AppConfig } from './lib/config.js';
import { openDatabase, type Db } from './lib/db.js';
import { CATEGORIES, Store, type UserRow } from './lib/store.js';
import { answerQuestion } from './lib/model.js';
import { isPlainText } from './lib/text.js';
import { safeEqual } from './lib/crypto.js';

export const SESSION_COOKIE = 'bm_session';

/**
 * Applies to every response, including `robots.txt`-ignoring scrapers and AI
 * crawlers: no indexing, no caching of snippets, no archive copies.
 */
export const ROBOTS_TAG =
  'noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate, noai, noimageai';

const webRoot = path.resolve(fileURLToPath(new URL('../../web', import.meta.url)));

const credentialsSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12).max(200),
});

const documentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  category: z.enum(CATEGORIES),
  content: z.string().min(1),
});

const questionSchema = z.object({ question: z.string().trim().min(3).max(500) });

interface AuthenticatedRequest extends Request {
  user?: UserRow;
  sessionToken?: string;
  csrfToken?: string;
}

/** Minimal cookie parser: avoids an extra dependency for a single cookie. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) {
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }
    }
  }
  return cookies;
}

export interface AppDeps {
  config?: AppConfig;
  db?: Db;
}

export function createApp(deps: AppDeps = {}): express.Express & { locals: { store: Store; db: Db } } {
  const config = deps.config ?? loadConfig();
  const db = deps.db ?? openDatabase(config.databaseFile);
  const store = new Store(db, config.masterKey);

  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') {
    app.set('trust proxy', 1);
  }
  app.locals.store = store;
  app.locals.db = db;

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'form-action': ["'self'"],
          'frame-ancestors': ["'none'"],
          'object-src': ["'none'"],
          'base-uri': ["'none'"],
        },
      },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use((_req, res, next) => {
    // User data must never be cached by proxies or the browser disk cache.
    res.setHeader('Cache-Control', 'no-store');
    // Nothing on this host may be indexed, archived, snippeted or used as
    // training data, by search engines or by AI crawlers.
    res.setHeader('X-Robots-Tag', ROBOTS_TAG);
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), interest-cohort=()');
    next();
  });

  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env.GLOBAL_RATE_LIMIT ?? 300),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down.' },
  });
  app.use(globalLimiter);

  app.use(express.json({ limit: config.maxUploadBytes }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes, files: 1 },
  });

  const askLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env.ASK_RATE_LIMIT ?? 30),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many questions, please try again shortly.' },
  });

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.AUTH_RATE_LIMIT ?? 20),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts, please try again later.' },
  });

  function setSessionCookie(res: Response, token: string, maxAgeMs: number): void {
    const attributes = [
      `${SESSION_COOKIE}=${token}`,
      'HttpOnly',
      'SameSite=Strict',
      'Path=/',
      `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    ];
    if (config.secureCookies) {
      attributes.push('Secure');
    }
    res.setHeader('Set-Cookie', attributes.join('; '));
  }

  function clearSessionCookie(res: Response): void {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }

  function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = token ? store.getSession(token) : undefined;
    const user = session ? store.getUserById(session.userId) : undefined;
    if (!session || !user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (req.method !== 'GET') {
      const provided = String(req.get('x-csrf-token') ?? '');
      if (!safeEqual(provided, session.csrfToken)) {
        res.status(403).json({ error: 'Invalid CSRF token' });
        return;
      }
    }
    req.user = user;
    req.sessionToken = session.token;
    req.csrfToken = session.csrfToken;
    next();
  }

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/api/auth/register', authLimiter, (req, res) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Email and a password of at least 12 characters are required' });
      return;
    }
    if (store.getUserByEmail(parsed.data.email)) {
      // Equalise the work with a real sign-up and stay vague, so that probing
      // this endpoint yields as little as possible about who has a vault here.
      // The result is deliberately discarded: only the scrypt cost matters.
      void store.authenticate(parsed.data.email, parsed.data.password);
      store.audit(null, 'auth.register_conflict');
      res.status(409).json({ error: 'That account could not be created' });
      return;
    }
    const user = store.createUser(parsed.data.email, parsed.data.password);
    const session = store.createSession(user.id, config.sessionTtlMs);
    setSessionCookie(res, session.token, config.sessionTtlMs);
    res.status(201).json({ email: user.email, csrfToken: session.csrfToken });
  });

  app.post('/api/auth/login', authLimiter, (req, res) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid credentials' });
      return;
    }
    const user = store.authenticate(parsed.data.email, parsed.data.password);
    if (!user) {
      store.audit(null, 'auth.failed');
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    const session = store.createSession(user.id, config.sessionTtlMs);
    store.audit(user.id, 'auth.login');
    setSessionCookie(res, session.token, config.sessionTtlMs);
    res.json({ email: user.email, csrfToken: session.csrfToken });
  });

  app.post('/api/auth/logout', requireAuth, (req: AuthenticatedRequest, res) => {
    store.deleteSession(req.sessionToken as string);
    store.audit((req.user as UserRow).id, 'auth.logout');
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthenticatedRequest, res) => {
    const user = req.user as UserRow;
    res.json({ email: user.email, csrfToken: req.csrfToken });
  });

  app.get('/api/documents', requireAuth, (req: AuthenticatedRequest, res) => {
    res.json({ documents: store.listDocuments((req.user as UserRow).id) });
  });

  app.post(
    '/api/documents',
    requireAuth,
    upload.single('file'),
    (req: AuthenticatedRequest, res) => {
      const body = req.body as Record<string, unknown>;
      let content = typeof body.content === 'string' ? body.content : '';
      let title = typeof body.title === 'string' ? body.title : '';
      if (req.file) {
        if (!isPlainText(req.file.buffer)) {
          res.status(415).json({ error: 'Only UTF-8 text documents are supported' });
          return;
        }
        content = req.file.buffer.toString('utf8');
        title = title || path.basename(req.file.originalname).slice(0, 200);
      }
      const parsed = documentSchema.safeParse({ title, category: body.category, content });
      if (!parsed.success) {
        res.status(400).json({ error: 'A title, a supported category and content are required' });
        return;
      }
      const document = store.addDocument(
        req.user as UserRow,
        parsed.data.title,
        parsed.data.category,
        parsed.data.content,
      );
      res.status(201).json({ document });
    },
  );

  app.get('/api/documents/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const id = Number(req.params.id);
    const document = Number.isInteger(id)
      ? store.getDocumentContent(req.user as UserRow, id)
      : undefined;
    if (!document) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    res.json({ document });
  });

  app.delete('/api/documents/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !store.deleteDocument(req.user as UserRow, id)) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    res.json({ ok: true });
  });

  app.post('/api/ask', askLimiter, requireAuth, (req: AuthenticatedRequest, res) => {
    const parsed = questionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'A question of at least 3 characters is required' });
      return;
    }
    const user = req.user as UserRow;
    const result = answerQuestion(parsed.data.question, store.chunksForUser(user));
    store.audit(user.id, 'model.ask');
    res.json(result);
  });

  app.get('/api/account/export', requireAuth, (req: AuthenticatedRequest, res) => {
    res.json(store.exportAccount(req.user as UserRow));
  });

  app.delete('/api/account', requireAuth, (req: AuthenticatedRequest, res) => {
    store.deleteAccount((req.user as UserRow).id);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.use(express.static(webRoot, { index: 'index.html', maxAge: 0 }));

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof multer.MulterError ? 413 : 400;
    res.status(status).json({ error: status === 413 ? 'Upload too large' : 'Request could not be processed' });
  });

  return app as express.Express & { locals: { store: Store; db: Db } };
}
