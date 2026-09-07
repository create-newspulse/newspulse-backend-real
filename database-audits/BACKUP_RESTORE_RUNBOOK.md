# News Pulse Backup and Restore Runbook

Date: 2026-08-26
Scope: safe Founder-facing backup and restore procedure for MongoDB Atlas database `test`.

This runbook is documentation only. No backup or restore was performed by this audit.

## Current Tool Availability

Checked on this Windows workstation:

| Tool | Available on PATH |
|---|---|
| `mongodump` | No |
| `mongorestore` | No |

## 1. Install MongoDB Database Tools on Windows

1. Open the official MongoDB Database Tools download page:
   `https://www.mongodb.com/try/download/database-tools`
2. Select Windows x86_64 MSI or ZIP.
3. Install the tools.
4. Add the tools `bin` folder to PATH if the installer does not do it automatically.
5. Open a new PowerShell window and verify:

```powershell
mongodump --version
mongorestore --version
```

Do not install anything automatically from inside this repository.

## 2. Secret Handling Rules

Do not put passwords or full connection strings in repository files.

Use one of these safer approaches:

- Paste the URI only into a private terminal command when needed.
- Store it in a temporary PowerShell environment variable for the current shell only.
- Use a dedicated backup/audit user with least privilege.
- Never commit `.env` or backup scripts containing credentials.

Temporary shell-only example:

```powershell
$env:NP_MONGO_URI = "mongodb+srv://USERNAME:PASSWORD@HOST/test?retryWrites=true&w=majority"
```

Close the terminal when finished to clear the session variable.

## 3. Backup Location

Recommended local backup directory:

```text
D:\NewsPulse-Backups\
  YYYY-MM-DD\
    test\
```

Create the folder manually before running a backup:

```powershell
$backupDate = Get-Date -Format "yyyy-MM-dd"
$backupRoot = "D:\NewsPulse-Backups\$backupDate"
New-Item -ItemType Directory -Force -Path $backupRoot
```

## 4. Full Production Database Backup

Current production database appears to be `test`.

Run only after Founder approval and after setting a private shell variable with the MongoDB URI:

```powershell
mongodump --uri $env:NP_MONGO_URI --db test --out "D:\NewsPulse-Backups\YYYY-MM-DD"
```

Expected output folder:

```text
D:\NewsPulse-Backups\YYYY-MM-DD\test\
```

## 5. Verify Backup Files Exist

```powershell
Get-ChildItem -Recurse "D:\NewsPulse-Backups\YYYY-MM-DD\test" | Select-Object FullName, Length
```

At minimum, verify that important collections have `.bson` and metadata files, including:

- `news.bson`
- `articles.bson`
- `users.bson`
- audit/security collections
- settings/config collections

## 6. Restore Test Into Isolated Temporary Database Only

Never test restore over production.

Use isolated restore DB:

```text
newspulse_restore_test
```

Example restore test command:

```powershell
mongorestore --uri $env:NP_MONGO_URI --nsFrom "test.*" --nsTo "newspulse_restore_test.*" "D:\NewsPulse-Backups\YYYY-MM-DD\test"
```

This should create a separate temporary database named `newspulse_restore_test`.

## 7. Verify Restored Counts

Use MongoDB Compass, Atlas UI, or a read-only shell/playground to compare key counts:

```javascript
use('newspulse_restore_test');

db.news.countDocuments({});
db.articles.countDocuments({});
db.users.countDocuments({});
```

Compare with production counts captured before backup:

- `test.news`: 39
- `test.articles`: 76

Also verify that indexes were restored:

```javascript
use('newspulse_restore_test');

db.news.getIndexes().length;
db.articles.getIndexes().length;
```

## 8. Restore Validation Checklist

- Backup files exist locally.
- Restore was performed into `newspulse_restore_test`, not production.
- `news` count matches expected count.
- `articles` count matches expected count.
- Critical settings collections are present.
- Critical user/admin collections are present.
- Index counts are present.
- No application was pointed to the restore DB.
- No production data was overwritten.

## 9. Temporary Restore Database Cleanup

Only after Founder approval:

```javascript
use('newspulse_restore_test');

db.dropDatabase();
```

This is intentionally not run by this audit.

## 10. Backup Cadence Recommendation

For the current phase:

- Manual full backup before any data repair, index cleanup, DB rename, or Atlas tier change.
- Manual isolated restore test before any production migration.
- Keep at least 3 dated backup folders locally and one encrypted offline/cloud copy.

For a later mature phase:

- Enable scheduled Atlas backups after upgrading to a tier that supports the needed backup features.
- Keep documented restore drills.
- Record last backup and last restore-test status in Founder Safe Zone.

## Founder Safety Notes

- A backup is not proven until a restore test succeeds.
- Never restore into `test` or `newspulse_prod` during testing.
- Never paste production credentials into files under the repository.
- Keep all backup archives outside the repository.
