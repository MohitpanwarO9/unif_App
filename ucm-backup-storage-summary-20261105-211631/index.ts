
import dotenv from 'dotenv';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { OAuth2Client } from 'google-auth-library';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import type { RemoteFile } from './providers/provider-interface.js';
import type { GoogleCredentials, GoogleDriveAbout, GoogleDriveFile, GoogleDriveFilesResponse, StoredGoogleTokens } from './providers/google-drive.types.js';
import { TokenVault } from './core/security/token-vault.js';
import { MegaAuthService } from './providers/mega/mega-auth.service.js';
import { MegaAdapter } from './providers/mega/mega.adapter.js';
import { GoogleDriveAdapter } from './providers/google-drive.adapter.js';
import { ProviderRegistry } from './providers/provider-registry.js';
import {
  prisma,
  connectDatabase,
  disconnectDatabase,
} from './core/database/prisma.js';

dotenv.config();
dotenv.config({
  path: resolve(process.cwd(), '../../.env'),
});

if (process.env.RUNNING_IN_DOCKER !== 'true' && process.env.DATABASE_URL) {
  const databaseUrl = new URL(process.env.DATABASE_URL);

  if (databaseUrl.hostname === 'db') {
    databaseUrl.hostname = '127.0.0.1';
    process.env.DATABASE_URL = databaseUrl.toString();
  }
}

async function readEncryptionKeyFromStdin(): Promise<Buffer | null> {
  if (process.stdin.isTTY) return null;

  let input = '';

  for await (const chunk of process.stdin) {
    input += typeof chunk === 'string'
      ? chunk
      : chunk.toString('utf8');

    if (input.length > 128) {
      throw new Error('Encryption key input is too large.');
    }

    const newlineIndex = input.indexOf('\n');

    if (newlineIndex !== -1) {
      input = input.slice(0, newlineIndex);
      break;
    }
  }

  const keyHex = input.trim();

  if (!keyHex) return null;

  if (!/^[a-fA-F0-9]{64}$/.test(keyHex)) {
    throw new Error('Invalid encryption key received from secure key pipe.');
  }

  return Buffer.from(keyHex, 'hex');
}

const encryptionKey = await readEncryptionKeyFromStdin();

if (
  !encryptionKey &&
  !process.stdin.isTTY &&
  process.env.RUNNING_IN_DOCKER !== 'true'
) {
  throw new Error(
    'Encryption key was not provided by the desktop application.'
  );
}

const tokenVault = encryptionKey
  ? new TokenVault(encryptionKey)
  : null;

encryptionKey?.fill(0);

const credentialsPath = process.env.GOOGLE_OAUTH_CLIENT_FILE;

const redirectUri =
  process.env.OAUTH_REDIRECT_URI ??
  'http://localhost:4000/auth/google/callback';

const oauthEnabled = Boolean(credentialsPath && tokenVault);

const app = Fastify({
  logger: true,
  // Raw binary upload chunks avoid Base64 expansion and extra browser/server copies.
  bodyLimit: 36 * 1024 * 1024,
});

app.addContentTypeParser(
  'application/octet-stream',
  { parseAs: 'buffer' },
  (_request, body, done) => done(null, body),
);

const providerRegistry = new ProviderRegistry();
const megaSessions = new Map<string, import('megajs').Storage>();
const megaAuthService = tokenVault ? new MegaAuthService(tokenVault) : null;

type MegaUploadTransfer = {
  accountId: string;
  fileName: string;
  totalBytes: number;
  receivedBytes: number;
  uploadedBytes: number;
  paused: boolean;
  cancelled: boolean;
  completed: boolean;
  stream: PassThrough;
  uploadPromise: Promise<RemoteFile>;
  file?: RemoteFile;
  createdAt: number;
};

const megaUploadTransfers = new Map<string, MegaUploadTransfer>();
const maxUploadChunkBytes = 8 * 1024 * 1024;

app.addHook('onClose', async () => {
  for (const transfer of megaUploadTransfers.values()) {
    if (!transfer.completed) {
      transfer.cancelled = true;
      transfer.stream.destroy(new Error('Application is shutting down.'));
    }
  }
  megaUploadTransfers.clear();
  try {
    // Do not call Storage.close() here: megajs v1 logs the account out,
    // invalidating the persisted SID that must survive app restarts.
    // keepalive is disabled for persisted sessions, so process shutdown
    // can release its resources without an explicit MEGA logout.
    megaSessions.clear();
    await disconnectDatabase();
  } finally {
    tokenVault?.destroy();
  }
});

await app.register(cors, {
  origin: [
    'http://localhost:5173',
    'http://tauri.localhost',
    'https://tauri.localhost',
    'tauri://localhost',
  ],
});

await connectDatabase();
app.log.info('PostgreSQL database connected successfully.');

async function getLocalUser() {
  let localUser = await prisma.user.findFirst({
    orderBy: { createdAt: 'asc' },
  });

  if (!localUser) {
    localUser = await prisma.user.create({
      data: { displayName: 'Local User' },
    });
  }

  return localUser;
}

async function getMegaStorage(accountId: string) {
  if (!tokenVault || !megaAuthService) {
    throw new Error('MEGA secure session storage is unavailable.');
  }

  const cached = megaSessions.get(accountId);
  if (cached) return cached;

  const localUser = await getLocalUser();

  const account = await prisma.cloudAccount.findFirst({
    where: {
      id: accountId,
      userId: localUser.id,
      provider: 'MEGA',
      status: 'CONNECTED',
    },
    include: {
      credential: true,
    },
  });

  if (!account || !account.credential) {
    throw new Error('Connected MEGA account or saved session was not found.');
  }

  const storage = await megaAuthService.restore({
    ciphertext: account.credential.encryptedPayload,
    iv: account.credential.iv,
    authTag: account.credential.authTag,
  });

  megaSessions.set(accountId, storage);
  return storage;
}

const megaAdapter = new MegaAdapter(getMegaStorage);

function getMegaAdapter(accountId: string) {
  if (!providerRegistry.hasAccount(accountId)) {
    providerRegistry.register(accountId, megaAdapter);
  }

  return providerRegistry.getAdapter(accountId, 'MEGA');
}

app.get('/health', async () => ({
  status: 'ok',
  service: 'unified-cloud-api',
  version: '0.1.0',
  apiProtocolVersion: 2,
  stage: 'database-connected',
  database: 'connected',
  encryption: tokenVault ? 'ready' : 'not-configured',
  oauth: oauthEnabled ? 'configured' : 'disabled',
}));

app.get('/accounts', async (_request, reply) => {
  try {
    const localUser = await getLocalUser();

    const accounts = await prisma.cloudAccount.findMany({
      where: { userId: localUser.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        provider: true,
        displayLabel: true,
        status: true,
        lastVerifiedAt: true,
        createdAt: true,
      },
    });

    return reply.send({
      status: 'success',
      accounts,
    });
  } catch {
    return reply.code(500).send({
      status: 'error',
      message: 'Unable to load connected accounts.',
    });
  }
});

