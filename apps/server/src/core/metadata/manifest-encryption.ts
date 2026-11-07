import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export interface EncryptedManifest {
  algorithm: 'aes-256-gcm';
  iv: string;
  authTag: string;
  ciphertext: string;
}

export function encryptManifest(
  manifest: unknown,
  encryptionKey: Buffer,
): EncryptedManifest {
  if (encryptionKey.length !== KEY_LENGTH) {
    throw new Error('Encryption key must be exactly 32 bytes.');
  }

  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(
    ALGORITHM,
    encryptionKey,
    iv,
  );

  const plaintext = Buffer.from(
    JSON.stringify(manifest),
    'utf8',
  );

  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return {
    algorithm: ALGORITHM,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptManifest<T>(
  encrypted: EncryptedManifest,
  encryptionKey: Buffer,
): T {
  if (encryptionKey.length !== KEY_LENGTH) {
    throw new Error('Encryption key must be exactly 32 bytes.');
  }

  if (encrypted.algorithm !== ALGORITHM) {
    throw new Error('Unsupported encryption algorithm.');
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    encryptionKey,
    Buffer.from(encrypted.iv, 'base64'),
  );

  decipher.setAuthTag(
    Buffer.from(encrypted.authTag, 'base64'),
  );

  const plaintext = Buffer.concat([
    decipher.update(
      Buffer.from(encrypted.ciphertext, 'base64'),
    ),
    decipher.final(),
  ]);

  return JSON.parse(plaintext.toString('utf8')) as T;
}