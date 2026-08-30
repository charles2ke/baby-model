import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface AppConfig {
  /** Directory holding the SQLite database and the development master key. */
  dataDir: string;
  /** Absolute path of the SQLite database file. */
  databaseFile: string;
  /** 32 byte master key used to wrap per-user data encryption keys. */
  masterKey: Buffer;
  /** True when the server runs behind HTTPS and must set `Secure` cookies. */
  secureCookies: boolean;
  /** Maximum accepted upload size in bytes. */
  maxUploadBytes: number;
  /** Session lifetime in milliseconds. */
  sessionTtlMs: number;
}

export const MASTER_KEY_BYTES = 32;
const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function positiveNumberOrDefault(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readMasterKey(env: NodeJS.ProcessEnv, dataDir: string, isProduction: boolean): Buffer {
  const fromEnv = env.MASTER_KEY;
  if (fromEnv) {
    const key = Buffer.from(fromEnv, 'hex');
    if (key.length !== MASTER_KEY_BYTES) {
      throw new Error(`MASTER_KEY must be ${MASTER_KEY_BYTES} bytes encoded as hex`);
    }
    return key;
  }
  if (isProduction) {
    throw new Error('MASTER_KEY environment variable is required in production');
  }
  const keyFile = path.join(dataDir, 'master.key');
  if (fs.existsSync(keyFile)) {
    return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
  }
  const generated = crypto.randomBytes(MASTER_KEY_BYTES);
  fs.writeFileSync(keyFile, generated.toString('hex'), { mode: 0o600 });
  return generated;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const isProduction = env.NODE_ENV === 'production';
  const dataDir = path.resolve(env.DATA_DIR ?? path.join(process.cwd(), 'data'));
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return {
    dataDir,
    databaseFile: env.DATABASE_FILE
      ? path.resolve(env.DATABASE_FILE)
      : path.join(dataDir, 'baby-model.db'),
    masterKey: readMasterKey(env, dataDir, isProduction),
    secureCookies: isProduction,
    maxUploadBytes: positiveNumberOrDefault(env.MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES),
    sessionTtlMs: positiveNumberOrDefault(env.SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS),
  };
}
