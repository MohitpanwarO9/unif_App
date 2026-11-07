
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export interface EncryptedToken {
  iv: string;
  authTag: string;
  ciphertext: string;
}

export class TokenVault {
  private readonly encryptionKey: Buffer;
  private destroyed = false;

  constructor(encryptionKey: Buffer) {
    if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== KEY_LENGTH) {
      throw new Error('Token vault key must be exactly 32 bytes.');
    }

    // Keep a private copy so clearing this vault does not alter the caller's buffer.
    this.encryptionKey = Buffer.from(encryptionKey);
  }

  private ensureActive(): void {
    if (this.destroyed) {
      throw new Error('Token vault has been destroyed.');
    }
  }

  encrypt(token: string): EncryptedToken {
    this.ensureActive();

    if (typeof token !== 'string' || !token.trim()) {
      throw new Error('Token cannot be empty.');
    }

    const iv = randomBytes(IV_LENGTH);

    const cipher = createCipheriv(
      ALGORITHM,
      this.encryptionKey,
      iv,
    );

    const ciphertext = Buffer.concat([
      cipher.update(token, 'utf8'),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    return {
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  decrypt(encrypted: EncryptedToken): string {
    this.ensureActive();

    if (
      !encrypted ||
      typeof encrypted.iv !== 'string' ||
      typeof encrypted.authTag !== 'string' ||
      typeof encrypted.ciphertext !== 'string'
    ) {
      throw new Error('Invalid encrypted token structure.');
    }

    const iv = Buffer.from(encrypted.iv, 'base64');
    const authTag = Buffer.from(encrypted.authTag, 'base64');
    const ciphertext = Buffer.from(encrypted.ciphertext, 'base64');

    if (
      iv.length !== IV_LENGTH ||
      authTag.length !== TAG_LENGTH ||
      ciphertext.length === 0
    ) {
      throw new Error('Invalid encrypted token data.');
    }

    const decipher = createDecipheriv(
      ALGORITHM,
      this.encryptionKey,
      iv,
    );

    decipher.setAuthTag(authTag);

    // Authentication failure throws during final().
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return plaintext.toString('utf8');
  }

  // Best-effort clearing of the vault's private key copy.
  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.encryptionKey.fill(0);
    this.destroyed = true;
  }
}
