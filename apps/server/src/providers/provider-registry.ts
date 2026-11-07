import type {
  CloudProviderAdapter,
  ProviderType,
} from './provider-interface.js';

export class ProviderRegistry {
  private readonly adapters = new Map<string, CloudProviderAdapter>();

  register(accountId: string, adapter: CloudProviderAdapter): void {
    const normalizedAccountId = accountId.trim();

    if (!normalizedAccountId) {
      throw new Error('A valid account ID is required.');
    }

    if (this.adapters.has(normalizedAccountId)) {
      throw new Error(
        `Account ${normalizedAccountId} is already registered.`,
      );
    }

    this.adapters.set(normalizedAccountId, adapter);
  }

  unregister(accountId: string): boolean {
    return this.adapters.delete(accountId);
  }

  getAdapter(
    accountId: string,
    expectedProvider?: ProviderType,
  ): CloudProviderAdapter {
    const adapter = this.adapters.get(accountId);

    if (!adapter) {
      throw new Error(
        `No provider adapter registered for account ${accountId}.`,
      );
    }

    if (expectedProvider && adapter.provider !== expectedProvider) {
      throw new Error(
        `Account ${accountId} is not connected to ${expectedProvider}.`,
      );
    }

    return adapter;
  }

  getAccountsByProvider(provider: ProviderType): string[] {
    return Array.from(this.adapters.entries())
      .filter(([, adapter]) => adapter.provider === provider)
      .map(([accountId]) => accountId);
  }

  getAllAccounts(): string[] {
    return Array.from(this.adapters.keys());
  }

  hasAccount(accountId: string): boolean {
    return this.adapters.has(accountId);
  }

  clear(): void {
    this.adapters.clear();
  }
}
