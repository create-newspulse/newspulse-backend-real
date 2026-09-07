# News Pulse Database Master Audit

Date: 2026-08-26
Repository: `newspulse-backend-real-main`
Scope: read-only architecture, safety, backup-readiness, cleanup-readiness, recovery, security, retention, and production database naming audit.

## 1. Executive Summary

News Pulse production currently appears to run against MongoDB database `test` on Atlas Cluster0 Free tier. The application uses Mongoose, with `MONGODB_URI` as the primary URI environment variable and optional `MONGODB_DBNAME` as an explicit database-name override. If `MONGODB_DBNAME` is not set, the database name is derived from the URI path.

The production data model has two central content collections:

- `news`: newsroom/editorial source records.
- `articles`: public-facing Article/PublicArticle records. Code commonly aliases `models/Article.js` as `PublicArticle`; there is no separate `publicarticles` collection and none should be created.

Live read-only checks found:

- Current DB: `test`
- Collections: 130
- `news`: 39 documents, 64 indexes
- `articles`: 76 documents, 52 indexes
- `news` languages: EN 6, GU 31, HI 2
- `articles` languages: EN 20, GU 47, HI 9
- `articles` source links: 29 valid `sourceNewsId` links, 9 orphan `sourceNewsId` links, 38 missing/null `sourceNewsId`
- 4 orphan Article records are published and pass the backend shared public visibility filter.
- Exact canonical matching found no current News or Article sibling record for those 4 visible orphan records.

No database writes were performed during this audit. No production configuration, users, credentials, Atlas settings, indexes, or application source files were changed.

## 2. Current Production Architecture

Connection entrypoint:

- Primary connection occurs in `server.js` through `mongoose.connect(MONGO_URI, MONGO_DB_NAME ? { dbName: MONGO_DB_NAME } : undefined)`.
- `MONGO_URI` is sourced from `process.env.MONGODB_URI`.
- Legacy `MONGO_URI` is aliased into `MONGODB_URI` early in startup if `MONGODB_URI` is absent.
- `MONGODB_DBNAME` can override the database name passed to Mongoose.
- If `MONGODB_DBNAME` is not set, the DB name is implicitly derived from the URI path.

Environment controls found:

| Purpose | Variable |
|---|---|
| MongoDB URI | `MONGODB_URI` |
| Legacy URI alias | `MONGO_URI` |
| Explicit DB name override | `MONGODB_DBNAME` |
| Runtime mode | `NODE_ENV` |
| App mode | `APP_ENV` |
| Render production signal | `RENDER`, `RENDER_SERVICE_ID`, `RENDER_EXTERNAL_URL` |
| Exit on DB connect failure | `EXIT_ON_DB_CONNECT_FAIL` |

Why production appears to use `test`:

- The live connection reports `dbName: test`.
- Existing audit playgrounds use `use('test')`.
- If `MONGODB_DBNAME` is absent, `test` likely comes from the database path in `MONGODB_URI`, or from Atlas/Mongoose default DB selection embedded in the URI.
- There is no evidence that the app is intentionally configured with `newspulse_prod` today.

Development/prod separation risk:

- Local safety code in `lib/environmentSafety.js` refuses local development DB names that do not look like dev/local/test/sandbox and refuses production-looking local DB names.
- This helps local safety, but production still using a generic DB name `test` is operationally confusing and raises migration/backup risk.
- Until `newspulse_prod` and `newspulse_dev` are separated intentionally, humans can misread `test` as disposable.

## 3. Current Database Map

Live read-only inventory found 130 collections. Largest or operationally important collections include:

| Collection | Count | Indexes | Classification |
|---|---:|---:|---|
| `threatlogs` | 3061 | 1 | AUDIT/SECURITY |
| `audit_logs` | 1958 | 13 | AUDIT/SECURITY |
| `audit_events` | 764 | 9 | AUDIT/SECURITY |
| `activitylogs` | 323 | 2 | AUDIT/SECURITY / LONG-TERM |
| `sessionlogs` | 273 | 9 | SESSION / AUDIT |
| `media` | 118 | 22 | PERMANENT |
| `reporteractivitylogs` | 88 | 4 | AUDIT / LONG-TERM |
| `articles` | 76 | 52 | PERMANENT PUBLIC CONTENT |
| `pushdeliverylogs` | 62 | 19 | TEMPORARY / AUDIT |
| `communitysubmissions` | 60 | 28 | LONG-TERM / MODERATION |
| `pushhistories` | 60 | 15 | TEMPORARY / AUDIT |
| `reporterstorylinks` | 60 | 5 | LONG-TERM |
| `translationcaches` | 60 | 5 | CACHE |
| `news` | 39 | 64 | PERMANENT EDITORIAL SOURCE |
| `reportercontactmethods` | 39 | 8 | LONG-TERM |
| `translationjobs` | 37 | 11 | TEMPORARY / JOB QUEUE |
| `reporterprofiles` | 30 | 16 | LONG-TERM |
| `reportercoverages` | 26 | 9 | LONG-TERM |
| `reportercontacts` | 20 | 18 | LONG-TERM |
| `adinquiries` | 19 | 10 | LONG-TERM / BUSINESS |

