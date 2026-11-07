import type { ChangeRecord } from './change-record.js';

export interface ConflictResult {
  hasConflict: boolean;
  reason?: string;
  conflictingChangeIds: string[];
}

export function detectConflict(
  incoming: ChangeRecord,
  existingChanges: ChangeRecord[],
  currentVersion: number,
): ConflictResult {
  // Check whether the incoming change is based on an old version.
  if (incoming.baseVersion < currentVersion) {
    return {
      hasConflict: true,
      reason: 'The incoming change is based on an outdated version.',
      conflictingChangeIds: [],
    };
  }

  // Find concurrent changes to the same file or folder.
  const conflicts = existingChanges.filter((existing) => {
    return (
      existing.entityId === incoming.entityId &&
      existing.entityType === incoming.entityType &&
      existing.deviceId !== incoming.deviceId &&
      existing.baseVersion === incoming.baseVersion
    );
  });

  if (conflicts.length > 0) {
    return {
      hasConflict: true,
      reason: 'Multiple devices changed the same entity concurrently.',
      conflictingChangeIds: conflicts.map(
        (change) => change.changeId,
      ),
    };
  }

  return {
    hasConflict: false,
    conflictingChangeIds: [],
  };
}