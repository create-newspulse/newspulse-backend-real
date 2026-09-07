# News Pulse Database Security and Retention Plan

Date: 2026-08-26
Scope: read-only recommendations for MongoDB access, retention, cleanup readiness, and Founder Safe Zone database visibility.

No MongoDB users, roles, data, indexes, or Atlas settings were changed by this audit.

## 1. Current Security Posture

Known current users:

| User | Current / Intended Purpose | Action |
|---|---|---|
| `np_app_rw_01` | Broad application read/write access | Do not change yet |
| `np_prod_audit_ro` | Intended read-only audit user with `read@test` | Do not change yet |

Code safety strengths:

- `MONGODB_URI` is the primary connection variable.
- Legacy `MONGO_URI` is supported but aliased.
- `MONGODB_DBNAME` can explicitly select DB.
- Local development DB safety exists in `lib/environmentSafety.js`.
- Connection-string redaction exists.
- Test/import mode skips DB connection.

Current risks:

- Production app appears to use database `test`.
- Application user appears broad.
- Backup tools are not installed on PATH.
- Audit/security collections are growing and need policy.
- There are many low-count/index-heavy collections.

## 2. Future Least-Privilege Architecture

Recommended future user design:

| User Type | Scope | Suggested Permissions |
|---|---|---|
| Production app user | `newspulse_prod` only | `readWrite` on `newspulse_prod` |
| Development app user | `newspulse_dev` only | `readWrite` on `newspulse_dev` |
| Founder/audit user | `newspulse_prod` | `read` only |
| Backup user | `newspulse_prod` | backup-appropriate read roles; no application writes |
| Emergency admin | Atlas/admin use only | Privileged, MFA, not used by app |

Do not create or modify users until backup and migration planning are approved.

## 3. Credential Safety Rules

- Never commit `.env` files.
- Never write full MongoDB URIs into repository scripts or docs.
- Never print connection strings in logs.
- Prefer shell-only environment variables for manual backup commands.
- Keep production credentials separate from development credentials.
- Rotate any credential that is accidentally exposed.

## 4. Retention Classification

| Data Type | Collections / Examples | Retention Class | Recommendation |
|---|---|---|---|
| Published editorial source | `news` | PERMANENT | Keep indefinitely unless legally removed |
| Public articles | `articles` | PERMANENT | Keep indefinitely unless editorial/legal removal |
| Users/roles/settings | `users`, `roles`, settings collections | PERMANENT | Keep; backup before changes |
| Audit/security | `audit_logs`, `audit_events`, `threatlogs`, `activitylogs` | AUDIT/SECURITY | Define retention and archive policy |
| Sessions/tokens | `refresh_tokens`, `reporter_sessions`, OTP tokens | SESSION/TEMPORARY | TTL appropriate |
| Push logs/history | `pushdeliverylogs`, `pushhistories` | TEMPORARY/AUDIT | TTL after operational window |
| Translation jobs | `translationjobs` | TEMPORARY/JOB | TTL completed jobs after review window |
| Translation cache | `translationcaches` | CACHE | Keep while useful; version/invalidate later |
| Translation memory | `translationmemories` | LONG-TERM | Keep if quality/cost benefit exists |
| Article analytics events | `articleanalyticsevents`, dedup/daily/summary | MIXED | TTL raw events/dedup; keep summaries |
| Community submissions | `communitysubmissions` | LONG-TERM/MODERATION | Retain based on policy/legal needs |
| Reporter network | reporter profile/contact/coverage/story link collections | LONG-TERM | Keep, audit access |
| Marketing data | marketing campaign/proposal/performance/renewal collections | UNKNOWN/LONG-TERM | Review feature ownership before cleanup |
| Empty legacy collections | many 0-count collections | UNKNOWN | Cleanup candidate only after backup/approval |
| MongoDB sample data | `sample_mflix` if present | LEGACY/EXTERNAL SAMPLE | Do not remove yet; review storage after backup |

## 5. TTL / Cleanup Recommendations

Potential future TTL or scheduled cleanup areas:

- Expired OTP tokens.
- Expired reporter sessions.
- Expired refresh tokens.
- Completed/failed translation jobs older than an approved window.
- Push delivery logs older than an approved delivery/debug window.
- Analytics dedup records.
- Broadcast/live temporary items.
- Old threat/security events only after legal/security retention policy is approved.

Do not create TTL indexes until retention windows are approved.

## 6. Index Safety Plan

Do not delete indexes yet.

Recommended sequence:

1. Export current index definitions.
2. Identify top query patterns from application code.
3. Use read-only explain plans in a staging/restore DB, not production first.
4. Classify indexes:
   - KEEP
   - POSSIBLE DUPLICATE
   - LEGACY CANDIDATE
   - NEEDS QUERY ANALYSIS
   - UNKNOWN
5. Remove only after backup, approval, and staging verification.

Likely KEEP families:

- `slug`
- `slugs.en`, `slugs.hi`, `slugs.gu`
- `status/category/publishedAt`
- `status/isBreaking/publishedAt`
- `translationGroupId/language/status/publishedAt`
- `translationKey/language/status/publishedAt`
- `sourceNewsId`
- regional geo/state indexes used by public regional feeds

Likely NEEDS QUERY ANALYSIS:

- Single-field indexes covered by compounds.
- Marketing indexes on empty collections.
- Analytics and push indexes if retention reduces records.
- Many overlapping News/Article geo indexes.

## 7. Founder Safe Zone Database Design

Founder Safe Zone should be monitoring and guardrails, not a raw database editor.

Recommended panels:

### Database Status

- Connected/disconnected.
- Current DB name.
- Expected DB name.
- Environment mode.
- Last successful DB health check.

Never show raw URI or credentials.

### Storage

- Atlas storage usage.
- Collection count.
- Top storage/index consumers if available from Atlas API or safe diagnostics.
- Warning thresholds.

### Backup and Recovery

- Last backup date.
- Last backup location label, not secret path if sensitive.
- Last restore-test date.
- Restore-test status.
- Backup tool readiness.

### Data Health

- Orphan `Article.sourceNewsId` count.
- Published orphan count.
- Malformed slug/title warnings.
- Missing language/slug counts.
- Duplicate slug count.

### Retention

- Audit log growth.
- Push log growth.
- Translation job backlog.
- Temporary collection warnings.

### Security

- Production DB naming status.
- Least-privilege status.
- Read-only audit user configured.
- Backup user configured.
- Secret exposure checks.

## 8. Emergency Controls

Founder Safe Zone can eventually include controlled actions, but only after backup/restore maturity:

- Generate read-only health report.
- Download redacted audit report.
- Mark issue acknowledged.
- Request backup verification.

It should not include:

- Raw query editor.
- Direct update/delete buttons.
- Credential display.
- Database user management.
- Atlas network access mutation.
- Production DB rename/migration button.

## 9. Recommended Next Security Actions

1. Install MongoDB Database Tools.
2. Perform backup and isolated restore test.
3. Plan `test` -> `newspulse_prod` migration.
4. Split production and development DB users.
5. Add read-only Founder audit path.
6. Define retention windows.
7. Review indexes after restore/staging explain-plan testing.

## Stop Gate

Do not modify users, roles, indexes, data, Atlas settings, or production environment variables until Founder approval and verified backups exist.
