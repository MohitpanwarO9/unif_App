# Unified Cloud Manager

Windows-first desktop cloud file manager built with Tauri, React, Fastify and PostgreSQL.

## Current implementation

- Google Drive account connection through OAuth, file listing, folder creation, preview, resumable upload and chunked download.
- MEGA account connection with encrypted session persistence, file listing, folder creation, preview, streaming upload and chunked download.
- Provider adapters and a provider registry keep provider-specific API details separate.
- Unified-root uploads ask the backend to select a connected Google Drive or MEGA account using live provider quota data (single-account best-fit). Uploads inside an existing provider folder remain in that account.
- PostgreSQL stores account metadata; cloud credentials/sessions are encrypted before persistence.
- The Windows desktop shell stores its local encryption key in Windows Credential Manager.

## Transfer behaviour

- Google Drive uploads use resumable sessions and 8 MiB raw-binary HTTP chunks.
- MEGA uploads stream through a bounded Node.js stream into the existing `megajs` adapter. Upload size is declared up front, as required by the SDK.
- Both providers use 8 MiB application transfer chunks for downloads.
- There is no application-side 25 MiB total upload cap and no explicit upload/download speed throttle.
- Provider quotas, rate limits, API restrictions, account terms and available storage still apply.
- MEGA's SDK uses its own internal chunking (maximum 1 MiB per SDK chunk in the documented API); this is not a total file-size limit.
- Google Drive's `files.export` API limits exported Google Workspace documents to 10 MB. Ordinary binary Drive downloads do not use that export limit.
- Preview remains separately bounded (50 MiB for PDF/image content); preview limits do not limit Save As downloads.
- Transfer sessions are currently held in backend memory. A backend restart interrupts active transfers; durable cross-restart transfer recovery is a later release task.
- The backend health endpoint exposes an API protocol version; the Tauri shell will not silently reuse a backend that does not advertise the expected transfer protocol.
- Distributed storage of one file across multiple provider accounts is not yet implemented. A file must fit on one eligible account for the current upload flow.

## Windows v1.0 status

This source snapshot is still a development build, not a signed production release. Before public distribution, complete and test:
- Bundle the backend and a supported Node.js runtime (the current desktop launcher expects `node` on PATH).
- Move Google OAuth client secrets out of the repository/source archive and load them from an external local secret file.
- Configure a restrictive production Content Security Policy.
- Configure Tauri updater signing and GitHub Releases.
- Test the installer and update flow on a clean Windows 10/11 machine.

Android is intentionally deferred until the Windows release is stable. The current Rust secure-credential implementation is Windows-only.

## Development

Requirements:
- Windows 10/11 64-bit
- Node.js supported by the project dependencies
- PostgreSQL (or the supplied Docker Compose database)
- Rust toolchain and Tauri prerequisites for desktop development

Build the backend:

```powershell
cd apps/server
npm ci
npm run build
```

Build the frontend:

```powershell
cd ../web
npm ci
npm run build
```

For the current desktop development workflow, run `INSTALL_AND_RUN.ps1` from the project root. It installs Windows dependencies from both lockfiles, generates Prisma Client, builds the backend and frontend, and starts Tauri. The backend still requires the existing PostgreSQL database and local OAuth secret file if Google OAuth is used.

## Security

- Never commit `.env` files, OAuth client secrets, access tokens, refresh tokens, MEGA credentials, encryption keys, database files or runtime data.
- `apps/server/secrets/` is ignored by Git; do not include it in public source archives.
- Keep the private Tauri updater signing key outside the repository and back it up securely.
- Respect provider API quotas and account terms; the application must not attempt to bypass them.

## Design direction

- Dark surfaces with green primary/success actions and red destructive/error states.
- Navigation: Home, My Files, Gallery, Recent, Trash and Settings.
- TeleDrive is a UI/UX reference only; do not copy its product identity or Telegram-specific storage architecture.

## License

Project-specific licensing has not yet been selected. Review third-party dependency licences and provider terms before distribution.