app.post('/auth/mega/connect', async (request, reply) => {
  const body = request.body as {
    email?: string;
    password?: string;
    secondFactorCode?: string;
  } | null;

  if (
    !body ||
    typeof body.email !== 'string' ||
    typeof body.password !== 'string' ||
    !body.email.trim() ||
    !body.password
  ) {
    return reply.code(400).send({
      status: 'error',
      message: 'MEGA email and password are required.',
    });
  }

  if (!tokenVault) {
    return reply.code(503).send({
      status: 'error',
      message: 'Secure credential storage is unavailable.',
    });
  }

  if (
    body.secondFactorCode !== undefined &&
    (typeof body.secondFactorCode !== 'string' ||
      !/^\d{6,8}$/.test(body.secondFactorCode))
  ) {
    return reply.code(400).send({
      status: 'error',
      message: 'Invalid MEGA two-factor authentication code.',
    });
  }

  let storage: import('megajs').Storage | undefined;
  let retainStorage = false;

  try {
    const authService = new MegaAuthService(tokenVault);
    const result = await authService.login(
      body.email,
      body.password,
      body.secondFactorCode,
    );

    storage = result.storage;

    const accountInfo = await storage.getAccountInfo();
    const totalBytes = BigInt(Math.max(0, Math.floor(accountInfo.spaceTotal)));
    const usedBytes = BigInt(Math.max(0, Math.floor(accountInfo.spaceUsed)));
    const freeBytes = totalBytes > usedBytes ? totalBytes - usedBytes : 0n;

    const localUser = await getLocalUser();

    const existing = await prisma.cloudAccount.findFirst({
      where: {
        userId: localUser.id,
        provider: 'MEGA',
        providerAccountRef: result.email,
      },
      select: { id: true },
    });

    const account = await prisma.$transaction(async (tx) => {
      const savedAccount = existing
        ? await tx.cloudAccount.update({
            where: { id: existing.id },
            data: {
              displayLabel: result.displayName,
              status: 'CONNECTED',
              totalBytes,
              usedBytes,
              freeBytes,
              lastVerifiedAt: new Date(),
            },
          })
        : await tx.cloudAccount.create({
            data: {
              userId: localUser.id,
              provider: 'MEGA',
              displayLabel: result.displayName,
              providerAccountRef: result.email,
              status: 'CONNECTED',
              totalBytes,
              usedBytes,
              freeBytes,
              lastVerifiedAt: new Date(),
            },
          });

      await tx.cloudAccountCredential.upsert({
        where: { cloudAccountId: savedAccount.id },
        create: {
          cloudAccountId: savedAccount.id,
          encryptedPayload: result.encryptedSession.ciphertext,
          iv: result.encryptedSession.iv,
          authTag: result.encryptedSession.authTag,
          scopes: ['mega:session'],
        },
        update: {
          encryptedPayload: result.encryptedSession.ciphertext,
          iv: result.encryptedSession.iv,
          authTag: result.encryptedSession.authTag,
          scopes: ['mega:session'],
          expiresAt: null,
        },
      });

      return savedAccount;
    });

    // A successful reconnect replaces the encrypted session in the database.
    // Evict any previously cached Storage instance so subsequent requests
    // restore the newly saved session instead of reusing an expired SID.
    const staleStorage = megaSessions.get(account.id);
    if (staleStorage && staleStorage !== storage) {
      megaSessions.delete(account.id);
      // The previous cached session is obsolete after a fresh login.
      await staleStorage.close().catch(() => undefined);
    }

    if (storage) {
      // Keep the freshly authenticated instance alive for this process.
      // Closing it here would log out the newly persisted MEGA SID.
      megaSessions.set(account.id, storage);
      retainStorage = true;
    }

    return reply.code(existing ? 200 : 201).send({
      status: 'success',
      account: {
        id: account.id,
        provider: account.provider,
        displayLabel: account.displayLabel,
        status: account.status,
        totalBytes: totalBytes.toString(),
        usedBytes: usedBytes.toString(),
        freeBytes: freeBytes.toString(),
      },
    });
  } catch {
    request.log.error('MEGA account connection failed. Sensitive details omitted.');
    return reply.code(502).send({
      status: 'error',
      message: 'MEGA connection failed. Check your credentials and two-factor code.',
    });
  } finally {
    if (storage && !retainStorage) {
      await storage.close().catch(() => undefined);
    }
  }
});
const pendingStates = new Map<string, number>();

