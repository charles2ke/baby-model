import { describe, expect, it } from 'vitest';
import {
  decrypt,
  encrypt,
  generateDataKey,
  hashPassword,
  hashToken,
  randomToken,
  safeEqual,
  unwrapDataKey,
  verifyPassword,
  wrapDataKey,
} from '../../server/src/lib/crypto.js';

describe('crypto', () => {
  it('hashes and verifies passwords', () => {
    const hash = hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(verifyPassword('wrong password entirely', hash)).toBe(false);
  });

  it('produces a different hash for the same password', () => {
    expect(hashPassword('a-very-secret-value')).not.toEqual(hashPassword('a-very-secret-value'));
  });

  it('rejects malformed password hashes', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword('x', 'bcrypt$1$2$3$4$5')).toBe(false);
  });

  it('round-trips encrypted payloads', () => {
    const key = generateDataKey();
    const sealed = encrypt(key, 'blood pressure 120/80');
    expect(sealed).not.toContain('blood');
    expect(decrypt(key, sealed)).toBe('blood pressure 120/80');
  });

  it('fails to decrypt with a different key or tampered payload', () => {
    const key = generateDataKey();
    const sealed = encrypt(key, 'salary 100000');
    expect(() => decrypt(generateDataKey(), sealed)).toThrow();
    const tampered = Buffer.from(sealed, 'base64');
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => decrypt(key, tampered.toString('base64'))).toThrow();
  });

  it('wraps and unwraps data keys', () => {
    const masterKey = generateDataKey();
    const dataKey = generateDataKey();
    expect(unwrapDataKey(masterKey, wrapDataKey(masterKey, dataKey)).equals(dataKey)).toBe(true);
  });

  it('creates unique tokens and stable hashes', () => {
    const token = randomToken();
    expect(token).not.toEqual(randomToken());
    expect(hashToken(token)).toEqual(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
  });

  it('compares secrets safely', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
