export type ChunkStatus =
  | 'PENDING'
  | 'UPLOADING'
  | 'STORED'
  | 'VERIFIED'
  | 'ERROR';

export type CloudProvider =
  | 'GOOGLE_DRIVE'
  | 'MEGA'
  | 'ONEDRIVE'
  | 'DROPBOX'
  | 'S3_COMPATIBLE';

export interface FileChunk {
  chunkId: string;
  fileId: string;
  sequence: number;
  sizeBytes: string;
  checksumSha256: string;
  status: ChunkStatus;
}

export interface ChunkLocation {
  chunkId: string;
  provider: CloudProvider;
  accountId: string;
  remoteObjectId: string;
  remotePath?: string;
}

export interface ChunkedFile {
  fileId: string;
  fileName: string;
  totalSizeBytes: string;
  totalChunks: number;
  chunks: FileChunk[];
  locations: ChunkLocation[];
}