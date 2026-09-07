# News Pulse Production Database Naming Migration Plan

Date: 2026-08-26
Current DB: `test`
Target production DB: `newspulse_prod`
Target development DB: `newspulse_dev`

This is a future plan only. No migration was performed by this audit.

## Objective

Move production from an implicit/generic database name (`test`) to an intentional production database name (`newspulse_prod`) while preserving all EN/HI/GU data and avoiding accidental development access to production.

## Why This Matters

The current live production database name `test` is operationally risky because humans may treat it as disposable. A production database should have an unmistakable name such as `newspulse_prod`, and development should use `newspulse_dev`.

## Preconditions

Do not begin until all are true:

- MongoDB Database Tools are installed.
- Full backup of `test` is completed.
- Restore test into `newspulse_restore_test` succeeds.
- Founder approves a maintenance/change window.
- Render/Vercel environment variable owners are available.
- Rollback URI/DB configuration is documented privately outside the repo.
- No raw credentials are written to repo files.

## Phase 1: Backup

1. Capture current production counts for critical collections.
2. Run `mongodump` for database `test`.
3. Store backup under:

```text
D:\NewsPulse-Backups\YYYY-MM-DD\test\
```

4. Verify backup files exist.

## Phase 2: Restore Verification

1. Restore backup into isolated DB only:

```text
newspulse_restore_test
```

2. Compare key counts:

- `news`
- `articles`
- `users`
- settings/config collections
- audit/security collections

3. Confirm indexes restored.
4. Do not point the application at the restore DB.

## Phase 3: Prepare Target Production DB

After backup and restore verification:

1. Restore/copy `test` into `newspulse_prod` using Database Tools or an approved Atlas-safe method.
2. Verify `newspulse_prod` counts match `test`.
3. Verify critical indexes exist.
4. Keep `test` unchanged for rollback until the migration is stable.

## Phase 4: Backend Configuration Change

Preferred future configuration:

```text
MONGODB_URI=<cluster URI without relying on ambiguous database path>
MONGODB_DBNAME=newspulse_prod
```

Alternative:

```text
MONGODB_URI=<cluster URI ending in /newspulse_prod>
MONGODB_DBNAME unset
```

The explicit `MONGODB_DBNAME` approach is clearer because `server.js` already passes `{ dbName: MONGODB_DBNAME }` when set.

## Phase 5: Local and Staging Safety

Development should use:

```text
MONGODB_DBNAME=newspulse_dev
```

or a URI ending in `/newspulse_dev`.

Local safety already checks for dev/local/test/sandbox-like DB names. Keep that guard. Do not weaken it.

Recommended additional controls:

- Separate Atlas users for prod and dev.
- Separate database names.
- Separate `.env` files outside repo for local development.
- Never use production URI in local scripts unless explicitly doing a read-only approved audit.

## Phase 6: Deployment Change Window

During the approved window:

1. Confirm fresh backup exists.
2. Confirm `newspulse_prod` counts match `test`.
3. Update production backend environment variables in Render.
4. Restart/redeploy backend.
5. Watch startup logs for DB name only; do not print URI.
6. Verify health endpoints.
7. Verify admin login.
8. Verify public website feeds.
9. Verify News -> Article sync by creating or updating only a Founder-approved test record if needed.

## Phase 7: Post-Migration Verification

Read-only checks:

```javascript
use('newspulse_prod');

db.news.countDocuments({});
db.articles.countDocuments({});
```

Application checks:

- Public home feed loads.
- Regional feed loads.
- Article detail pages load.
- Admin article list loads.
- News publish/sync flow is verified in a controlled way.
- EN/HI/GU support remains intact.

## Rollback Plan

If production fails after switching:

1. Revert backend DB config to previous `test` database setting.
2. Restart backend.
3. Verify public/admin endpoints.
4. Do not delete `newspulse_prod` until cause is understood.
5. Record incident notes and retry only after diagnosis.

## After Stability Period

Only after Founder approval and a retention period:

- Freeze `test` as historical backup or archive.
- Consider removing or renaming only after another backup and explicit approval.
- Do not remove `sample_mflix` or legacy collections as part of the DB-name migration unless separately approved.

## Stop Gate

This document does not authorize migration. Stop after planning until Founder approves backup, restore test, and production change window.
