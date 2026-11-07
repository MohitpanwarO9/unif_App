export type ProviderType =
  | 'GOOGLE_DRIVE'
  | 'MEGA'
  | 'ONEDRIVE'
  | 'DROPBOX'
  | 'S3_COMPATIBLE';

export interface ProviderAccount {
  accountId: string;
  provider: ProviderType;
  displayName: string;
  connected: boolean;
}

export interface StorageQuota {
  totalBytes: string;
  usedBytes: string;
  freeBytes: string;
}

export interface RemoteFile {
  remoteObjectId: string;
  name: string;
  sizeBytes: string;
  mimeType?: string;
  parentId?: string | null;
  isFolder: boolean;
  modifiedAt?: string;
  webUrl?: string;
  checksum?: string;
}

export interface ListFilesRequest {
  parentId?: string;
  pageToken?: string;
  pageSize?: number;
}

export interface ListFilesResult {
  files: RemoteFile[];
  nextPageToken?: string | null;
}

export interface CreateFolderRequest {
  name: string;
  parentId?: string;
}

export interface UploadRequest {
  fileName: string;
  mimeType: string;
  data: AsyncIterable<Uint8Array>;
  sizeBytes: string;
  parentId?: string;
  onProgress?: (bytesUploaded: number, bytesTotal: number) => void;
}

export interface DownloadOptions {
  startByte?: number;
  endByte?: number;
  signal?: AbortSignal;
}

export interface CloudProviderAdapter {
  readonly provider: ProviderType;

  connect(accountId: string): Promise<void>;
  disconnect(accountId: string): Promise<void>;

  getQuota(accountId: string): Promise<StorageQuota>;

  listFiles(
    accountId: string,
    request?: ListFilesRequest,
  ): Promise<ListFilesResult>;

  createFolder(
    accountId: string,
    request: CreateFolderRequest,
  ): Promise<RemoteFile>;

  getFileMetadata(
    accountId: string,
    remoteObjectId: string,
  ): Promise<RemoteFile>;

  upload(
    accountId: string,
    request: UploadRequest,
  ): Promise<RemoteFile>;

  download(
    accountId: string,
    remoteObjectId: string,
    options?: DownloadOptions,
  ): Promise<AsyncIterable<Uint8Array>>;

  delete(
    accountId: string,
    remoteObjectId: string,
  ): Promise<void>;
}
