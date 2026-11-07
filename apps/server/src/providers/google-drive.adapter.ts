import { OAuth2Client } from 'google-auth-library';
import type {
  CloudProviderAdapter,
  StorageQuota,
  RemoteFile,
  UploadRequest,
  ListFilesRequest,
  ListFilesResult,
  CreateFolderRequest,
  DownloadOptions,
} from './provider-interface.js';

import type { GoogleDriveFile } from './google-drive.types.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

interface DriveListResponse {
  files?: GoogleDriveFile[];
  nextPageToken?: string;
}

interface DriveQuotaResponse {
  storageQuota?: {
    limit?: string;
    usage?: string;
    usageInDrive?: string;
  };
}

function mapFile(file: GoogleDriveFile): RemoteFile {
  const isFolder = file.mimeType === 'application/vnd.google-apps.folder';

  return {
    remoteObjectId: file.id,
    name: file.name,
    sizeBytes: file.size ?? '0',
    mimeType: file.mimeType,
    parentId: file.parents?.[0] ?? null,
    isFolder,
    modifiedAt: file.modifiedTime,
    webUrl: file.webViewLink,
  };
}

export class GoogleDriveAdapter implements CloudProviderAdapter {
  readonly provider = 'GOOGLE_DRIVE' as const;

  constructor(
    private readonly getClient: (
      accountId: string,
    ) => Promise<OAuth2Client | null>,
  ) {}

  private async client(accountId: string): Promise<OAuth2Client> {
    const client = await this.getClient(accountId);

    if (!client) {
      throw new Error('Connected Google Drive account was not found.');
    }

    return client;
  }

  async connect(accountId: string): Promise<void> {
    await this.client(accountId);
  }

  async disconnect(_accountId: string): Promise<void> {
    // OAuth credentials are managed by the account and credential store.
  }

  async getQuota(accountId: string): Promise<StorageQuota> {
    const client = await this.client(accountId);
    const response = await client.request<DriveQuotaResponse>({
      url: `${DRIVE_API}/about?fields=storageQuota(limit,usage,usageInDrive)`,
      method: 'GET',
    });

    const quota = response.data.storageQuota;
    const total = BigInt(quota?.limit ?? '0');
    const used = BigInt(quota?.usageInDrive ?? quota?.usage ?? '0');

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
    const client = await this.client(accountId);
    const pageSize = Math.min(Math.max(request.pageSize ?? 100, 1), 1000);

    const query = request.parentId
      ? `'${request.parentId}' in parents and trashed = false`
      : 'trashed = false';

    const params = new URLSearchParams({
      pageSize: String(pageSize),
      orderBy: 'modifiedTime desc',
      q: query,
      spaces: 'drive',
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,parents,trashed)',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });

    if (request.pageToken) {
      params.set('pageToken', request.pageToken);
    }

    const response = await client.request<DriveListResponse>({
      url: `${DRIVE_API}/files?${params.toString()}`,
      method: 'GET',
    });

    return {
      files: (response.data.files ?? [])
        .filter((file) => !file.trashed)
        .map(mapFile),
      nextPageToken: response.data.nextPageToken ?? null,
    };
  }

  async createFolder(
    accountId: string,
    request: CreateFolderRequest,
  ): Promise<RemoteFile> {
    const name = request.name.trim();

    if (!name || name.length > 255) {
      throw new Error('Invalid folder name.');
    }

    const client = await this.client(accountId);
    if (request.parentId) {
      const parent = await this.getFileMetadata(accountId, request.parentId);
      if (!parent.isFolder) {
        throw new Error('Parent folder was not found.');
      }
    }
    const response = await client.request<GoogleDriveFile>({
      url: `${DRIVE_API}/files?fields=id,name,mimeType,size,modifiedTime,webViewLink,parents`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        ...(request.parentId ? { parents: [request.parentId] } : {}),
      },
    });

    return mapFile(response.data);
  }

  async getFileMetadata(
    accountId: string,
    remoteObjectId: string,
  ): Promise<RemoteFile> {
    const client = await this.client(accountId);
    const response = await client.request<GoogleDriveFile>({
      url: `${DRIVE_API}/files/${encodeURIComponent(remoteObjectId)}?fields=id,name,mimeType,size,modifiedTime,webViewLink,parents,trashed`,
      method: 'GET',
    });

    if (response.data.trashed) {
      throw new Error('File is in Google Drive trash.');
    }

    return mapFile(response.data);
  }

