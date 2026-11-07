# Unified Cloud Manager — candidate source update

This archive is based on the freshly uploaded `UCM_CURRENT_CANDIDATE_SOURCE.zip`.

## Focused change
Updated `apps/web/src/main.tsx` so uploads from the unified root request a fresh `/storage/allocate` decision **for each file**, using that file's own byte size. This fixes the prior batch-allocation issue where the combined size of every selected file had to fit in one cloud account.

Existing behavior is retained:
- Uploads inside a provider-owned folder stay in the account that owns that folder.
- The selected account's provider determines whether the `/drive` or `/mega` transfer API is used.
- Upload jobs remain sequential in the existing Transfer Manager queue.
- The backend's single-account-per-file policy remains unchanged. Files are not split across providers.

## Apply
Extract this archive over the existing candidate project folder:
`E:\UCM_Repair_Test\unified-cloud-v1`

Allow Windows to overwrite the existing files. Do not delete the candidate folder or original project. This archive intentionally excludes `.env`, OAuth secrets, `node_modules`, build output, and Rust `target` output.

Then build using the existing two-PowerShell workflow. In PowerShell 2:
```powershell
cd E:\UCM_Repair_Test\unified-cloud-v1\apps\web
npm ci
npm run build
```
If that passes, build the Windows app from the project root using the project's existing Tauri build process.

## Verification status
- Source-level checks: per-file allocation is present; batch-sum allocation is absent; folder-owned upload routing remains; provider-specific upload endpoint selection remains.
- Build: **not verified in this environment** because dependency installation timed out.
- Live Google Drive / MEGA transfers: not re-tested by this archive.
