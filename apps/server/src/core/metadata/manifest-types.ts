export interface CloudLocation {
  provider: string;
  accountId: string;
  remoteObjectId: string;
  chunkSequence: number;
}

export interface FileManifest {
  fileId: string;
  name: string;
  mimeType: string;
  sizeBytes: string;
  checksumSha256: string;
  totalChunks: number;
  locations: CloudLocation[];
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface FolderManifest {
  folderId: string;
  name: string;
  parentFolderId: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface MetadataManifest {
  manifestId: string;
  schemaVersion: number;
  manifestVersion: number;
  deviceId: string;
  files: FileManifest[];
  folders: FolderManifest[];
  updatedAt: string;
}