Index-heavy collections requiring later review:

| Collection | Count | Indexes | Risk |
|---|---:|---:|---|
| `news` | 39 | 64 | High index overhead for small collection |
| `articles` | 76 | 52 | High index overhead for small collection |
| `viralvideos` | 5 | 35 | High overhead / likely legacy indexes |
| `communitysubmissions` | 60 | 28 | Needs query analysis |
| `users` | 8 | 23 | Needs auth/security query analysis |
| `media` | 118 | 22 | Could be justified by library filters |
| `articleanalyticsevents` | 5 | 19 | Needs retention/index cleanup review |
| `pushdeliverylogs` | 62 | 19 | TTL/retention candidate |

## 4. News vs Article Architecture

Intended flow:

```text
News
  -> syncPublicArticleFromNews(newsDoc)
  -> Article / PublicArticle
  -> public frontend and selected public APIs
```

`News` appears to be the canonical editorial/newsroom record. It has workflow fields, translation metadata, per-language slugs, regional data, publication state, and moderation/review information.

`Article` is the public-facing materialized representation. In code it is often imported as `PublicArticle`:

```js
const PublicArticle = require('../models/Article');
```

There is no separate `publicarticles` collection. Creating one would be incorrect unless the architecture is redesigned later.

`syncPublicArticleFromNews.service.js` writes public records by upserting an `Article` using `sourceNewsId` or `slug` as matching keys. This makes `sourceNewsId` the primary provenance link from public Article back to canonical News.

Important fields:

| Field | Meaning |
|---|---|
| `sourceNewsId` | Article -> News provenance link. Should point to existing `news._id` when Article was synced from News. |
| `sourceArticleId` | Potential Article -> Article relationship field; prior audit found 0 valid links. |
| `translationGroupId` | Groups related translations/variants of the same story. |
| `translationKey` | Alternate translation grouping key, often used for grouped feeds. |
| `language` | Main Article language field; `articles.lang` is currently null for all 76 Article docs. |
| `lang` | Used by News and some query/index paths; `news.lang` is populated EN/HI/GU. |
| `originalLang` | Original/source language of the story. |
| `sourceLanguage` | Additional provenance/source language metadata. |
| `slugs.en`, `slugs.hi`, `slugs.gu` | Language-specific slug variants for routes and localization. |

## 5. Multilingual Architecture

English, Hindi, and Gujarati are required and must be preserved.

Current live counts:

| Collection | EN | HI | GU |
|---|---:|---:|---:|
| `news.language` | 6 | 2 | 31 |
| `news.lang` | 6 | 2 | 31 |
| `articles.language` | 20 | 9 | 47 |
| `articles.lang` | 0 | 0 | 0 |

Findings:

- News has both `language` and `lang` populated consistently.
- Articles use `language`; `lang` is null/missing across all Article docs.
- Public routes use a mix of original language checks, `language`, `originalLang`, translation readiness, and `slugs.en/hi/gu`.
- Gujarati has special fallback behavior in some public feed routes.

## 6. Data Integrity Findings

News:

- Total: 39
- Status: 27 published, 11 deleted, 1 draft
- Missing language: 0
- Missing slug: 3

Articles:

- Total: 76
- Status: 48 published, 24 draft, 4 deleted
- Missing slug: 0
- Duplicate exact slugs: 0
- Suspicious slug/title: 1 published Gujarati Article with slug `object-object` and title `[object Object]`

Article `sourceNewsId` health:

| Type/State | Count |
|---|---:|
| `sourceNewsId` missing | 34 |
| `sourceNewsId` null | 4 |
| `sourceNewsId` ObjectId | 38 |
| Valid News links | 29 |
| Orphan News links | 9 |

There were 0 recoverable string/ObjectId mismatches in prior audit results.

## 7. Published Orphan Article Findings

Known 9 orphan Article records have `sourceNewsId` values pointing to missing News documents.

Published/publicly visible orphans:

