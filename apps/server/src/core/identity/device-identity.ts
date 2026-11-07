import { randomUUID } from 'node:crypto';

export interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
  platform: string;
  createdAt: string;
}

export function createDeviceIdentity(
  deviceName: string,
  platform: string,
): DeviceIdentity {
  return {
    deviceId: randomUUID(),
    deviceName,
    platform,
    createdAt: new Date().toISOString(),
  };
}