if (oauthEnabled && credentialsPath && tokenVault) {
  const credentials: GoogleCredentials = JSON.parse(
    await readFile(credentialsPath, 'utf8')
  );

  const googleConfig = credentials.web;

  if (
    !googleConfig?.client_id ||
    !googleConfig.client_secret ||
    !googleConfig.redirect_uris?.includes(redirectUri)
  ) {
    throw new Error('Google OAuth client configuration is incomplete.');
  }

  const oauthClient = new OAuth2Client(
    googleConfig.client_id,
    googleConfig.client_secret,
    redirectUri
  );

  app.get('/auth/google/start', async (_request, reply) => {
    const now = Date.now();

    for (const [state, expiry] of pendingStates) {
      if (expiry < now) pendingStates.delete(state);
    }

    const state = randomBytes(32).toString('hex');
    pendingStates.set(state, now + 10 * 60 * 1000);

    const authUrl = oauthClient.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/drive'],
      include_granted_scopes: true,
      prompt: 'select_account consent',
      state,
    });

    return reply.redirect(authUrl);
  });

  app.get('/auth/google/callback', async (request, reply) => {
    const query = request.query as {
      code?: string;
      state?: string;
      error?: string;
    };

    if (query.error) {
      return reply.code(400).send({
        status: 'error',
        message: 'Google authorization was not completed.',
      });
    }

    const expiry = query.state
      ? pendingStates.get(query.state)
      : undefined;

    if (
      !query.state ||
      !expiry ||
      expiry < Date.now() ||
      !query.code
    ) {
      return reply.code(400).send({
        status: 'error',
        message: 'Invalid or expired OAuth request. Please try again.',
      });
    }

    pendingStates.delete(query.state);

    try {
      const { tokens } = await oauthClient.getToken(query.code);

      if (!tokens.access_token) {
        return reply.code(400).send({
          status: 'error',
          message: 'Google did not return an access token.',
        });
      }

      oauthClient.setCredentials(tokens);

      const aboutResponse = await oauthClient.request<GoogleDriveAbout>({
        url: 'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,permissionId)',
      });

      const googleUser = aboutResponse.data.user;

      if (!googleUser) {
        throw new Error('Google account information was unavailable.');
      }

      const providerAccountRef =
        googleUser.permissionId || googleUser.emailAddress;

      if (!providerAccountRef) {
        throw new Error('Google account identifier was unavailable.');
      }

      const displayLabel =
        googleUser.displayName ||
        googleUser.emailAddress ||
        'Google Drive';

      const localUser = await getLocalUser();

      const existingAccount = await prisma.cloudAccount.findFirst({
        where: {
          userId: localUser.id,
          provider: 'GOOGLE_DRIVE',
          providerAccountRef,
        },
        include: { credential: true },
      });

      let previousRefreshToken: string | null = null;

      if (existingAccount?.credential) {
        const previousPayload = JSON.parse(
          tokenVault.decrypt({
            iv: existingAccount.credential.iv,
            authTag: existingAccount.credential.authTag,
            ciphertext: existingAccount.credential.encryptedPayload,
          })
        ) as StoredGoogleTokens;

        previousRefreshToken = previousPayload.refresh_token ?? null;
      }

      const tokenPayload = {
        ...tokens,
        refresh_token:
          tokens.refresh_token ?? previousRefreshToken ?? undefined,
      };

      const encrypted = tokenVault.encrypt(
        JSON.stringify(tokenPayload)
      );

      const expiresAt = tokens.expiry_date
        ? new Date(tokens.expiry_date)
        : null;

      const scopes = tokens.scope
        ? tokens.scope.split(/\s+/).filter(Boolean)
        : [];

      const savedAccount = await prisma.$transaction(async (tx) => {
        const account = existingAccount
          ? await tx.cloudAccount.update({
              where: { id: existingAccount.id },
              data: {
                displayLabel,
                status: 'CONNECTED',
                lastVerifiedAt: new Date(),
              },
            })
          : await tx.cloudAccount.create({
              data: {
                userId: localUser.id,
                provider: 'GOOGLE_DRIVE',
                providerAccountRef,
                displayLabel,
                status: 'CONNECTED',
                lastVerifiedAt: new Date(),
              },
            });

        await tx.cloudAccountCredential.upsert({
          where: { cloudAccountId: account.id },
          create: {
            cloudAccountId: account.id,
            encryptedPayload: encrypted.ciphertext,
            iv: encrypted.iv,
            authTag: encrypted.authTag,
            expiresAt,
            scopes,
          },
          update: {
            encryptedPayload: encrypted.ciphertext,
            iv: encrypted.iv,
            authTag: encrypted.authTag,
            expiresAt,
            scopes,
          },
        });

        return account;
      });

      request.log.info(
        'Google Drive account and encrypted credentials saved successfully.'
      );

      return reply.send({
        status: 'success',
        message: 'Google Drive account connected successfully.',
        account: {
          id: savedAccount.id,
          provider: savedAccount.provider,
          displayLabel: savedAccount.displayLabel,
          status: savedAccount.status,
        },
        credentials: 'encrypted_and_saved',
      });
    } catch {
      request.log.error(
        'Google OAuth callback failed. Sensitive authorization details omitted.'
      );

      return reply.code(500).send({
        status: 'error',
        message: 'Google account connection failed. Please try again.',
      });
    }
  });

  async function getDriveClient(accountId: string) {
    const vault = tokenVault;
    const config = googleConfig;

    if (!vault || !config) {
      throw new Error('Google Drive encryption or OAuth is unavailable.');
    }

    const localUser = await getLocalUser();

    const account = await prisma.cloudAccount.findFirst({
      where: {
        id: accountId,
        userId: localUser.id,
        provider: 'GOOGLE_DRIVE',
        status: 'CONNECTED',
      },
      include: { credential: true },
    });

    if (!account?.credential) {
      return null;
    }

    const storedTokens = JSON.parse(
      vault.decrypt({
        iv: account.credential.iv,
        authTag: account.credential.authTag,
        ciphertext: account.credential.encryptedPayload,
      })
    ) as StoredGoogleTokens;

    const driveClient = new OAuth2Client(
      config.client_id,
      config.client_secret,
      redirectUri
    );

    driveClient.setCredentials(
      storedTokens as Parameters<OAuth2Client['setCredentials']>[0]
    );

    const previousAccessToken = storedTokens.access_token;
    await driveClient.getAccessToken();

    const refreshedTokens = driveClient.credentials;

    if (
      refreshedTokens.access_token &&
      refreshedTokens.access_token !== previousAccessToken
    ) {
      const updatedPayload = {
        ...storedTokens,
        ...refreshedTokens,
        refresh_token:
          refreshedTokens.refresh_token ??
          storedTokens.refresh_token ??
          undefined,
      };

      const encrypted = vault.encrypt(
        JSON.stringify(updatedPayload)
      );

      await prisma.cloudAccountCredential.update({
        where: { cloudAccountId: account.id },
        data: {
          encryptedPayload: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          expiresAt: refreshedTokens.expiry_date
            ? new Date(refreshedTokens.expiry_date)
            : account.credential.expiresAt,
          scopes: refreshedTokens.scope
            ? refreshedTokens.scope.split(/\s+/).filter(Boolean)
            : account.credential.scopes,
        },
      });
    }

    return driveClient;
  }

  const googleDriveAdapter = new GoogleDriveAdapter(getDriveClient);

  function getGoogleDriveAdapter(accountId: string) {
    if (!providerRegistry.hasAccount(accountId)) {
      providerRegistry.register(accountId, googleDriveAdapter);
    }
    return providerRegistry.getAdapter(accountId, 'GOOGLE_DRIVE');
  }

  // Select a connected destination for a new file at the unified root.
  // This is deliberately single-account placement: the current file browser
  // stores provider-native IDs and does not yet reconstruct distributed files.
  app.post('/storage/allocate', async (request, reply) => {
    const body = request.body as { totalBytes?: number } | null;
    if (!body || !Number.isSafeInteger(body.totalBytes) || (body.totalBytes as number) < 1) {
      return reply.code(400).send({
        status: 'error',
        message: 'A positive safe-integer totalBytes value is required.',
      });
    }

    const requestedBytes = BigInt(body.totalBytes as number);

    try {
      const localUser = await getLocalUser();
      const connected = await prisma.cloudAccount.findMany({
        where: {
          userId: localUser.id,
          status: 'CONNECTED',
          provider: { in: ['GOOGLE_DRIVE', 'MEGA'] },
        },
        select: { id: true, provider: true, displayLabel: true },
      });

      const quotaResults = await Promise.all(connected.map(async (account) => {
        try {
          const quota = account.provider === 'GOOGLE_DRIVE'
            ? await getGoogleDriveAdapter(account.id).getQuota(account.id)
            : await getMegaAdapter(account.id).getQuota(account.id);
          const freeBytes = BigInt(quota.freeBytes);
          return { account, freeBytes, totalBytes: BigInt(quota.totalBytes), available: true as const };
        } catch {
          return { account, freeBytes: 0n, totalBytes: 0n, available: false as const };
        }
      }));

      const available = quotaResults.filter((item) => item.available && item.freeBytes > 0n);
      const combinedFreeBytes = available.reduce((sum, item) => sum + item.freeBytes, 0n);
      const candidates = available
        .filter((item) => item.freeBytes >= requestedBytes)
        .sort((a, b) => a.freeBytes < b.freeBytes ? -1 : a.freeBytes > b.freeBytes ? 1 : 0);
      const selected = candidates[0];

      if (!selected) {
        return reply.code(507).send({
          status: 'error',
          code: 'NO_SINGLE_ACCOUNT_CAPACITY',
          message: combinedFreeBytes >= requestedBytes
            ? 'Combined free space is sufficient, but no single account can hold this file. Distributed file storage is not enabled yet.'
            : 'No connected cloud account has enough free space for this file.',
          requestedBytes: requestedBytes.toString(),
          combinedFreeBytes: combinedFreeBytes.toString(),
          accounts: quotaResults.map((item) => ({
            accountId: item.account.id,
            provider: item.account.provider,
            displayLabel: item.account.displayLabel,
            freeBytes: item.freeBytes.toString(),
            quotaAvailable: item.available,
          })),
        });
      }

      return reply.send({
        status: 'success',
        allocation: {
          accountId: selected.account.id,
          provider: selected.account.provider,
          displayLabel: selected.account.displayLabel,
          freeBytes: selected.freeBytes.toString(),
          policy: 'single-account-best-fit',
        },
        combinedFreeBytes: combinedFreeBytes.toString(),
      });
    } catch {
      request.log.error('Automatic storage allocation failed.');
      return reply.code(502).send({
        status: 'error',
        message: 'Could not evaluate connected cloud storage capacity.',
      });
    }
  });
  // List existing Google Drive files.
  app.get('/drive/files', async (request, reply) => {
    const query = request.query as {
      accountId?: string;
      pageToken?: string;
      pageSize?: string;
      parentId?: string;
    };

    if (!query.accountId) {
      return reply.code(400).send({
        status: 'error',
        message: 'accountId is required.',
      });
    }

    const pageSize = Math.min(
      Math.max(Number(query.pageSize) || 100, 1),
      1000
    );

    try {
      const parentId = query.parentId?.trim();

      if (parentId && !/^[A-Za-z0-9_-]{1,200}$/.test(parentId)) {
        return reply.code(400).send({
          status: 'error',
          message: 'Invalid parent folder ID.',
        });
      }

      const adapter = getGoogleDriveAdapter(query.accountId);
      const result = await adapter.listFiles(query.accountId, {
        parentId,
        pageToken: query.pageToken,
        pageSize,
      });

      return reply.send({
        status: 'success',
        accountId: query.accountId,
        files: result.files.map((file) => ({
          id: file.remoteObjectId,
          name: file.name,
          mimeType: file.mimeType,
          size: file.sizeBytes,
          modifiedTime: file.modifiedAt,
          webViewLink: file.webUrl,
          parents: file.parentId ? [file.parentId] : [],
        })),
        nextPageToken: result.nextPageToken ?? null,
        incompleteSearch: false,
      });    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Connected Google Drive account was not found.'
      ) {
        return reply.code(404).send({
          status: 'error',
          message: 'Connected Google Drive account was not found.',
        });
      }

      request.log.error(
        'Google Drive file listing failed. Sensitive details omitted.'
      );

      return reply.code(502).send({
        status: 'error',
        message: 'Unable to load Google Drive files.',
      });
    }
  });
  // Read storage quota through the provider adapter.
  app.get('/drive/quota', async (request, reply) => {
    const query = request.query as { accountId?: string };

    if (!query.accountId) {
      return reply.code(400).send({
        status: 'error',
        message: 'accountId is required.',
      });
    }

    try {
      const adapter = getGoogleDriveAdapter(query.accountId);
      const quota = await adapter.getQuota(query.accountId);

      return reply.send({
        status: 'success',
        accountId: query.accountId,
        quota,
      });
    } catch {
      request.log.error('Google Drive quota lookup failed.');
      return reply.code(502).send({
        status: 'error',
        message: 'Unable to load storage quota.',
      });
    }
  });

  // Delete a file through the provider adapter.
  app.delete('/drive/files/:fileId', async (request, reply) => {
    const params = request.params as { fileId?: string };
    const query = request.query as { accountId?: string };

    if (
      !query.accountId ||
      !params.fileId ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(params.fileId)
    ) {
      return reply.code(400).send({
        status: 'error',
        message: 'Valid accountId and fileId are required.',
      });
    }

    try {
      const adapter = getGoogleDriveAdapter(query.accountId);
      await adapter.delete(query.accountId, params.fileId);

      return reply.send({
        status: 'success',
        fileId: params.fileId,
      });
    } catch {
      request.log.error('Google Drive file deletion failed.');
      return reply.code(502).send({
        status: 'error',
        message: 'Unable to delete the file.',
      });
    }
  });
  // Create a folder in the connected Google Drive account.
  app.post('/drive/folders', async (request, reply) => {
    const body = request.body as {
      accountId?: string;
      name?: string;
      parentId?: string;
    } | null;

    if (
      !body ||
      typeof body.accountId !== 'string' ||
      typeof body.name !== 'string'
    ) {
      return reply.code(400).send({
        status: 'error',
        message: 'accountId and folder name are required.',
      });
    }

    const name = body.name.trim();
    const parentId = body.parentId?.trim();

    if (!name || name.length > 255 || /[\r\n]/.test(name)) {
      return reply.code(400).send({
        status: 'error',
        message: 'Invalid folder name.',
      });
    }

    if (parentId && !/^[A-Za-z0-9_-]{1,200}$/.test(parentId)) {
      return reply.code(400).send({
        status: 'error',
        message: 'Invalid parent folder ID.',
      });
    }

    try {
      const adapter = getGoogleDriveAdapter(body.accountId);
      const folder = await adapter.createFolder(body.accountId, {
        name,
        parentId,
      });

      return reply.code(201).send({
        status: 'success',
        folder: {
          id: folder.remoteObjectId,
          name: folder.name,
          mimeType: folder.mimeType,
          modifiedTime: folder.modifiedAt,
          parents: folder.parentId ? [folder.parentId] : [],
        },
      });    } catch {
      request.log.error(
        'Google Drive folder creation failed. Sensitive details omitted.'
      );

      return reply.code(502).send({
        status: 'error',
        message: 'Unable to create folder in Google Drive.',
      });
    }
  });
  // Download file content securely through the connected Google account.
  // Google Docs, Sheets and Slides are exported to preview-friendly formats.
  app.get('/drive/files/:fileId/content', async (request, reply) => {
    const params = request.params as { fileId?: string };
    const query = request.query as { accountId?: string };

    const fileId = params.fileId;
    const accountId = query.accountId;

    if (
      !accountId ||
      !fileId ||
      !/^[A-Za-z0-9_-]{5,200}$/.test(fileId)
    ) {
      return reply.code(400).send({
        status: 'error',
        message: 'A valid accountId and fileId are required.',
      });
    }

    const maxPreviewBytes = 50 * 1024 * 1024;

    try {
      const driveClient = await getDriveClient(accountId);

      if (!driveClient) {
        return reply.code(404).send({
          status: 'error',
          message: 'Connected Google Drive account was not found.',
        });
      }

      // Confirm the requested file belongs to this connected account.
      const metadataResponse =
        await driveClient.request<GoogleDriveFile>({
          url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,trashed`,
          method: 'GET',
        });

      const file = metadataResponse.data;

      if (!file.id || file.trashed) {
        return reply.code(404).send({
          status: 'error',
          message: 'File was not found or is in the Google Drive trash.',
        });
      }

      if (file.mimeType === 'application/vnd.google-apps.folder') {
        return reply.code(400).send({
          status: 'error',
          message: 'Folders cannot be opened as files.',
        });
      }

      if (file.size && Number(file.size) > maxPreviewBytes) {
        return reply.code(413).send({
          status: 'error',
          message: 'This file is larger than the 50 MB preview limit.',
        });
      }

      const googleExports: Record<string, {
        mimeType: string;
        extension: string;
      }> = {
        'application/vnd.google-apps.document': {
          mimeType: 'application/pdf',
          extension: '.pdf',
        },
        'application/vnd.google-apps.spreadsheet': {
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          extension: '.xlsx',
        },
        'application/vnd.google-apps.presentation': {
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          extension: '.pptx',
        },
        'application/vnd.google-apps.drawing': {
          mimeType: 'application/pdf',
          extension: '.pdf',
        },
      };

      const exportFormat = file.mimeType
        ? googleExports[file.mimeType]
        : undefined;

      let contentResponse;
      let outputMimeType = file.mimeType || 'application/octet-stream';
      let outputName = file.name || 'download';

      if (exportFormat) {
        const exportParams = new URLSearchParams({
          mimeType: exportFormat.mimeType,
        });

        contentResponse = await driveClient.request<ArrayBuffer>({
          url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?${exportParams.toString()}`,
          method: 'GET',
          responseType: 'arraybuffer',
        });

        outputMimeType = exportFormat.mimeType;

        if (!outputName.toLowerCase().endsWith(exportFormat.extension)) {
          outputName += exportFormat.extension;
        }
      } else {
        contentResponse = await driveClient.request<ArrayBuffer>({
          url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
          method: 'GET',
          responseType: 'arraybuffer',
        });
      }

      const fileBuffer = Buffer.from(contentResponse.data);

      if (fileBuffer.length > maxPreviewBytes) {
        fileBuffer.fill(0);

        return reply.code(413).send({
          status: 'error',
          message: 'This file is larger than the 50 MB preview limit.',
        });
      }

      if (fileBuffer.length === 0) {
        return reply.code(404).send({
          status: 'error',
          message: 'The file has no downloadable content.',
        });
      }

      const safeName = outputName
        .replace(/[\r\n"]/g, '_')
        .slice(0, 255);

      const dispositionName = encodeURIComponent(safeName);

      reply
        .header('Content-Type', outputMimeType)
        .header('Content-Length', String(fileBuffer.length))
        .header(
          'Content-Disposition',
          `inline; filename="preview"; filename*=UTF-8''${dispositionName}`
        )
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff');

      return reply.send(fileBuffer);
    } catch {
      request.log.error(
        'Google Drive file content request failed. Sensitive details omitted.'
      );

      return reply.code(502).send({
        status: 'error',
        message: 'Unable to retrieve this file from Google Drive.',
      });
    }
  });


  // Download sessions keep export data (Google Docs formats) server-side.
  // Ordinary Drive files are fetched as bounded HTTP range chunks.
  type DownloadTransfer = {
    accountId: string;
    fileId: string;
    fileName: string;
    mimeType: string;
    totalBytes: number;
    exportBuffer?: Buffer;
    createdAt: number;
  };

  const downloadTransfers = new Map<string, DownloadTransfer>();
  const maxDownloadChunkBytes = 8 * 1024 * 1024;
  const maxGoogleExportBytes = 10 * 1024 * 1024;

  const googleDownloadExports: Record<string, { mimeType: string; extension: string }> = {
    'application/vnd.google-apps.document': {
      mimeType: 'application/pdf',
      extension: '.pdf',
    },
    'application/vnd.google-apps.spreadsheet': {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: '.xlsx',
    },
    'application/vnd.google-apps.presentation': {
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      extension: '.pptx',
    },
    'application/vnd.google-apps.drawing': {
      mimeType: 'application/pdf',
      extension: '.pdf',
    },
  };

  app.post('/drive/transfers/download/init', async (request, reply) => {
    const body = request.body as { accountId?: string; fileId?: string } | null;

    if (
      !body ||
      typeof body.accountId !== 'string' ||
      typeof body.fileId !== 'string' ||
      !/^[A-Za-z0-9_-]{5,200}$/.test(body.fileId)
    ) {
      return reply.code(400).send({
        status: 'error',
        message: 'A valid accountId and fileId are required.',
      });
    }

    try {
      for (const [id, stale] of downloadTransfers) {
        if (Date.now() - stale.createdAt > 30 * 60 * 1000) {
          stale.exportBuffer?.fill(0);
          downloadTransfers.delete(id);
        }
      }

      const driveClient = await getDriveClient(body.accountId);
      if (!driveClient) {
        return reply.code(404).send({
          status: 'error',
          message: 'Connected Google Drive account was not found.',
        });
      }

      const metadataResponse = await driveClient.request<GoogleDriveFile>({
        url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(body.fileId)}?fields=id,name,mimeType,size,trashed`,
        method: 'GET',
      });
      const file = metadataResponse.data;

      if (!file.id || file.trashed) {
        return reply.code(404).send({
          status: 'error',
          message: 'File was not found or is in the Google Drive trash.',
        });
      }
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        return reply.code(400).send({
          status: 'error',
          message: 'Folders cannot be downloaded as files.',
        });
      }

      let fileName = file.name || 'download';
      let mimeType = file.mimeType || 'application/octet-stream';
      let exportBuffer: Buffer | undefined;
      const exportFormat = file.mimeType ? googleDownloadExports[file.mimeType] : undefined;

      if (exportFormat) {
        const params = new URLSearchParams({ mimeType: exportFormat.mimeType });
        const exported = await driveClient.request<ArrayBuffer>({
          url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(body.fileId)}/export?${params.toString()}`,
          method: 'GET',
          responseType: 'arraybuffer',
        });
        exportBuffer = Buffer.from(exported.data);
        if (exportBuffer.length < 1 || exportBuffer.length > maxGoogleExportBytes) {
          exportBuffer.fill(0);
          return reply.code(413).send({
            status: 'error',
            message: 'Google Workspace exports must be between 1 byte and 10 MB (Google API limit).',
          });
        }
        mimeType = exportFormat.mimeType;
        if (!fileName.toLowerCase().endsWith(exportFormat.extension)) {
          fileName += exportFormat.extension;
        }
      }

      const totalBytes = exportBuffer?.length ?? Number(file.size);
      if (!Number.isSafeInteger(totalBytes) || totalBytes < 1) {
        exportBuffer?.fill(0);
        return reply.code(400).send({
          status: 'error',
          message: 'Google Drive did not provide a valid file size.',
        });
      }

      const transferId = randomBytes(18).toString('hex');
      downloadTransfers.set(transferId, {
        accountId: body.accountId,
        fileId: body.fileId,
        fileName,
        mimeType,
        totalBytes,
        ...(exportBuffer ? { exportBuffer } : {}),
        createdAt: Date.now(),
      });

      return reply.code(201).send({
        status: 'success',
        transfer: { transferId, fileName, mimeType, totalBytes },
        chunkSize: maxDownloadChunkBytes,
      });
    } catch {
      request.log.error('Google Drive download initialization failed.');
      return reply.code(502).send({
        status: 'error',
        message: 'Could not initialize Google Drive download.',
      });
    }
  });

  app.get('/drive/transfers/download/:transferId/chunk', async (request, reply) => {
    const params = request.params as { transferId?: string };
    const query = request.query as { startByte?: string };
    const transfer = params.transferId
      ? downloadTransfers.get(params.transferId)
      : undefined;
    const startByte = Number(query.startByte);

    if (!transfer) {
      return reply.code(404).send({ status: 'error', message: 'Download session was not found.' });
    }
    if (!Number.isSafeInteger(startByte) || startByte < 0 || startByte >= transfer.totalBytes) {
      return reply.code(400).send({ status: 'error', message: 'Invalid download byte offset.' });
    }

    const endByte = Math.min(startByte + maxDownloadChunkBytes - 1, transfer.totalBytes - 1);

    try {
      let chunk: Buffer;
      if (transfer.exportBuffer) {
        chunk = transfer.exportBuffer.subarray(startByte, endByte + 1);
      } else {
        const driveClient = await getDriveClient(transfer.accountId);
        if (!driveClient) {
          return reply.code(404).send({
            status: 'error',
            message: 'Connected Google Drive account was not found.',
          });
        }
        const response = await driveClient.request<ArrayBuffer>({
          url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(transfer.fileId)}?alt=media`,
          method: 'GET',
          responseType: 'arraybuffer',
          headers: { Range: `bytes=${startByte}-${endByte}` },
        });
        chunk = Buffer.from(response.data);
        const expectedLength = endByte - startByte + 1;
        if (
          chunk.length !== expectedLength ||
          (startByte > 0 && response.status !== 206)
        ) {
          chunk.fill(0);
          return reply.code(502).send({
            status: 'error',
            message: 'Google Drive did not return the requested download range.',
          });
        }
      }

      reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Length', String(chunk.length))
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff');
      return reply.send(chunk);
    } catch {
      request.log.error('Google Drive download chunk request failed.');
      return reply.code(502).send({
        status: 'error',
        message: 'Unable to retrieve the next download chunk.',
      });
    }
  });

  app.delete('/drive/transfers/download/:transferId', async (request, reply) => {
    const params = request.params as { transferId?: string };
    const transfer = params.transferId
      ? downloadTransfers.get(params.transferId)
      : undefined;
    if (!transfer) {
      return reply.code(404).send({ status: 'error', message: 'Download session was not found.' });
    }
    transfer.exportBuffer?.fill(0);
    downloadTransfers.delete(params.transferId!);
    return reply.send({ status: 'success' });
  });

  // In-memory resumable upload sessions.
  // Session URLs are sensitive and are never returned to the frontend.
  type UploadTransfer = {
    accountId: string;
    sessionUrl: string;
    fileName: string;
    totalBytes: number;
    uploadedBytes: number;
    paused: boolean;
    cancelled: boolean;
    completed: boolean;
    file?: GoogleDriveFile;
    createdAt: number;
  };

  const uploadTransfers = new Map<string, UploadTransfer>();
  // 8 MiB keeps resumable requests efficient while remaining a 256 KiB multiple.
  // Total file size is bounded by the provider/API and JavaScript safe-integer range.
  const maxChunkBytes = 8 * 1024 * 1024;

  function transferSnapshot(transferId: string, transfer: UploadTransfer) {
    return {
      transferId,
      fileName: transfer.fileName,
      totalBytes: transfer.totalBytes,
      uploadedBytes: transfer.uploadedBytes,
      progress: transfer.totalBytes
        ? Math.min(100, Math.round((transfer.uploadedBytes / transfer.totalBytes) * 100))
        : 0,
      paused: transfer.paused,
      completed: transfer.completed,
      file: transfer.file,
    };
  }

  // Start a Google Drive resumable upload session.
  app.post('/drive/transfers/upload/init', async (request, reply) => {
    const body = request.body as {
      accountId?: string;
      fileName?: string;
      mimeType?: string;
      totalBytes?: number;
      parentId?: string;
    } | null;

    if (
      !body ||
      typeof body.accountId !== 'string' ||
      typeof body.fileName !== 'string' ||
      typeof body.mimeType !== 'string' ||
      (body.parentId !== undefined && typeof body.parentId !== 'string') ||
      !Number.isSafeInteger(body.totalBytes)
    ) {
      return reply.code(400).send({
        status: 'error',
        message: 'accountId, fileName, mimeType and totalBytes are required.',
      });
    }

    const fileName = body.fileName.trim();
    const mimeType = body.mimeType.trim();
    const totalBytes = body.totalBytes as number;
    const parentId = body.parentId?.trim();

    if (
      !fileName ||
      fileName.length > 255 ||
      /[\r\n]/.test(fileName) ||
      !mimeType ||
      mimeType.length > 150 ||
      /[\r\n]/.test(mimeType) ||
      totalBytes < 1
    ) {
      return reply.code(400).send({
        status: 'error',
        message: 'Invalid file details or upload size.',
      });
    }

    if (parentId && !/^[A-Za-z0-9_-]{1,200}$/.test(parentId)) {
      return reply.code(400).send({
        status: 'error',
        message: 'Invalid destination folder ID.',
      });
    }

    try {
      const driveClient = await getDriveClient(body.accountId);

      if (!driveClient) {
        return reply.code(404).send({
          status: 'error',
          message: 'Connected Google Drive account was not found.',
        });
      }

      if (parentId) {
        const parentResponse = await driveClient.request<GoogleDriveFile>({
          url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(parentId)}?fields=id,mimeType,trashed`,
          method: 'GET',
        });

        if (
          parentResponse.data.mimeType !== 'application/vnd.google-apps.folder' ||
          parentResponse.data.trashed
        ) {
          return reply.code(400).send({
            status: 'error',
            message: 'Destination folder was not found.',
          });
        }
      }

      const accessToken = (await driveClient.getAccessToken()).token;

      if (!accessToken) {
        throw new Error('Google access token unavailable.');
      }

      const metadata = {
        name: fileName,
        mimeType,
        ...(parentId ? { parents: [parentId] } : {}),
      };

      const initResponse = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,size,modifiedTime,webViewLink',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': mimeType,
            'X-Upload-Content-Length': String(totalBytes),
          },
          body: JSON.stringify(metadata),
          redirect: 'manual',
        }
      );

      const sessionUrl = initResponse.headers.get('location');

      if (!initResponse.ok || !sessionUrl) {
        throw new Error('Google Drive did not create an upload session.');
      }

      const transferId = randomBytes(18).toString('hex');

      uploadTransfers.set(transferId, {
        accountId: body.accountId,
        sessionUrl,
        fileName,
        totalBytes,
        uploadedBytes: 0,
        paused: false,
        cancelled: false,
        completed: false,
        createdAt: Date.now(),
      });

      return reply.code(201).send({
        status: 'success',
        transfer: transferSnapshot(transferId, uploadTransfers.get(transferId)!),
        chunkSize: maxChunkBytes,
      });
    } catch {
      request.log.error('Resumable upload initialization failed.');
      return reply.code(502).send({
        status: 'error',
        message: 'Could not initialize Google Drive upload.',
      });
    }
  });

  // Send one raw binary chunk to Google Drive and record confirmed progress.
  // Legacy Base64 JSON chunks remain accepted for compatibility with older clients.
  app.put('/drive/transfers/:transferId/chunk', async (request, reply) => {
    const params = request.params as { transferId?: string };
    const transferId = params.transferId;
    const transfer = transferId ? uploadTransfers.get(transferId) : undefined;

    if (!transfer || transfer.cancelled) {
      return reply.code(404).send({
        status: 'error',
        message: 'Upload transfer was not found.',
      });
    }

    if (transfer.completed) {
      return reply.send({
        status: 'success',
        transfer: transferSnapshot(transferId!, transfer),
      });
    }

    if (transfer.paused) {
      return reply.code(409).send({
        status: 'error',
        message: 'Transfer is paused.',
        transfer: transferSnapshot(transferId!, transfer),
      });
    }

    let startByte: number;
    let chunk: Buffer;

    if (Buffer.isBuffer(request.body)) {
      const header = request.headers['x-start-byte'];
      startByte = typeof header === 'string' ? Number(header) : Number.NaN;
      chunk = request.body;
    } else {
      const body = request.body as {
        startByte?: number;
        chunkBase64?: string;
      } | null;

      if (
        !body ||
        !Number.isSafeInteger(body.startByte) ||
        typeof body.chunkBase64 !== 'string' ||
        !body.chunkBase64 ||
        body.chunkBase64.length > Math.ceil(maxChunkBytes / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.chunkBase64)
      ) {
        return reply.code(400).send({
          status: 'error',
          message: 'Invalid upload chunk.',
        });
      }

      startByte = body.startByte!;
      chunk = Buffer.from(body.chunkBase64, 'base64');
    }

    if (!Number.isSafeInteger(startByte) || startByte !== transfer.uploadedBytes) {
      if (!Buffer.isBuffer(request.body)) chunk.fill(0);
      return reply.code(409).send({
        status: 'error',
        message: 'Chunk offset does not match confirmed upload progress.',
        transfer: transferSnapshot(transferId!, transfer),
      });
    }

    const endByte = startByte + chunk.length - 1;
    const isFinalChunk = endByte + 1 === transfer.totalBytes;

    if (
      chunk.length === 0 ||
      chunk.length > maxChunkBytes ||
      !Number.isSafeInteger(endByte) ||
      endByte >= transfer.totalBytes ||
      (!isFinalChunk && chunk.length % (256 * 1024) !== 0)
    ) {
      chunk.fill(0);
      return reply.code(400).send({
        status: 'error',
        message: 'Invalid chunk size or byte range.',
      });
    }

    try {
      const chunkResponse = await fetch(transfer.sessionUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(chunk.length),
          'Content-Range': `bytes ${startByte}-${endByte}/${transfer.totalBytes}`,
        },
        body: new Uint8Array(chunk),
        redirect: 'manual',
      });

      chunk.fill(0);

      if (chunkResponse.status === 308) {
        const range = chunkResponse.headers.get('range');
        const match = range?.match(/bytes=0-(\d+)/);
        const confirmedBytes = match ? Number(match[1]) + 1 : 0;

        if (
          !Number.isSafeInteger(confirmedBytes) ||
          confirmedBytes <= transfer.uploadedBytes ||
          confirmedBytes > transfer.totalBytes
        ) {
          return reply.code(502).send({
            status: 'error',
            message: 'Google Drive did not confirm upload progress.',
          });
        }

        transfer.uploadedBytes = confirmedBytes;

        return reply.send({
          status: 'success',
          transfer: transferSnapshot(transferId!, transfer),
        });
      }

      if (chunkResponse.status === 200 || chunkResponse.status === 201) {
        const uploadedFile = await chunkResponse.json() as GoogleDriveFile;

        if (!uploadedFile.id) {
          return reply.code(502).send({
            status: 'error',
            message: 'Google Drive did not return the uploaded file ID.',
          });
        }

        transfer.uploadedBytes = transfer.totalBytes;
        transfer.completed = true;
        transfer.file = uploadedFile;

        return reply.send({
          status: 'success',
          transfer: transferSnapshot(transferId!, transfer),
        });
      }

      request.log.error(
        `Google Drive chunk upload returned HTTP ${chunkResponse.status}.`
      );

      return reply.code(502).send({
        status: 'error',
        message: 'Google Drive did not accept the upload chunk.',
      });
    } catch {
      chunk.fill(0);
      request.log.error('Resumable upload chunk request failed.');
      return reply.code(502).send({
        status: 'error',
        message: 'Upload chunk failed. Check transfer status before retrying.',
      });
    }
  });

  // Read the current confirmed upload progress.
  app.get('/drive/transfers/:transferId', async (request, reply) => {
    const params = request.params as { transferId?: string };
    const transferId = params.transferId;
    const transfer = transferId ? uploadTransfers.get(transferId) : undefined;

    if (!transfer) {
      return reply.code(404).send({
        status: 'error',
        message: 'Transfer was not found.',
      });
    }

    return reply.send({
      status: 'success',
      transfer: transferSnapshot(transferId!, transfer),
    });
  });

  // Pause means no further chunks will be accepted until resumed.
  app.post('/drive/transfers/:transferId/pause', async (request, reply) => {
    const params = request.params as { transferId?: string };
    const transfer = params.transferId
      ? uploadTransfers.get(params.transferId)
      : undefined;

    if (!transfer || transfer.completed || transfer.cancelled) {
      return reply.code(404).send({
        status: 'error',
        message: 'Active transfer was not found.',
      });
    }

    transfer.paused = true;

    return reply.send({
      status: 'success',
      transfer: transferSnapshot(params.transferId!, transfer),
    });
  });

  // Resume the session without restarting already confirmed chunks.
  app.post('/drive/transfers/:transferId/resume', async (request, reply) => {
    const params = request.params as { transferId?: string };
    const transfer = params.transferId
      ? uploadTransfers.get(params.transferId)
      : undefined;

    if (!transfer || transfer.completed || transfer.cancelled) {
      return reply.code(404).send({
        status: 'error',
        message: 'Active transfer was not found.',
      });
    }

    transfer.paused = false;

    return reply.send({
      status: 'success',
      transfer: transferSnapshot(params.transferId!, transfer),
    });
  });

  // Cancel the Google resumable upload session.
  app.post('/drive/transfers/:transferId/cancel', async (request, reply) => {
    const params = request.params as { transferId?: string };
    const transferId = params.transferId;
    const transfer = transferId ? uploadTransfers.get(transferId) : undefined;

    if (!transfer) {
      return reply.code(404).send({
        status: 'error',
        message: 'Transfer was not found.',
      });
    }

    if (!transfer.completed) {
      transfer.cancelled = true;

      try {
        await fetch(transfer.sessionUrl, {
          method: 'DELETE',
          redirect: 'manual',
        });
      } catch {
        request.log.warn('Google Drive upload session cancellation could not be confirmed.');
      }
    }

    uploadTransfers.delete(transferId!);

    return reply.send({
      status: 'success',
      message: 'Transfer cancelled.',
    });
  });

  app.log.info(
    'Google OAuth, Drive listing, file preview and upload routes enabled.'
  );
} else {
  app.log.info(
    'Google OAuth disabled because OAuth configuration or encryption key is unavailable.'
  );
}

