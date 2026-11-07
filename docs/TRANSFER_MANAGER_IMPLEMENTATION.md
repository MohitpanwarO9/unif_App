# Transfer Manager implementation notes

## Changes in this update

### Google Drive uploads
- Removed the UI and backend 25 MiB per-file application cap.
- Removed the unused legacy Base64/multipart `/drive/upload` route; the current frontend uses the resumable Transfer Manager route.
- Increased resumable transfer chunks from 1 MiB to 8 MiB.
- The frontend now sends raw `application/octet-stream` chunk bodies with an `X-Start-Byte` header instead of Base64 JSON. This avoids Base64 expansion and unnecessary string allocations.
- The backend still validates offsets, safe integer sizes, chunk bounds and Google's 256 KiB alignment requirement for non-final chunks.
- Older clients sending Base64 JSON to the resumable chunk endpoint remain supported.

### MEGA uploads
- Connected the existing `MegaAdapter.upload()` streaming method to new MEGA Transfer Manager endpoints.
- Uploads stream through a bounded `PassThrough` into the SDK; the backend does not buffer the complete file.
- Added destination-folder validation and provider-specific pause, resume and cancel endpoints.
- Added separate received-byte and SDK-reported uploaded-byte counters so UI progress reflects the SDK's `progress` event rather than merely bytes accepted from the desktop.
- Corrected the explicit MEGA SDK `maxChunkSize` setting from 16 MiB to 1 MiB, matching the SDK's documented maximum. This is not a total file-size limit.
- MEGA upload sessions are in-memory and are lost if the backend exits.

### Downloads
- Increased Google Drive and MEGA application range chunks from 4 MiB to 8 MiB.
- Ordinary file downloads remain streamed/ranged and have no application-wide total-size cap.
- Preview caps remain separate from Save As download behaviour.
- Google Workspace exports are checked against Google's documented 10 MB `files.export` provider limit.

## Validation performed for this source patch
- TypeScript/TSX syntax transpilation: zero syntax errors in the edited backend, MEGA adapter and frontend files.
- Static checks: no 25 MiB upload cap, no legacy `/drive/upload` endpoint, MEGA upload routes exist, frontend provider routing matches those routes, and binary upload transport is enabled.
- Stream bridge smoke test: PassThrough backpressure and pipeline completion are tested independently.
- Full `npm ci`, project type-check/build and real Google Drive/MEGA upload/download tests have not yet been completed in this environment because the source archive excludes `node_modules` and dependency installation did not complete.
- No database migrations, resets, account disconnects, cloud deletions or credential changes are part of this patch.

## Remaining release work
- Test small and large uploads to both providers with a real connected test account.
- Verify MEGA cancellation and whether an interrupted upload leaves any provider-side temporary object.
- Test large-file download integrity (including 1–2 GiB files) by comparing local and remote sizes/hashes.
- Add durable transfer recovery only if required; current sessions are process-memory state.
- Complete Windows backend/runtime packaging, CSP hardening, signed updater and clean-machine installer testing.
