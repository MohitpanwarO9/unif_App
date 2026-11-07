# Architecture decisions — v1.0

1. Windows-first development; Docker Compose is the first local deployment target.
2. Browser client and Android client connect to a self-hosted server. Android is not the storage host in v1.
3. One logical library per server identity; multiple devices are clients of that library.
4. PostgreSQL is the primary metadata store. Cloud manifest backups are encrypted snapshots, not independent writable masters.
5. File visibility is transactional: a file is READY only after all chunks and the manifest commit are verified.
6. Failed upload cleanup is asynchronous and retryable; never claim cleanup succeeded until provider deletion is confirmed.
7. Google Drive and MEGA are integrated through separate provider adapters. MEGA currently uses the `megajs` SDK; SDK behaviour, version compatibility and provider rate limits must be tested before release.
8. Provider limits, API quotas, account terms and free-plan constraints must be respected. No quota evasion or account-limit bypass features.
9. UI theme: dark surfaces, green primary/success, red errors/destructive states.
10. TeleDrive is a UI/UX reference only. Do not copy its product identity or assume its Telegram-specific storage architecture applies.
