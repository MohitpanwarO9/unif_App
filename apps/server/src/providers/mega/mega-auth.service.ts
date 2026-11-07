import * as megajs from 'megajs';
import type { TokenVault, EncryptedToken } from '../../core/security/token-vault.js';

type MegaStorage = megajs.Storage;
type MegaSession = ReturnType<MegaStorage['toJSON']>;

export interface MegaLoginResult {
  storage: MegaStorage;
  encryptedSession: EncryptedToken;
  email: string;
  displayName: string;
}

export class MegaAuthService {
  constructor(private readonly vault: TokenVault) {}

  private encryptSession(storage: MegaStorage): EncryptedToken {
    const session = storage.toJSON();

    // Never persist login password or a two-factor authentication code.
    const safeOptions = { ...session.options };
    safeOptions.password = '';
    delete safeOptions.secondFactorCode;
    safeOptions.autologin = false;
    safeOptions.autoload = false;
    safeOptions.keepalive = false;

    const safeSession = {
      ...session,
      options: safeOptions,
    };

    return this.vault.encrypt(JSON.stringify(safeSession));
  }

  async login(
    email: string,
    password: string,
    secondFactorCode?: string,
  ): Promise<MegaLoginResult> {
    const normalizedEmail = email.trim().toLowerCase();

    if (!normalizedEmail || !password) {
      throw new Error('MEGA email and password are required.');
    }

    const storage = new megajs.Storage({
      email: normalizedEmail,
      password,
      ...(secondFactorCode ? { secondFactorCode } : {}),
      autoload: true,
      autologin: true,
      keepalive: false,
    });

    try {
      await storage.ready;

      const encryptedSession = this.encryptSession(storage);

      return {
        storage,
        encryptedSession,
        email: storage.email,
        displayName: storage.name || storage.email,
      };
    } catch (error) {
      await storage.close().catch(() => undefined);
      throw error;
    }
  }

  async restore(encryptedSession: EncryptedToken): Promise<MegaStorage> {
    let stage = 'decrypt';
    let plaintext: string;

    try {
      plaintext = this.vault.decrypt(encryptedSession);
    } catch {
      throw new Error('MEGA_SESSION_RESTORE_FAILED:decrypt');
    }

    try {
      stage = 'parse';
      const session = JSON.parse(plaintext) as MegaSession;

      stage = 'validate';
      if (
        !session ||
        typeof session.key !== 'string' ||
        typeof session.sid !== 'string' ||
        !session.options ||
        typeof session.options.email !== 'string'
      ) {
        throw new Error('Invalid saved MEGA session.');
      }

      const safeOptions = { ...session.options };
      safeOptions.password = '';
      delete safeOptions.secondFactorCode;
      safeOptions.autologin = false;
      safeOptions.autoload = false;
    safeOptions.keepalive = false;

      const safeSession = {
        ...session,
        options: safeOptions,
      };

      stage = 'storage_init';
      const storage = megajs.Storage.fromJSON(safeSession);

      try {
        stage = 'storage_ready';
        await storage.ready;

        stage = 'storage_reload';
        await storage.reload(true);

        return storage;
      } catch (error) {
        // Storage.close() logs out in megajs v1. A failed reload may be
        // transient, so do not invalidate the persisted SID while reporting it.
        let reason = 'UNKNOWN_ERROR';
        if (error instanceof Error) {
          const message = error.message;

          if (/^ESID\s+\(-15\):/.test(message)) {
            reason = 'SESSION_EXPIRED';
          } else if (/^ERATELIMIT\s+\(-4\):/.test(message)) {
            reason = 'RATE_LIMIT';
          } else if (/^(?:EAGAIN\s+\(-3\)|ETEMPUNAVAIL\s+\(-18\)):/.test(message)) {
            reason = 'TEMPORARY_API_ERROR';
          } else if (/^EBLOCKED\s+\(-16\):/.test(message)) {
            reason = 'ACCOUNT_BLOCKED';
          } else if (/^EOVERQUOTA\s+\(-17\):/.test(message)) {
            reason = 'QUOTA_EXCEEDED';
          } else if (error.name === 'TypeError' || error.name === 'AbortError') {
            reason = 'NETWORK_ERROR';
          }
        }

        throw new Error(`MEGA_SESSION_RESTORE_FAILED:${stage}:${reason}`);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('MEGA_SESSION_RESTORE_FAILED:')
      ) {
        throw error;
      }

      throw new Error(`MEGA_SESSION_RESTORE_FAILED:${stage}`);
    } finally {
      // JavaScript strings cannot be reliably zeroed.
    }
  }

  encryptExistingSession(storage: MegaStorage): EncryptedToken {
    return this.encryptSession(storage);
  }
}

