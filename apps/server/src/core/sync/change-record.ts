export type ChangeOperation =
  | 'FILE_CREATED'
  | 'FILE_UPDATED'
  | 'FILE_DELETED'
  | 'FOLDER_CREATED'
  | 'FOLDER_UPDATED'
  | 'FOLDER_DELETED';

export interface ChangeRecord {
  changeId: string;
  deviceId: string;
  entityId: string;
  entityType: 'FILE' | 'FOLDER';
  operation: ChangeOperation;
  baseVersion: number;
  newVersion: number;
  timestamp: string;
}

export function createChangeRecord(
  deviceId: string,
  entityId: string,
  entityType: 'FILE' | 'FOLDER',
  operation: ChangeOperation,
  baseVersion: number,
): ChangeRecord {
  return {
    changeId: crypto.randomUUID(),
    deviceId,
    entityId,
    entityType,
    operation,
    baseVersion,
    newVersion: baseVersion + 1,
    timestamp: new Date().toISOString(),
  };
}