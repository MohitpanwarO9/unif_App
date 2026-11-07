# Provider integration notes

## Google Drive
- OAuth uses a locally supplied client configuration; keep client secrets and refresh tokens out of source control and logs.
- Resumable uploads use provider-confirmed byte ranges. Application chunks are 8 MiB raw binary payloads, which are multiples of Google's 256 KiB resumable-upload granularity.
- Ordinary binary file downloads use ranged `alt=media` requests.
- Google Workspace document exports use `files.export`; Google's API documents a 10 MB export limit. Do not confuse this provider limit with ordinary blob downloads.
- Validate OAuth verification and scope requirements before public distribution.

## MEGA
- MEGA account sessions are encrypted before persistence and restored by the backend.
- Uploads use the existing `megajs` adapter and a Node.js streaming pipeline; declare the final file size before streaming to avoid buffering the entire file in memory.
- The SDK exposes upload progress events and controls its own internal chunking/connections. Its documented maximum upload chunk size is 1 MiB; this is an SDK transfer detail, not a total file-size cap.
- MEGA may apply account/API rate limits or temporary restrictions. Surface provider errors and retry conservatively; never evade quotas, rate limits or free-plan restrictions.
- Verify cancellation behaviour, including provider-side cleanup of incomplete uploads, against a test account before release.

## Adapter contract
Each provider adapter exposes connect/disconnect, quota, list, folder creation, metadata lookup, upload, download/range-read and delete. Provider-specific limits and unsupported capabilities must be explicit rather than silently emulated.