app.get('/mega/files', async (request, reply) => {
  const query = request.query as {
    accountId?: string;
    parentId?: string;
    pageToken?: string;
    pageSize?: string;
  };

  if (!query.accountId) {
    return reply.code(400).send({
      status: 'error',
      message: 'accountId is required.',
    });
  }

  if (query.parentId && !/^[A-Za-z0-9_-]{1,200}$/.test(query.parentId)) {
    return reply.code(400).send({
      status: 'error',
      message: 'Invalid parent folder ID.',
    });
  }

  const pageSize = Math.min(Math.max(Number(query.pageSize) || 100, 1), 1000);

  try {
    const adapter = getMegaAdapter(query.accountId);
    const result = await adapter.listFiles(query.accountId, {
      parentId: query.parentId,
      pageToken: query.pageToken,
      pageSize,
    });

    return reply.send({
      status: 'success',
      accountId: query.accountId,
      files: result.files.map((file) => ({
        id: file.remoteObjectId,
        name: file.name,
        size: file.sizeBytes,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedAt,
        parents: file.parentId ? [file.parentId] : [],
        isFolder: file.isFolder,
      })),
      nextPageToken: result.nextPageToken ?? null,
    });
  } catch (error) {
    const rawCode = error instanceof Error ? error.message : '';
    const diagnosticCode = /^MEGA_SESSION_RESTORE_FAILED:(decrypt|parse|validate|storage_init|storage_ready|storage_reload)(?::(SESSION_EXPIRED|RATE_LIMIT|TEMPORARY_API_ERROR|ACCOUNT_BLOCKED|QUOTA_EXCEEDED|NETWORK_ERROR|UNKNOWN_ERROR))?$/.test(rawCode)
      ? rawCode
      : 'MEGA_OPERATION_FAILED';
    request.log.error({ diagnosticCode }, 'MEGA file listing failed.');
    return reply.code(502).send({
      status: 'error',
      message: 'Unable to load MEGA files.',
      diagnosticCode,
    });
  }
});

