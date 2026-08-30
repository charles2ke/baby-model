import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MASTER_KEY_BYTES, loadConfig } from '../../server/src/lib/config.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-model-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('config', () => {
  it('uses the master key from the environment', () => {
    const key = 'a'.repeat(MASTER_KEY_BYTES * 2);
    const config = loadConfig({ DATA_DIR: tempDir(), MASTER_KEY: key });
    expect(config.masterKey.toString('hex')).toBe(key);
    expect(config.secureCookies).toBe(false);
    expect(config.databaseFile.endsWith('baby-model.db')).toBe(true);
  });

  it('rejects master keys of the wrong length', () => {
    expect(() => loadConfig({ DATA_DIR: tempDir(), MASTER_KEY: 'abcd' })).toThrow(/32 bytes/);
  });

  it('requires an explicit master key in production', () => {
    expect(() => loadConfig({ DATA_DIR: tempDir(), NODE_ENV: 'production' })).toThrow(
      /MASTER_KEY environment variable is required/,
    );
  });

  it('marks cookies as secure in production', () => {
    const config = loadConfig({
      DATA_DIR: tempDir(),
      NODE_ENV: 'production',
      MASTER_KEY: 'b'.repeat(MASTER_KEY_BYTES * 2),
      DATABASE_FILE: 'custom.db',
      MAX_UPLOAD_BYTES: '1024',
      SESSION_TTL_MS: '5000',
    });
    expect(config.secureCookies).toBe(true);
    expect(config.maxUploadBytes).toBe(1024);
    expect(config.sessionTtlMs).toBe(5000);
    expect(path.isAbsolute(config.databaseFile)).toBe(true);
  });

  it('falls back to defaults for invalid numeric limits', () => {
    const config = loadConfig({
      DATA_DIR: tempDir(),
      MASTER_KEY: 'c'.repeat(MASTER_KEY_BYTES * 2),
      MAX_UPLOAD_BYTES: '',
      SESSION_TTL_MS: 'not-a-number',
    });
    expect(config.maxUploadBytes).toBe(2 * 1024 * 1024);
    expect(config.sessionTtlMs).toBe(12 * 60 * 60 * 1000);
  });

  it('falls back to a data directory inside the working directory', () => {
    const cwd = process.cwd();
    const dir = tempDir();
    try {
      process.chdir(dir);
      const config = loadConfig({});
      expect(config.dataDir).toBe(path.join(fs.realpathSync(dir), 'data'));
    } finally {
      process.chdir(cwd);
    }
  });

  it('generates and reuses a development master key file', () => {
    const dir = tempDir();
    const first = loadConfig({ DATA_DIR: dir });
    const keyFile = path.join(dir, 'master.key');
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    const second = loadConfig({ DATA_DIR: dir });
    expect(second.masterKey.equals(first.masterKey)).toBe(true);
  });
});
