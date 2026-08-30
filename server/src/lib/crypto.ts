import crypto from 'node:crypto';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 } as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** Hashes a password with scrypt and a per-password random salt. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password.normalize('NFKC'), salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/** Verifies a password against a stored scrypt hash in constant time. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, n, r, p, salt, expected] = parts;
  const expectedBuffer = Buffer.from(expected, 'base64');
  const derived = crypto.scryptSync(
    password.normalize('NFKC'),
    Buffer.from(salt, 'base64'),
    expectedBuffer.length,
    { N: Number(n), r: Number(r), p: Number(p) },
  );
  return crypto.timingSafeEqual(derived, expectedBuffer);
}

/** Encrypts a UTF-8 string with AES-256-GCM. */
export function encrypt(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

/** Decrypts a payload produced by {@link encrypt}. Throws when tampered with. */
export function decrypt(key: Buffer, payload: string): string {
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + 16);
  const data = raw.subarray(IV_BYTES + 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Creates a fresh random data encryption key for a single user. */
export function generateDataKey(): Buffer {
  return crypto.randomBytes(KEY_BYTES);
}

/** Wraps a user data key with the server master key. */
export function wrapDataKey(masterKey: Buffer, dataKey: Buffer): string {
  return encrypt(masterKey, dataKey.toString('base64'));
}

/** Unwraps a user data key previously wrapped with {@link wrapDataKey}. */
export function unwrapDataKey(masterKey: Buffer, wrapped: string): Buffer {
  return Buffer.from(decrypt(masterKey, wrapped), 'base64');
}

/** Returns a URL safe random token used for sessions and CSRF protection. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Hashes a session token so that the database never stores usable tokens. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Compares two secrets without leaking timing information. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufferA, bufferB);
}
