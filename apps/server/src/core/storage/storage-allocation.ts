
import type { CloudProvider } from './chunk-types.js';
import { planChunkPlacement } from './chunk-placement.js';

export interface QuotaAdapter {
  getQuota(accountId: string): Promise<{
    totalBytes: string;
    usedBytes: string;
    freeBytes: string;
  }>;
}

export interface ConnectedStorageAccount {
  id: string;
  provider: CloudProvider;
  displayLabel: string;
  status: string;
}

export interface StorageAdapters {
  googleDrive: QuotaAdapter;
  mega: QuotaAdapter;
}

export async function createStorageAllocation(
  fileSizeBytes: string,
  accounts: ConnectedStorageAccount[],
  adapters: StorageAdapters,
) {
  const quotaResults = await Promise.all(
    accounts
      .filter(
        (account) =>
          account.status === 'CONNECTED' &&
          (account.provider === 'GOOGLE_DRIVE' ||
            account.provider === 'MEGA'),
      )
      .map(async (account) => {
        try {
          const adapter =
            account.provider === 'GOOGLE_DRIVE'
              ? adapters.googleDrive
              : adapters.mega;

          const quota = await adapter.getQuota(account.id);
          const freeBytes = BigInt(quota.freeBytes);

          if (freeBytes < 0n) {
            throw new Error('Invalid provider quota.');
          }

          return {
            account,
            freeBytes: freeBytes.toString(),
            available: true,
          };
        } catch {
          return {
            account,
            freeBytes: '0',
            available: false,
          };
        }
      }),
  );

  const plannerAccounts = quotaResults.map((item) => ({
    accountId: item.account.id,
    provider: item.account.provider,
    freeBytes: item.freeBytes,
    connected: item.account.status === 'CONNECTED',
    enabled: item.available,
  }));

  const combinedFreeBytes = plannerAccounts.reduce(
    (sum, account) => sum + BigInt(account.freeBytes),
    0n,
  );

  if (combinedFreeBytes < BigInt(fileSizeBytes)) {
    throw new Error('Drives are full');
  }

  const plan = planChunkPlacement(
    fileSizeBytes,
    String(8 * 1024 * 1024),
    plannerAccounts,
  );

  return {
    strategy: plan.strategy,
    totalSizeBytes: plan.totalSizeBytes,
    totalChunks: plan.totalChunks,
    chunks: plan.chunks,
    combinedFreeBytes: combinedFreeBytes.toString(),
    accounts: quotaResults.map((item) => ({
      accountId: item.account.id,
      provider: item.account.provider,
      displayLabel: item.account.displayLabel,
      quotaAvailable: item.available,
      freeBytes: item.freeBytes,
    })),
  };
}
