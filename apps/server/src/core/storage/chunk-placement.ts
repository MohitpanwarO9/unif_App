import { randomUUID } from 'node:crypto';
import type { CloudProvider } from './chunk-types.js';

export interface StorageAccount {
  accountId: string;
  provider: CloudProvider;
  freeBytes: string;
  connected: boolean;
  enabled: boolean;
}

export interface PlannedChunk {
  chunkId: string;
  sequence: number;
  sizeBytes: string;
  accountId: string;
  provider: CloudProvider;
}

export interface PlacementPlan {
  strategy: 'SINGLE_ACCOUNT' | 'DISTRIBUTED';
  totalSizeBytes: string;
  totalChunks: number;
  chunks: PlannedChunk[];
}

function parseBytes(value: string, field: string): bigint {
  if (
    typeof value !== 'string' ||
    !/^\d+$/.test(value)
  ) {
    throw new Error(`Invalid ${field}.`);
  }

  return BigInt(value);
}

export function planChunkPlacement(
  fileSizeBytes: string,
  chunkSizeBytes: string,
  accounts: StorageAccount[],
): PlacementPlan {
  const fileSize = parseBytes(fileSizeBytes, 'file size');
  const chunkSize = parseBytes(chunkSizeBytes, 'chunk size');

  if (fileSize <= 0n || chunkSize <= 0n) {
    throw new Error('File size and chunk size must be positive.');
  }

  const eligibleAccounts = accounts
    .filter(
      (account) =>
        account.connected &&
        account.enabled &&
        account.accountId.trim().length > 0,
    )
    .map((account) => ({
      ...account,
      remaining: parseBytes(account.freeBytes, 'account free space'),
    }))
    .filter((account) => account.remaining > 0n)
    .sort((a, b) => {
      if (a.remaining > b.remaining) return -1;
      if (a.remaining < b.remaining) return 1;
      return a.accountId.localeCompare(b.accountId);
    });

  if (eligibleAccounts.length === 0) {
    throw new Error('Drives are full');
  }

  const combinedCapacity = eligibleAccounts.reduce(
    (total, account) => total + account.remaining,
    0n,
  );

  if (combinedCapacity < fileSize) {
    throw new Error('Drives are full');
  }

  // Prefer one account whenever it can store the complete file.
  // A single-account file is represented by one complete object.
  const singleAccount = eligibleAccounts.find(
    (account) => account.remaining >= fileSize,
  );

  if (singleAccount) {
    return {
      strategy: 'SINGLE_ACCOUNT',
      totalSizeBytes: fileSize.toString(),
      totalChunks: 1,
      chunks: [
        {
          chunkId: randomUUID(),
          sequence: 0,
          sizeBytes: fileSize.toString(),
          accountId: singleAccount.accountId,
          provider: singleAccount.provider,
        },
      ],
    };
  }

  // Distributed placement:
  // Each chunk is limited by both the configured chunk size
  // and the remaining capacity of its selected account.
  const chunks: PlannedChunk[] = [];
  let remainingFileSize = fileSize;
  let sequence = 0;

  while (remainingFileSize > 0n) {
    const account = eligibleAccounts.find(
      (item) => item.remaining > 0n,
    );

    if (!account) {
      throw new Error('Drives are full');
    }

    const chunkBytes =
      remainingFileSize < chunkSize
        ? remainingFileSize
        : chunkSize;

    const actualChunkBytes =
      chunkBytes < account.remaining
        ? chunkBytes
        : account.remaining;

    if (actualChunkBytes <= 0n) {
      throw new Error('Drives are full');
    }

    chunks.push({
      chunkId: randomUUID(),
      sequence,
      sizeBytes: actualChunkBytes.toString(),
      accountId: account.accountId,
      provider: account.provider,
    });

    account.remaining -= actualChunkBytes;
    remainingFileSize -= actualChunkBytes;
    sequence++;

    if (!Number.isSafeInteger(sequence)) {
      throw new Error('File requires too many chunks.');
    }
  }

  return {
    strategy: 'DISTRIBUTED',
    totalSizeBytes: fileSize.toString(),
    totalChunks: chunks.length,
    chunks,
  };
}