app.get('/mega/quota', async (request, reply) => {
  const query = request.query as { accountId?: string };

  if (!query.accountId) {
    return reply.code(400).send({
      status: 'error',
      message: 'accountId is required.',
    });
  }

  try {
    const adapter = getMegaAdapter(query.accountId);
    const quota = await adapter.getQuota(query.accountId);

    return reply.send({
      status: 'success',
      accountId: query.accountId,
      quota,
    });
  } catch (error) {
    const rawCode = error instanceof Error ? error.message : '';
    const diagnosticCode = /^MEGA_SESSION_RESTORE_FAILED:(decrypt|parse|validate|storage_init|storage_ready|storage_reload)(?::(SESSION_EXPIRED|RATE_LIMIT|TEMPORARY_API_ERROR|ACCOUNT_BLOCKED|QUOTA_EXCEEDED|NETWORK_ERROR|UNKNOWN_ERROR))?$/.test(rawCode)
      ? rawCode
      : 'MEGA_OPERATION_FAILED';
    request.log.error({ diagnosticCode }, 'MEGA quota lookup failed.');
    return reply.code(502).send({
      status: 'error',
      message: 'Unable to load MEGA storage quota.',
      diagnosticCode,
    });
  }
});

app.post('/mega/folders', async (request, reply) => {
  const body = request.body as {
    accountId?: string;
    name?: string;
    parentId?: string;
  } | null;

  if (
    !body ||
    typeof body.accountId !== 'string' ||
    typeof body.name !== 'string'
  ) {
    return reply.code(400).send({
      status: 'error',
      message: 'accountId and folder name are required.',
    });
  }

  const name = body.name.trim();
  const parentId = body.parentId?.trim();

  if (!name || name.length > 255 || /[\r\n]/.test(name)) {
    return reply.code(400).send({
      status: 'error',
      message: 'Invalid folder name.',
    });
  }

  if (parentId && !/^[A-Za-z0-9_-]{1,200}$/.test(parentId)) {
    return reply.code(400).send({
      status: 'error',
      message: 'Invalid parent folder ID.',
    });
  }

  try {
    const adapter = getMegaAdapter(body.accountId);
    const folder = await adapter.createFolder(body.accountId, {
      name,
      parentId,
    });

    return reply.code(201).send({
      status: 'success',
      folder: {
        id: folder.remoteObjectId,
        name: folder.name,
        isFolder: folder.isFolder,
        parents: folder.parentId ? [folder.parentId] : [],
      },
    });
  } catch {
    request.log.error('MEGA folder creation failed.');
    return reply.code(502).send({
      status: 'error',
      message: 'Unable to create MEGA folder.',
    });
  }
});

