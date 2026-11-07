export type ApplicationMode = 'standalone' | 'self-hosted';

export interface ApplicationModeConfig {
  mode: ApplicationMode;
  serverEnabled: boolean;
  remoteAccessEnabled: boolean;
}

export const DEFAULT_APP_MODE: ApplicationModeConfig = {
  mode: 'standalone',
  serverEnabled: false,
  remoteAccessEnabled: false,
};

export function isSelfHostedMode(
  config: ApplicationModeConfig,
): boolean {
  return config.mode === 'self-hosted';
}

export function isStandaloneMode(
  config: ApplicationModeConfig,
): boolean {
  return config.mode === 'standalone';
}