import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as megajs from 'megajs';

import type {
  CloudProviderAdapter,
  StorageQuota,
  RemoteFile,
  UploadRequest,
  ListFilesRequest,
  ListFilesResult,
  CreateFolderRequest,
  DownloadOptions,
} from '../provider-interface.js';

type MegaStorage = megajs.Storage;
type MegaFile = MegaStorage['root'];

function mapFile(file: MegaFile): RemoteFile {
  const id = file.nodeId;

  if (!id) {
    throw new Error('MEGA file identifier is unavailable.');
  }

  return {
    remoteObjectId: id,
    name: file.name ?? file.label,
    sizeBytes: String(file.size ?? 0),
    mimeType: undefined,
    parentId: file.parent?.nodeId ?? null,
    isFolder: file.directory,
    modifiedAt: file.timestamp
      ? new Date(file.timestamp * 1000).toISOString()
      : undefined,
  };
}

export class MegaAdapter implements CloudProviderAdapter {
  readonly provider = 'MEGA' as const;

  constructor(
    private readonly getStorage: (
      accountId: string,
    ) => Promise<MegaStorage>,
  ) {}

  async connect(accountId: string): Promise<void> {
    await this.getStorage(accountId);
  }

  async disconnect(_accountId: string): Promise<void> {
    // The encrypted session remains stored for the next connection.
  }

  async getQuota(accountId: string): Promise<StorageQuota> {
    const storage = await this.getStorage(accountId);
    const info = await storage.getAccountInfo();

    const total = BigInt(Math.max(0, Math.floor(info.spaceTotal)));
    const used = BigInt(Math.max(0, Math.floor(info.spaceUsed)));

    return {
      totalBytes: total.toString(),
      usedBytes: used.toString(),
      freeBytes: (total > used ? total - used : 0n).toString(),
    };
  }

  async listFiles(
    accountId: string,
    request: ListFilesRequest = {},
  ): Promise<ListFilesResult> {
    const storage = await this.getStorage(accountId);

    if (!storage.root.children) {
      await storage.reload(true);
    }

    let folder = storage.root;

    if (request.parentId) {
      const selected = storage.files[request.parentId];

      if (!selected || !selected.directory) {
        throw new Error('MEGA parent folder was not found.');
      }

      folder = selected;
    }

    const children = folder.children ?? [];
    const pageSize = Math.min(Math.max(request.pageSize ?? 100, 1), 1000);
    const offset = request.pageToken
      ? Number.parseInt(request.pageToken, 10)
      : 0;

    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('Invalid MEGA page token.');
    }

    return {
      files: children.slice(offset, offset + pageSize).map(mapFile),
      nextPageToken:
        offset + pageSize < children.length
          ? String(offset + pageSize)
          : null,
    };
  }

  async createFolder(
    accountId: string,
    request: CreateFolderRequest,
  ): Promise<RemoteFile> {
    const storage = await this.getStorage(accountId);
    const name = request.name.trim();

    if (!name || name.length > 255) {
      throw new Error('Invalid folder name.');
    }

    let parent = storage.root;

    if (request.parentId) {
      const selected = storage.files[request.parentId];

      if (!selected || !selected.directory) {
        throw new Error('MEGA parent folder was not found.');
      }

      parent = selected;
    }

    const folder = await parent.mkdir({ name });
    return mapFile(folder);
  }

  async getFileMetadata(
    accountId: string,
    remoteObjectId: string,
  ): Promise<RemoteFile> {
    const storage = await this.getStorage(accountId);
    let file = storage.files[remoteObjectId];

    if (!file) {
      await storage.reload(true);
      file = storage.files[remoteObjectId];
    }

    if (!file) {
      throw new Error('MEGA file was not found.');
    }

    return mapFile(file);
  }

  async upload(
    accountId: string,
    request: UploadRequest,
  ): Promise<RemoteFile> {
    const size = BigInt(request.sizeBytes);

    if (size <= 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Invalid MEGA upload size.');
    }

    const storage = await this.getStorage(accountId);
    let parent = storage.root;

    if (request.parentId) {
      const selected = storage.files[request.parentId];

      if (!selected || !selected.directory) {
        throw new Error('MEGA parent folder was not found.');
      }

      parent = selected;
    }

    const upload = parent.upload({
      name: request.fileName,
      size: Number(size),
      maxChunkSize: 1024 * 1024,
    });

    if (request.onProgress) {
      const progressEmitter = upload as unknown as {
        on: (
          event: 'progress',
          listener: (info: { bytesUploaded: number; bytesTotal: number }) => void,
        ) => unknown;
      };
      progressEmitter.on('progress', (info) => {
        request.onProgress?.(info.bytesUploaded, info.bytesTotal);
      });
    }

    await pipeline(
      Readable.from(request.data),
      upload,
    );

    const uploadedFile = await upload.complete;
    return mapFile(uploadedFile);
  }

  async download(
    accountId: string,
    remoteObjectId: string,
    options: DownloadOptions = {},
  ): Promise<AsyncIterable<Uint8Array>> {
    const storage = await this.getStorage(accountId);
    let file = storage.files[remoteObjectId];

    if (!file) {
      await storage.reload(true);
      file = storage.files[remoteObjectId];
    }

    if (!file || file.directory) {
      throw new Error('MEGA file was not found.');
    }

    const stream = file.download({
      ...(options.startByte !== undefined
        ? { start: options.startByte }
        : {}),
      ...(options.endByte !== undefined
        ? { end: options.endByte }
        : {}),
    });

    return stream;
  }

  async delete(
    accountId: string,
    remoteObjectId: string,
  ): Promise<void> {
    const storage = await this.getStorage(accountId);
    let file = storage.files[remoteObjectId];

    if (!file) {
      await storage.reload(true);
      file = storage.files[remoteObjectId];
    }

    if (!file) {
      throw new Error('MEGA file was not found.');
    }

    await file.delete(false);
  }
}