| Article ID | Language | Category | Status | Missing News ID | Note |
|---|---|---|---|---|---|
| `69c0c4707c7cb68a34add518` | en | regional | published | `69c0c43436597ca98d3f60fc` | English Article with Gujarati slug/title text |
| `69bf02457c7cb68a34adccd7` | gu | regional | published | `69bef36a33f48cb98463ab86` | Visible Gujarati regional Article |
| `69c424217c7cb68a34ae01b7` | gu | national | published | `69c40ff400889bdf9a1bc2c8` | Suspicious `object-object` slug/title |
| `69aba84e4c3cb9a18ef5b1e3` | gu | international | published | `69aba790bc29a2d2bf6b787b` | Visible Gujarati international Article |

Draft/lower priority orphans:

| Article ID | Language | Category | Status |
|---|---|---|---|
| `69c814697c7cb68a34ae2a25` | gu | national | draft |
| `69c814957c7cb68a34ae2a26` | gu | national | draft |
| `69c814eb7c7cb68a34ae2a29` | gu | national | draft |
| `69c815727c7cb68a34ae2a2f` | gu | national | draft |
| `69bfb0b67c7cb68a34adcf0a` | gu | regional | draft |

Exact canonical-match audit for the four visible orphans returned no exact News matches and no exact Article sibling matches using non-null meaningful values for `translationGroupId`, `translationKey`, `title`, `slug`, or localized slugs.

## 8. Collection Classification

| Data Area | Collections / Models | Classification | Retention Type |
|---|---|---|---|
| Editorial source | `news` / `News` | ACTIVE | PERMANENT |
| Public content | `articles` / `Article` aka PublicArticle | ACTIVE | PERMANENT |
| Users/Auth | `users`, `roles`, `refresh_tokens`, reporter sessions | ACTIVE | LONG-TERM + SESSION |
| Audit/security | `audit_logs`, `audit_events`, `threatlogs`, `activitylogs`, `sessionlogs` | ACTIVE | AUDIT/SECURITY |
| Push | `pushregistrations`, `pushdeliverylogs`, `pushhistories` | ACTIVE | LONG-TERM + TEMPORARY |
| Translation | `translationjobs`, `translationcaches`, `translationmemories` | ACTIVE | JOB/CACHE/LONG-TERM |
| Community Reporter | reporter profiles/contacts/coverage/story links/activity logs | ACTIVE | LONG-TERM + AUDIT |
| Staff/attendance | `attendances`, `leaverequests`, `staff_tasks`, schedules | ACTIVE/UNKNOWN | LONG-TERM |
| Analytics | article analytics events/daily/summary/dedup | ACTIVE | LONG-TERM + TEMPORARY |
| Marketing | marketing campaigns/proposals/performance/renewals | UNKNOWN/FEATURE AREA | LONG-TERM/UNKNOWN |
| Settings/config | site/system/public/settings/version collections | ACTIVE | PERMANENT |
| Temporary/jobs | OTP tokens, refresh tokens, broadcast items, translation jobs | ACTIVE | TEMPORARY |
| Empty legacy/test areas | many 0-count collections | NEEDS REVIEW | UNKNOWN |

## 9. Index Findings

Live index counts are high relative to document counts:

- `news`: 64 indexes for 39 docs
- `articles`: 52 indexes for 76 docs
- `viralvideos`: 35 indexes for 5 docs
- `communitysubmissions`: 28 indexes for 60 docs
- `users`: 23 indexes for 8 docs

Keep / justified index families:

- `slug`, `slugs.en`, `slugs.hi`, `slugs.gu`: used by public detail lookups and multilingual URLs.
- `status`, `category`, `publishedAt`: used by public feeds and admin listings.
- `status`, `isBreaking`, `publishedAt`: used by breaking feed paths.
- `translationGroupId`, `translationKey` with language/status/date: used for grouped multilingual content.
- `sourceNewsId`: used by sync, relationship audit, and provenance checks.
- Geo/state/category/status/publishedAt composites: used by regional feeds.

Needs query analysis:

- Many single-field indexes that may be covered by compound indexes.
- Marketing indexes on empty collections.
- Analytics/push indexes where TTL/retention may reduce volume.
- `news` and `articles` both having many overlapping geography/language/publication indexes.

Do not delete indexes until query plans are measured under production traffic patterns.

## 10. Storage Risks

Main risks:

- Atlas Free tier has limited storage headroom.
- `sample_mflix` was reported as a known storage concern but must not be deleted yet.
- 130 collections plus high index counts can consume storage disproportionate to document volume.
- Audit/security logs (`threatlogs`, `audit_logs`, `audit_events`) are among the largest collections and need retention planning.
- Index-heavy empty/low-count collections may waste limited free-tier storage.

## 11. Retention Findings