app.delete('/mega/files/:fileId', async (request, reply) => {
  const params = request.params as { fileId?: string };
  const query = request.query as { accountId?: string };

  if (
    !query.accountId ||
    !params.fileId ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(params.fileId)
  ) {
    return reply.code(400).send({
      status: 'error',
      message: 'Valid accountId and fileId are required.',
    });
  }

  try {
    const adapter = getMegaAdapter(query.accountId);
    await adapter.delete(query.accountId, params.fileId);

    return reply.send({
      status: 'success',
      fileId: params.fileId,
    });
  } catch {
    request.log.error('MEGA file deletion failed.');
    return reply.code(502).send({
      status: 'error',
      message: 'Unable to delete MEGA file.',
    });
  }
});

// MEGA preview and chunked download sessions.
type MegaDownloadTransfer = {
  accountId: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  totalBytes: number;
  createdAt: number;
};

const megaDownloadTransfers = new Map<string, MegaDownloadTransfer>();
const maxMegaPreviewBytes = 50 * 1024 * 1024;
const maxMegaDownloadChunkBytes = 8 * 1024 * 1024;

function getMegaMimeType(fileName: string): string {
  const extension = fileName.toLowerCase().split('.').pop() ?? '';
  const mimeTypes: Record<string, string> = {
    pdf: 'application/pdf',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    xml: 'application/xml',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    ts: 'text/plain',
    md: 'text/markdown',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    zip: 'application/zip',
    rar: 'application/vnd.rar',
    '7z': 'application/x-7z-compressed',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return mimeTypes[extension] ?? 'application/octet-stream';
}

async function collectMegaDownload(
  accountId: string,
  fileId: string,
  startByte: number,
  endByte: number,
  expectedBytes: number,
): Promise<Buffer> {
  const adapter = getMegaAdapter(accountId);
  const stream = await adapter.download(accountId, fileId, { startByte, endByte });
  const parts: Buffer[] = [];
  let receivedBytes = 0;

  for await (const part of stream) {
    const chunk = Buffer.from(part);
    receivedBytes += chunk.length;
    if (receivedBytes > expectedBytes) {
      chunk.fill(0);
      for (const existing of parts) existing.fill(0);
      throw new Error('MEGA returned more data than the requested byte range.');
    }
    parts.push(chunk);
  }

  if (receivedBytes !== expectedBytes) {
    for (const existing of parts) existing.fill(0);
    throw new Error('MEGA did not return the complete requested byte range.');
  }

  return Buffer.concat(parts, expectedBytes);
}

app.get('/mega/files/:fileId/content', async (request, reply) => {
  const params = request.params as { fileId?: string };
  const query = request.query as { accountId?: string };
  const fileId = params.fileId;
  const accountId = query.accountId;

  if (
    !accountId ||
    !fileId ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(fileId)
  ) {
    return reply.code(400).send({
      status: 'error',
      message: 'A valid accountId and fileId are required.',
    });
  }

  let fileBuffer: Buffer | undefined;
  try {
    const adapter = getMegaAdapter(accountId);
    const file = await adapter.getFileMetadata(accountId, fileId);

    if (file.isFolder) {
      return reply.code(400).send({
        status: 'error',
        message: 'Folders cannot be opened as files.',
      });
    }

    const totalBytes = Number(file.sizeBytes);
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 1) {
      return reply.code(400).send({
        status: 'error',
        message: 'MEGA did not provide a valid file size.',
      });
    }
    if (totalBytes > maxMegaPreviewBytes) {
      return reply.code(413).send({
        status: 'error',
        message: 'This file is larger than the 50 MB preview limit.',
      });
    }

    fileBuffer = await collectMegaDownload(
      accountId,
      fileId,
      0,
      totalBytes - 1,
      totalBytes,
    );

    const safeName = file.name.replace(/[\r\n"]/g, '_').slice(0, 255);
    reply
      .header('Content-Type', getMegaMimeType(safeName))
      .header('Content-Length', String(fileBuffer.length))
      .header(
        'Content-Disposition',
        `inline; filename="preview"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      )
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff');

    return reply.send(fileBuffer);
  } catch {
    fileBuffer?.fill(0);
    request.log.error('MEGA file preview request failed.');
    return reply.code(502).send({
      status: 'error',
      message: 'Unable to retrieve this file from MEGA.',
    });
  }
});

app.post('/mega/transfers/download/init', async (request, reply) => {
  const body = request.body as { accountId?: string; fileId?: string } | null;

  if (
    !body ||
    typeof body.accountId !== 'string' ||
    typeof body.fileId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(body.fileId)
  ) {
    return reply.code(400).send({
      status: 'error',
      message: 'A valid accountId and fileId are required.',
    });
  }

  try {
    for (const [id, stale] of megaDownloadTransfers) {
      if (Date.now() - stale.createdAt > 30 * 60 * 1000) {
        megaDownloadTransfers.delete(id);
      }
    }

    const adapter = getMegaAdapter(body.accountId);
    const file = await adapter.getFileMetadata(body.accountId, body.fileId);

    if (file.isFolder) {
      return reply.code(400).send({
        status: 'error',
        message: 'Folders cannot be downloaded as files.',
      });
    }

    const totalBytes = Number(file.sizeBytes);
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 1) {
      return reply.code(400).send({
        status: 'error',
        message: 'MEGA did not provide a valid file size.',
      });
    }

    const transferId = randomBytes(18).toString('hex');
    const fileName = file.name || 'download';
    const mimeType = getMegaMimeType(fileName);

    megaDownloadTransfers.set(transferId, {
      accountId: body.accountId,
      fileId: body.fileId,
      fileName,
      mimeType,
      totalBytes,
      createdAt: Date.now(),
    });

    return reply.code(201).send({
      status: 'success',
      transfer: { transferId, fileName, mimeType, totalBytes },
      chunkSize: maxMegaDownloadChunkBytes,
    });
  } catch {
    request.log.error('MEGA download initialization failed.');
    return reply.code(502).send({
      status: 'error',
      message: 'Could not initialize MEGA download.',
    });
  }
});

app.get('/mega/transfers/download/:transferId/chunk', async (request, reply) => {
  const params = request.params as { transferId?: string };
  const query = request.query as { startByte?: string };
  const transfer = params.transferId
    ? megaDownloadTransfers.get(params.transferId)
    : undefined;
  const startByte = Number(query.startByte);

  if (!transfer) {
    return reply.code(404).send({
      status: 'error',
      message: 'MEGA download session was not found.',
    });
  }
  if (
    !Number.isSafeInteger(startByte) ||
    startByte < 0 ||
    startByte >= transfer.totalBytes
  ) {
    return reply.code(400).send({
      status: 'error',
      message: 'Invalid download byte offset.',
    });
  }

  const endByte = Math.min(
    startByte + maxMegaDownloadChunkBytes - 1,
    transfer.totalBytes - 1,
  );
  const expectedBytes = endByte - startByte + 1;
  let chunk: Buffer | undefined;

  try {
    chunk = await collectMegaDownload(
      transfer.accountId,
      transfer.fileId,
      startByte,
      endByte,
      expectedBytes,
    );

    reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', String(chunk.length))
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff');

    return reply.send(chunk);
  } catch {
    chunk?.fill(0);
    request.log.error('MEGA download chunk request failed.');
    return reply.code(502).send({
      status: 'error',
      message: 'Unable to retrieve the next MEGA download chunk.',
    });
  }
});

app.delete('/mega/transfers/download/:transferId', async (request, reply) => {
  const params = request.params as { transferId?: string };
  const transfer = params.transferId
    ? megaDownloadTransfers.get(params.transferId)
    : undefined;

  if (!transfer) {
    return reply.code(404).send({
      status: 'error',
      message: 'MEGA download session was not found.',
    });
  }

  megaDownloadTransfers.delete(params.transferId!);
  return reply.send({ status: 'success' });
});



// MEGA upload sessions stream incoming chunks directly into the existing
// megajs adapter. The application does not buffer whole files in memory.

function megaUploadSnapshot(transferId: string, transfer: MegaUploadTransfer) {
  return {
    transferId,
    fileName: transfer.fileName,
    totalBytes: transfer.totalBytes,
    receivedBytes: transfer.receivedBytes,
    uploadedBytes: transfer.uploadedBytes,
    progress: transfer.completed
      ? 100
      : transfer.totalBytes
        ? Math.min(99, Math.round((transfer.uploadedBytes / transfer.totalBytes) * 100))
        : 0,
    paused: transfer.paused,
    completed: transfer.completed,
    file: transfer.file
      ? {
          id: transfer.file.remoteObjectId,
          name: transfer.file.name,
          mimeType: transfer.file.mimeType,
          size: transfer.file.sizeBytes,
          parents: transfer.file.parentId ? [transfer.file.parentId] : [],
        }
      : undefined,
  };
}

app.post('/mega/transfers/upload/init', async (request, reply) => {
  const body = request.body as {
    accountId?: string;
    fileName?: string;
    mimeType?: string;
    totalBytes?: number;
    parentId?: string;
  } | null;

  if (
    !body ||
    typeof body.accountId !== 'string' ||
    typeof body.fileName !== 'string' ||
    typeof body.mimeType !== 'string' ||
    (body.parentId !== undefined && typeof body.parentId !== 'string') ||
    !Number.isSafeInteger(body.totalBytes)
  ) {
    return reply.code(400).send({
      status: 'error',
      message: 'accountId, fileName, mimeType and totalBytes are required.',
    });
  }

  const fileName = body.fileName.trim();
  const mimeType = body.mimeType.trim();
  const totalBytes = body.totalBytes as number;
  const parentId = body.parentId?.trim();

  if (
    !fileName ||
    fileName.length > 255 ||
    /[\r\n]/.test(fileName) ||
    !mimeType ||
    mimeType.length > 150 ||
    /[\r\n]/.test(mimeType) ||
    totalBytes < 1 ||
    (parentId && !/^[A-Za-z0-9_-]{1,200}$/.test(parentId))
  ) {
    return reply.code(400).send({
      status: 'error',
      message: 'Invalid file details or destination folder.',
    });
  }

  try {
    for (const [id, stale] of megaUploadTransfers) {
      if (Date.now() - stale.createdAt > 30 * 60 * 1000) {
        if (!stale.completed) {
          stale.cancelled = true;
          stale.stream.destroy(new Error('MEGA upload session expired.'));
        }
        megaUploadTransfers.delete(id);
      }
    }

    const adapter = getMegaAdapter(body.accountId);
    await adapter.connect(body.accountId);

    if (parentId) {
      const parent = await adapter.getFileMetadata(body.accountId, parentId);
      if (!parent.isFolder) {
        return reply.code(400).send({
          status: 'error',
          message: 'Destination folder was not found.',
        });
      }
    }

    const stream = new PassThrough({ highWaterMark: 1024 * 1024 });
    const transferId = randomBytes(18).toString('hex');

    const transfer: MegaUploadTransfer = {
      accountId: body.accountId,
      fileName,
      totalBytes,
      receivedBytes: 0,
      uploadedBytes: 0,
      paused: false,
      cancelled: false,
      completed: false,
      stream,
      uploadPromise: Promise.resolve(undefined as unknown as RemoteFile),
      createdAt: Date.now(),
    };

    transfer.uploadPromise = adapter.upload(body.accountId, {
      fileName,
      mimeType,
      sizeBytes: String(totalBytes),
      ...(parentId ? { parentId } : {}),
      data: stream,
      onProgress: (bytesUploaded, bytesTotal) => {
        if (
          Number.isSafeInteger(bytesUploaded) &&
          bytesUploaded >= 0 &&
          Number.isSafeInteger(bytesTotal) &&
          bytesTotal === totalBytes
        ) {
          transfer.uploadedBytes = Math.min(bytesUploaded, totalBytes);
        }
      },
    }).then((file) => {
      transfer.completed = true;
      transfer.uploadedBytes = totalBytes;
      transfer.file = file;
      return file;
    }).catch((error: unknown) => {
      throw error;
    });

    // Attach a handler immediately so cancellation/expiry cannot create an
    // unhandled rejection while the client is no longer waiting on the session.
    void transfer.uploadPromise.catch(() => undefined);
    megaUploadTransfers.set(transferId, transfer);

    return reply.code(201).send({
      status: 'success',
      transfer: megaUploadSnapshot(transferId, transfer),
      chunkSize: maxUploadChunkBytes,
    });
  } catch {
    request.log.error('MEGA upload initialization failed.');
    return reply.code(502).send({
      status: 'error',
      message: 'Could not initialize MEGA upload.',
    });
  }
});

app.put('/mega/transfers/:transferId/chunk', async (request, reply) => {
  const params = request.params as { transferId?: string };
  const transferId = params.transferId;
  const transfer = transferId ? megaUploadTransfers.get(transferId) : undefined;

  if (!transfer || transfer.cancelled) {
    return reply.code(404).send({
      status: 'error',
      message: 'MEGA upload transfer was not found.',
    });
  }

  if (transfer.completed) {
    return reply.send({
      status: 'success',
      transfer: megaUploadSnapshot(transferId!, transfer),
    });
  }

  if (transfer.paused) {
    return reply.code(409).send({
      status: 'error',
      message: 'Transfer is paused.',
      transfer: megaUploadSnapshot(transferId!, transfer),
    });
  }

  let startByte: number;
  let chunk: Buffer;

  if (Buffer.isBuffer(request.body)) {
    const header = request.headers['x-start-byte'];
    startByte = typeof header === 'string' ? Number(header) : Number.NaN;
    chunk = request.body;
  } else {
    const body = request.body as {
      startByte?: number;
      chunkBase64?: string;
    } | null;

    if (
      !body ||
      !Number.isSafeInteger(body.startByte) ||
      typeof body.chunkBase64 !== 'string' ||
      !body.chunkBase64 ||
      body.chunkBase64.length > Math.ceil(maxUploadChunkBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.chunkBase64)
    ) {
      return reply.code(400).send({
        status: 'error',
        message: 'Invalid MEGA upload chunk.',
      });
    }

    startByte = body.startByte!;
    chunk = Buffer.from(body.chunkBase64, 'base64');
  }

  const endByte = startByte + chunk.length - 1;
  const isFinalChunk = endByte + 1 === transfer.totalBytes;

  if (
    !Number.isSafeInteger(startByte) ||
    startByte !== transfer.receivedBytes ||
    chunk.length < 1 ||
    chunk.length > maxUploadChunkBytes ||
    !Number.isSafeInteger(endByte) ||
    endByte >= transfer.totalBytes
  ) {
    if (!Buffer.isBuffer(request.body)) chunk.fill(0);
    return reply.code(409).send({
      status: 'error',
      message: 'Invalid chunk size or byte offset.',
      transfer: megaUploadSnapshot(transferId!, transfer),
    });
  }

  try {
    const canContinue = transfer.stream.write(chunk);
    transfer.receivedBytes += chunk.length;

    if (!canContinue) {
      await once(transfer.stream, 'drain');
    }

    if (isFinalChunk) {
      if (transfer.receivedBytes !== transfer.totalBytes) {
        transfer.stream.destroy(new Error('MEGA upload size mismatch.'));
        return reply.code(400).send({
          status: 'error',
          message: 'Upload size does not match the declared file size.',
        });
      }

      transfer.stream.end();

      try {
        await transfer.uploadPromise;
      } catch {
        request.log.error('MEGA upload stream failed.');
        megaUploadTransfers.delete(transferId!);
        return reply.code(502).send({
          status: 'error',
          message: 'MEGA did not complete the upload.',
        });
      }
    }

    return reply.send({
      status: 'success',
      transfer: megaUploadSnapshot(transferId!, transfer),
    });
  } catch {
    request.log.error('MEGA upload chunk could not be streamed.');
    transfer.stream.destroy();
    megaUploadTransfers.delete(transferId!);
    return reply.code(502).send({
      status: 'error',
      message: 'MEGA upload chunk failed.',
    });
  }
});

app.get('/mega/transfers/:transferId', async (request, reply) => {
  const params = request.params as { transferId?: string };
  const transfer = params.transferId
    ? megaUploadTransfers.get(params.transferId)
    : undefined;

  if (!transfer) {
    return reply.code(404).send({
      status: 'error',
      message: 'MEGA upload transfer was not found.',
    });
  }

  return reply.send({
    status: 'success',
    transfer: megaUploadSnapshot(params.transferId!, transfer),
  });
});

app.post('/mega/transfers/:transferId/pause', async (request, reply) => {
  const params = request.params as { transferId?: string };
  const transfer = params.transferId
    ? megaUploadTransfers.get(params.transferId)
    : undefined;

  if (!transfer || transfer.completed || transfer.cancelled) {
    return reply.code(404).send({
      status: 'error',
      message: 'Active MEGA upload was not found.',
    });
  }

  transfer.paused = true;
  return reply.send({
    status: 'success',
    transfer: megaUploadSnapshot(params.transferId!, transfer),
  });
});

app.post('/mega/transfers/:transferId/resume', async (request, reply) => {
  const params = request.params as { transferId?: string };
  const transfer = params.transferId
    ? megaUploadTransfers.get(params.transferId)
    : undefined;

  if (!transfer || transfer.completed || transfer.cancelled) {
    return reply.code(404).send({
      status: 'error',
      message: 'Active MEGA upload was not found.',
    });
  }

  transfer.paused = false;
  return reply.send({
    status: 'success',
    transfer: megaUploadSnapshot(params.transferId!, transfer),
  });
});

app.post('/mega/transfers/:transferId/cancel', async (request, reply) => {
  const params = request.params as { transferId?: string };
  const transferId = params.transferId;
  const transfer = transferId ? megaUploadTransfers.get(transferId) : undefined;

  if (!transfer) {
    return reply.code(404).send({
      status: 'error',
      message: 'MEGA upload transfer was not found.',
    });
  }

  if (!transfer.completed) {
    transfer.cancelled = true;
    transfer.paused = false;
    transfer.stream.destroy(new Error('MEGA upload cancelled.'));
    await transfer.uploadPromise.catch(() => undefined);
  }

  megaUploadTransfers.delete(transferId!);
  return reply.send({ status: 'success', message: 'Transfer cancelled.' });
});



const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);

process.once('SIGINT', () => {
  void app.close();
});

process.once('SIGTERM', () => {
  void app.close();
});

await app.listen({
  host: process.env.HOST ?? '127.0.0.1',
  port,
});










