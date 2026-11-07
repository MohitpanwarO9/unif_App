import test from 'node:test';
import assert from 'node:assert/strict';

import { planChunkPlacement } from './chunk-placement.js';

const MB = 1024n * 1024n;

test('single account stores the entire file as one object', () => {
  const plan = planChunkPlacement(
    (10n * MB).toString(),
    (8n * MB).toString(),
    [
      {
        accountId: 'drive-1',
        provider: 'GOOGLE_DRIVE',
        freeBytes: (20n * MB).toString(),
        connected: true,
        enabled: true,
      },
    ],
  );

  assert.equal(plan.strategy, 'SINGLE_ACCOUNT');
  assert.equal(plan.totalChunks, 1);
  assert.equal(plan.chunks[0].sizeBytes, (10n * MB).toString());
});

test('distributes a file across multiple accounts', () => {
  const plan = planChunkPlacement(
    (16n * MB).toString(),
    (8n * MB).toString(),
    [
      {
        accountId: 'drive-1',
        provider: 'GOOGLE_DRIVE',
        freeBytes: (8n * MB).toString(),
        connected: true,
        enabled: true,
      },
      {
        accountId: 'mega-1',
        provider: 'MEGA',
        freeBytes: (8n * MB).toString(),
        connected: true,
        enabled: true,
      },
    ],
  );

  assert.equal(plan.strategy, 'DISTRIBUTED');
  assert.equal(plan.totalChunks, 2);

  assert.equal(
    plan.chunks.reduce(
      (sum, chunk) => sum + BigInt(chunk.sizeBytes),
      0n,
    ),
    16n * MB,
  );

  assert.equal(
    new Set(plan.chunks.map((chunk) => chunk.accountId)).size,
    2,
  );
});

test('uses smaller chunks when account capacity is below chunk size', () => {
  const plan = planChunkPlacement(
    (16n * MB).toString(),
    (8n * MB).toString(),
    [
      {
        accountId: 'drive-1',
        provider: 'GOOGLE_DRIVE',
        freeBytes: (3n * MB).toString(),
        connected: true,
        enabled: true,
      },
      {
        accountId: 'mega-1',
        provider: 'MEGA',
        freeBytes: (13n * MB).toString(),
        connected: true,
        enabled: true,
      },
    ],
  );

  const total = plan.chunks.reduce(
    (sum, chunk) => sum + BigInt(chunk.sizeBytes),
    0n,
  );

  assert.equal(total, 16n * MB);
  assert.ok(
    plan.chunks.every(
      (chunk) => BigInt(chunk.sizeBytes) <= 8n * MB,
    ),
  );
});

test('returns Drives are full when combined capacity is insufficient', () => {
  assert.throws(
    () =>
      planChunkPlacement(
        (10n * MB).toString(),
        (8n * MB).toString(),
        [
          {
            accountId: 'drive-1',
            provider: 'GOOGLE_DRIVE',
            freeBytes: (4n * MB).toString(),
            connected: true,
            enabled: true,
          },
          {
            accountId: 'mega-1',
            provider: 'MEGA',
            freeBytes: (5n * MB).toString(),
            connected: true,
            enabled: true,
          },
        ],
      ),
    /Drives are full/,
  );
});

test('ignores disconnected and disabled accounts', () => {
  assert.throws(
    () =>
      planChunkPlacement(
        (10n * MB).toString(),
        (8n * MB).toString(),
        [
          {
            accountId: 'drive-1',
            provider: 'GOOGLE_DRIVE',
            freeBytes: (100n * MB).toString(),
            connected: false,
            enabled: true,
          },
          {
            accountId: 'mega-1',
            provider: 'MEGA',
            freeBytes: (100n * MB).toString(),
            connected: true,
            enabled: false,
          },
        ],
      ),
    /Drives are full/,
  );
});