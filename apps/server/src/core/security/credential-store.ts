
export interface CredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type CredentialStorePlatform =
  | 'windows'
  | 'android'
  | 'linux'
  | 'macos'
  | 'self-hosted';