  async upload(
    accountId: string,
    request: UploadRequest,
  ): Promise<RemoteFile> {
    const totalBytes = BigInt(request.sizeBytes);

    if (totalBytes <= 0n || totalBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Upload size must be a positive safe integer.');
    }

    const client = await this.client(accountId);
    const accessToken = (await client.getAccessToken()).token;

    if (!accessToken) {
      throw new Error('Google access token unavailable.');
    }

    const metadata = {
      name: request.fileName,
      mimeType: request.mimeType || 'application/octet-stream',
      ...(request.parentId ? { parents: [request.parentId] } : {}),
    };

    const init = await fetch(
      `${UPLOAD_API}?uploadType=resumable&fields=id,name,mimeType,size,modifiedTime,webViewLink,parents`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': metadata.mimeType,
          'X-Upload-Content-Length': totalBytes.toString(),
        },
        body: JSON.stringify(metadata),
        redirect: 'manual',
      },
    );

    const sessionUrl = init.headers.get('location');

    if (!init.ok || !sessionUrl) {
      throw new Error('Google Drive did not create an upload session.');
    }

    let uploaded = 0n;
    let pending = Buffer.alloc(0);

    const sendChunk = async (
      chunk: Buffer,
      final: boolean,
    ): Promise<RemoteFile | null> => {
      const start = uploaded;
      const end = start + BigInt(chunk.length) - 1n;

      const response = await fetch(sessionUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(chunk.length),
          'Content-Range': `bytes ${start}-${end}/${totalBytes}`,
        },
        body: new Uint8Array(chunk),
        redirect: 'manual',
      });

      if (response.status === 308 && !final) {
        const range = response.headers.get('range');
        const match = range?.match(/bytes=0-(\d+)/);

        if (!match || BigInt(match[1]) + 1n !== end + 1n) {
          throw new Error('Google Drive upload progress could not be confirmed.');
        }

        uploaded = end + 1n;
        return null;
      }

      if ((response.status === 200 || response.status === 201) && final) {
        const file = await response.json() as GoogleDriveFile;

        if (!file.id) {
          throw new Error('Google Drive did not return the uploaded file ID.');
        }

        uploaded = end + 1n;
        return mapFile(file);
      }

      throw new Error(`Google Drive upload returned HTTP ${response.status}.`);
    };

    try {
      for await (const input of request.data) {
        let offset = 0;

        while (offset < input.length) {
          const available = UPLOAD_CHUNK_BYTES - pending.length;
          const take = Math.min(available, input.length - offset);

          pending = pending.length
            ? Buffer.concat([pending, input.subarray(offset, offset + take)])
            : Buffer.from(input.subarray(offset, offset + take));

          offset += take;

          if (pending.length === UPLOAD_CHUNK_BYTES) {
            const result = await sendChunk(pending, uploaded + BigInt(pending.length) === totalBytes);
            pending.fill(0);
            pending = Buffer.alloc(0);

            if (result) return result;
          }
        }
      }

      if (pending.length === 0 || uploaded + BigInt(pending.length) !== totalBytes) {
        throw new Error('Upload stream size does not match the declared file size.');
      }

      const result = await sendChunk(pending, true);
      pending.fill(0);

      if (!result) {
        throw new Error('Google Drive upload did not return completed file metadata.');
      }

      return result;
    } catch (error) {
      pending.fill(0);
      await fetch(sessionUrl, { method: 'DELETE', redirect: 'manual' }).catch(() => undefined);
      throw error;
    }
  }

  async download(
    accountId: string,
    remoteObjectId: string,
    options: DownloadOptions = {},
  ): Promise<AsyncIterable<Uint8Array>> {
    const client = await this.client(accountId);
    const accessToken = (await client.getAccessToken()).token;

    if (!accessToken) {
      throw new Error('Google access token unavailable.');
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
    };

    if (options.startByte !== undefined || options.endByte !== undefined) {
      const start = options.startByte ?? 0;
      const end = options.endByte !== undefined ? options.endByte : '';

      if (!Number.isSafeInteger(start) || start < 0) {
        throw new Error('Invalid download start byte.');
      }

      headers.Range = `bytes=${start}-${end}`;
    }

    const response = await fetch(
      `${DRIVE_API}/files/${encodeURIComponent(remoteObjectId)}?alt=media`,
      {
        method: 'GET',
        headers,
        signal: options.signal,
      },
    );

    if (!response.ok || !response.body) {
      throw new Error(`Google Drive download returned HTTP ${response.status}.`);
    }

    return {
      async *[Symbol.asyncIterator]() {
        const reader = response.body!.getReader();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            yield value;
          }
        } finally {
          reader.releaseLock();
        }
      },
    };
  }

  async delete(accountId: string, remoteObjectId: string): Promise<void> {
    const client = await this.client(accountId);

    await client.request({
      url: `${DRIVE_API}/files/${encodeURIComponent(remoteObjectId)}`,
      method: 'DELETE',
    });
  }
}