Retention candidates:

| Area | Recommendation |
|---|---|
| Threat/security logs | Define legal/security retention window before TTL. |
| Audit logs | Keep long-term, possibly archive/export before expiration. |
| Push delivery logs/history | TTL or scheduled cleanup likely appropriate after delivery/debug window. |
| Translation jobs | TTL completed/failed jobs after operational window. |
| Translation cache | Keep if it saves cost; consider max-age/version invalidation. |
| OTP/session/refresh tokens | TTL required and appears partially implemented. |
| Broadcast items | TTL/cleanup appears implemented. |
| Analytics dedup | TTL appropriate and appears implemented. |
| Marketing empty collections | Review feature status before cleanup. |

No TTL indexes were created by this audit.

## 12. Security Findings

Current safety strengths:

- Connection-string redaction helpers exist.
- Local DB isolation exists in `lib/environmentSafety.js`.
- Test/import mode avoids connecting to MongoDB.
- Startup does not print credentials.

Risks:

- Production app user `np_app_rw_01` is known to be broad; do not change it without a migration plan.
- Production DB name `test` increases human error risk.
- Backup/restore readiness is incomplete because `mongodump` and `mongorestore` are not installed on PATH.
- Founder Safe Zone should show health status, not credentials or raw database editor access.

## 13. Backup Readiness

Current workstation check:

- `mongodump`: not available on PATH
- `mongorestore`: not available on PATH

Backup readiness status: not ready until MongoDB Database Tools are installed and a full backup plus isolated restore test are completed.

See `BACKUP_RESTORE_RUNBOOK.md` for a step-by-step plan.

## 14. Production DB Naming Problem

Current production DB: `test`

Target production DB: `newspulse_prod`

Target development DB: `newspulse_dev`

Problem:

- `test` is semantically unsafe for a live production database.
- It makes backup, cleanup, and human operations more dangerous because a real production DB looks disposable.
- Moving to `newspulse_prod` should happen only after backup and restore verification.

## 15. Recommended Future Architecture

- Production app uses `newspulse_prod` through explicit `MONGODB_DBNAME=newspulse_prod` or a URI path ending in `/newspulse_prod`.
- Local development uses `newspulse_dev` or a clearly local database name.
- Audit/founder read-only user has read-only access to production.
- Backup user has backup-appropriate read roles only.
- No public `publicarticles` collection is created; Article remains the PublicArticle collection unless explicitly redesigned.

## 16. SAFE TO KEEP

- `news` and `articles` architecture.
- EN/HI/GU multilingual support.
- `sourceNewsId` provenance concept.
- `translationGroupId`, `translationKey`, and localized slugs.
- Local DB isolation guard.
- Existing read-only audit playgrounds.
- Audit/security collections, pending retention policy.

## 17. NEEDS REVIEW

- 9 orphan Article records, especially the 4 public ones.
- `object-object` published Article.
- Article marked `language=en` with Gujarati slug/title text.
- High index counts on `news`, `articles`, `viralvideos`, `users`, `media`.
- Empty/low-count collections with many indexes.
- Audit/security log growth and retention.
- Nested duplicate directory `newspulse-backend-real-main/newspulse-backend-real-main/`.

## 18. CLEANUP CANDIDATE - DO NOT DELETE YET

- `sample_mflix` if confirmed present in Atlas and not used.
- Empty legacy collections after feature-owner review.
- Nested duplicate backend copy after deployment/startup path verification.
- Old analytics/push/job records after backup and retention policy approval.
- Unused indexes after query-plan analysis.

## 19. HIGH PRIORITY ISSUES

1. Production database is named `test`.
2. Backups are not yet operational from this workstation because database tools are missing.
3. Four publicly visible Articles point to missing News records.
4. One visible Article has malformed title/slug content: `[object Object]` / `object-object`.
5. `news` and `articles` have very high index counts for small collections.
6. Audit/security logs are among the largest collections and need retention policy.

## 20. Recommended Implementation Order

1. Understand/audit.
2. Establish backup.
3. Test restore.
4. Fix prod/dev database separation.
5. Move production from implicit `test` to intentional `newspulse_prod`.
6. Verify website/admin/backend.
7. Repair approved data-integrity problems.
8. Remove approved test/sample/legacy data.
9. Optimize indexes.
10. Add retention automation.
11. Tighten MongoDB privileges.
12. Add Founder Safe Zone monitoring.
13. Consider Atlas upgrade only when genuinely needed.

## Stop Gate

Stop here. Do not repair records, delete records, delete collections, remove sample data, change indexes, run migrations, change DB names, alter Atlas users, deploy, commit, or push without Founder approval.
