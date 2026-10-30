# News Pulse Backend Architecture

This is a map of the current backend code, not a deployment certificate or an
exhaustive API specification. Read [BRAIN.md](./BRAIN.md) for repository context
and [rules.md](./rules.md) for change-safety requirements. Current implementation
and tests take precedence if this map becomes stale.

## Runtime and layout

The production backend is a Node.js/CommonJS Express application using Mongoose
and MongoDB. Render is the deployment platform described in
[BRAIN.md](./BRAIN.md). The entry point is [server.js](./server.js).

```text
Website / Admin / Reporter clients
                  |
              Express server
                  |
       Middleware -> Routes / Controllers
                           |
                     Services / Helpers
                           |-- Mongoose models -> MongoDB
                           `-- Cache and external integrations
```

| Location | Responsibility |
| --- | --- |
| [server.js](./server.js) | Environment initialization, middleware, route mounts/aliases, application startup, background tasks |
| [routes/](./routes/) | HTTP endpoints and route-specific orchestration; some business logic remains here |
| [controllers/](./controllers/) | Request/response logic for extracted features |
| [services/](./services/) | Publishing, translations, synchronization, analytics, reporter workflows, and other domain operations |
| [models/](./models/) | Mongoose documents, validation, hooks, and indexes |
| [middleware/](./middleware/) | Admin/reporter authorization, language handling, and cache headers |
| [lib/](./lib/) | Shared safety, authentication, cache, slug/category, media, and mail helpers |
| [src/utils/locationTagger.js](./src/utils/locationTagger.js) | Shared Indian state definitions, aliases, and location-tag utilities |
| [tests/](./tests/) | Node test-runner suites, including mocked persistence and Supertest HTTP tests |
| [scripts/](./scripts/) | Explicit maintenance/verification utilities; not interchangeable with normal request handlers |

The nested [newspulse-backend-real-main/](./newspulse-backend-real-main/) directory
contains legacy code, but is not wholly unused. The root server explicitly
imports some nested routes. The root
[articles.js](./routes/articles.js) is a compatibility re-export of
[articles.routes.js](./routes/articles.routes.js). Follow imports and mounts
before editing, moving, or removing either kind of compatibility code.

## HTTP surfaces

Representative routes below are not the full inventory. The server also mounts
compatibility paths under `/admin-api` and other prefixes; preserve those
contracts rather than inferring a route's URL from its file name.

| Surface | Primary implementation |
| --- | --- |
| `/api/articles`, `/api/admin/articles` and article actions | [articles.routes.js](./routes/articles.routes.js) |
| `/api/public/news` and story/translation lookups | [publicNews.routes.js](./routes/publicNews.routes.js), [publicNewsController.js](./controllers/publicNewsController.js) |
| `/api/public/regional?state=gujarat` and legacy state-path form | [articles.routes.js](./routes/articles.routes.js) |
| `/api/auth/login`, `/admin/login` and authentication aliases | [auth.routes.js](./routes/auth.routes.js), [server.js](./server.js) |
| `/api/reporter-portal`, `/api/community-reporter/portal` | [reporterPortal.js](./routes/reporterPortal.js) |
| `/api/public/settings`, `/api/admin/settings/public` and draft/publish actions | [publicSettings.routes.js](./routes/publicSettings.routes.js), [adminPublicSettings.routes.js](./routes/adminPublicSettings.routes.js) |
| `/api/analytics` article events | [articleAnalytics.routes.js](./routes/articleAnalytics.routes.js) |

Other mounted families include Community Reporter, broadcasts/tickers, ads,
sponsored features, Pulse Dialogue, media, team/access management, privacy,
security, and system diagnostics. Their individual routers and the root
server are authoritative for authorization and mount order.

## News, Public Article, and identity

[News.js](./models/News.js) is the editorial/CMS document, carrying content,
workflow/publication state, language relationships, geography, and media.
[Article.js](./models/Article.js) is the synchronized public document, often
imported as `PublicArticle`. These are separate models, not aliases for one
collection.

News has an optional, immutable `createdByUserId` reference to the existing User
model. [articleCreator.js](./lib/articleCreator.js) derives it only from
`req._authUserDoc._id`, the persisted account loaded by the existing authentication
middleware. It is CMS-record provenance, not a public byline, contributor,
reviewer, task assignment or permission grant.

Canonical/manual and legacy article creation and authenticated Community Reporter/Youth
Pulse handoffs stamp the creating account only on new records. Generated or
cached language records use the authenticated request that creates them, when
present; source-article ownership, translation-group membership and `requestedBy`
labels do not establish a creator. Background work without verified authentication
context leaves it absent. Existing records are not
backfilled, and repeated handoffs or ordinary updates do not set or replace it.

The field has no default or new index and is excluded from queries by default.
Canonical write allowlists do not accept client creator claims; legacy raw-body
writers reject direct/dotted creator fields. Mongoose immutability also protects
ordinary document/query updates. Public serialization does not expose it.
It is not a permission grant on its own. Content-save authorization uses this
verified identity only for the limited own-draft exception described below;
draft reads, publication, deletion and assignments remain separate boundaries.

Public reads are not all served from the same model:

- The main public News controller queries News for feeds and includes Public
  Article handling in story lookup flows.
- The Regional endpoint queries Public Article copies.
- Consequently, a published CMS record and an eligible synchronized Regional
  record are related but not equivalent states.

[syncPublicArticleFromNews.service.js](./services/syncPublicArticleFromNews.service.js)
is the canonical News-to-Public-Article mapper:

- It upserts using `sourceNewsId` or the normalized stored slug, not a
  translation-group-wide update.
- It carries language/group/source links, stored translations, content,
  publication state, geography, and media into the public copy.
- Existing public IDs, creation timestamps, and analytics fields are not
  assigned by its update.
- For published sources it copies an existing source `publishedAt`; when the
  source has no timestamp, its fallback is insert-only rather than a reset of
  an existing copy's date.
- It reports a safe sync warning and returns `null` if synchronization fails.

## Publication and translation flows

The CMS route layer invokes
[articlePublishing.service.js](./services/articlePublishing.service.js) for
canonical publication. This service validates required fields and slug
uniqueness, resolves the EN/HI/GU group, ensures required translations, applies
publication/workflow state, and synchronizes each ready document to a public
copy. It also maintains legacy public-copy fallback handling.

Publishing may generate missing translations. It is therefore not a
metadata-only maintenance operation. Request publication authorizes the whole
existing News/public-copy group before source preparation or translation writes,
and keeps preparation, generation and publication in one transaction. Canonical
publication rolls back on a public-copy synchronization failure. Post-commit cache/revalidation failures
are reported separately; they do not mean the committed publication rolled back.

Language state has multiple related representations:

- `language`, `lang`, and `originalLang` identify the stored/base language.
- `translationGroupId` and `translationKey` associate EN/HI/GU variants.
- `sourceArticleId` and `sourceLanguage` describe source/child relationships;
  the public copy's `sourceNewsId` links back to its own News record.
- Per-language slugs, cached translation buckets, and readiness/error/retry
  metadata support language-specific reads.

[translationGroupSync.service.js](./services/translationGroupSync.service.js)
propagates source changes to linked sibling News records and synchronizes their
public copies. It checks source linkage and preserves child cover-image fields
in its patch. Translation generation, async jobs, and read-time translation
have separate implementations:
[articleTranslationGeneration.service.js](./services/articleTranslationGeneration.service.js),
[publishAsyncTranslation.service.js](./services/publishAsyncTranslation.service.js),
and [newsOnDemandTranslation.service.js](./services/newsOnDemandTranslation.service.js).
Their readiness and regeneration rules must not be inferred from the public
copy mapper, which copies stored translations rather than generating them.

Request-initiated retry and generation use the existing content-save scope in
[articleSaveAccess.service.js](./services/articleSaveAccess.service.js).
Non-Founders need effective Manage News plus `news_edit`, or effective Add News /
Draft Desk access to their verified own drafts. The entire affected group must
remain undeleted, unlocked and unscheduled drafts; a published or scheduled
edition prevents staff translation writes. Public-copy visibility and planned
sibling lifecycle/chronology changes are checked as well. Client-supplied
source/group links cannot attach a new staff record to a protected story or
public copy. Ownership, group membership and `news_publish` alone do not confer
publication authority.

Canonical and compatibility generation share the verified Founder check for
human-reviewed overwrite confirmation. HTTP generation is atomic across the
requested languages: authorization, scope, provider or persistence failure
rolls back the request's News, public-copy and translation-job changes. Failed
requests do not report rolled-back editions as committed. Successful response
envelopes remain compatible. Retry readiness, synchronization and queue writes
also share one transaction, with cache effects deferred until commit.
Trusted internal generation/workers remain separate from this request wrapper;
no request body flag enables trusted execution.

Publication-capable scheduling intentionally remains Founder-only, including
for staff with verified `news_publish`. Creation, dedicated schedule actions,
status updates, workflow scheduling and restoration to Scheduled recheck the
persisted account inside the transaction, including retries, using
[articleMutationActor.js](./lib/articleMutationActor.js). Restoration to Published
uses the same verified Founder boundary. Scheduling writes are bounded to the
preflighted News/public-copy group; restoring a group containing even one
previously scheduled edition requires Founder authority.

The root server also runs a scheduled-publication tick outside test/import mode.
[scheduledPublication.service.js](./services/scheduledPublication.service.js)
delegates both ordinary stories and Pulse Dialogue to canonical publication
with its trusted SYSTEM actor, once per logical group. It continues processing
already-authorized scheduled stories without acquiring or inheriting a staff
Special Right. These initiation guards do not inspect or repair historical
production schedules or translation jobs.

### Founder-controlled staff publication: Backend contract

The existing `news_publish` Special Right is usable through canonical publication
APIs. It is not a new role or a replacement for Staff Control Center. Publication
requires the persisted, authenticated account to remain eligible; current
token/role checks, account restrictions, Safe Zone, temporary denials and module
policy still apply. The verified Founder retains publication authority without
a staff grant.

For staff, [articleSaveAccess.service.js](./services/articleSaveAccess.service.js)
combines an effective `news_publish` with verified Founder issuance and the
existing content-edit scope:

| Staff scope | Additional effective access | Authorized articles |
| --- | --- | --- |
| Broader editorial | Manage News (`manageNews`) **and** `news_edit` | The complete unprotected editorial group, including eligible non-owned records |
| Limited draft workspace | Add News (`addNews`) **or** Draft Desk (`draftDesk`) | Only a complete, verified own-draft group; every existing sibling must be owned, unlocked, unscheduled and eligible |

Neither ownership, a module, role presets, legacy permission strings nor an
unattested `news_publish` grants publication. Granting `news_publish` does not
enable Manage News or add `news_edit`. Limited staff retain their existing draft
scope; publication does not grant subsequent Manage News access. Their linked
Youth Pulse/protected records remain excluded. Staff cannot publish deleted,
scheduled, locked, embargoed, private or Founder-approval-protected editions.
Conflicting/unresolved source identities and foreign, unowned or incompatible
public-copy matches fail closed for Founder review rather than being adopted.

**Grant and revoke using the existing Founder rights controls**

- `PATCH /api/admin/team/access/staff/:id/rights` accepts the intended complete
  permanent selection and the existing audit reason. For example:

  ```json
  {
    "specialRightsOverride": ["news_publish"],
    "auditReason": "Allow publication of this staff member's eligible own drafts"
  }
  ```

  Include any other permanent rights that should remain selected; for broader
  editorial publication, `news_edit` must independently be effective. Existing
  `rights` / `specialRights` array or key-map aliases are supported, and multiple
  supplied selections must agree. Removing `news_publish` (including saving
  `[]`) revokes the permanent grant.
- The same atomic User update records server-controlled `newsPublishGrant`
  provenance, configures the permanent selection and increments `accessVersion`.
  [newsPublishGrant.js](./lib/newsPublishGrant.js) binds issuance to the verified
  Founder and subject account. Publication re-reads the issuer's persisted
  Founder identity inside the article transaction.
- `POST /api/admin/team/access/staff/:id/temporary` supports `rightKey:
  "news_publish"`, `enabled`, a future ISO `expiresAt`, and `auditReason`. A
  temporary grant is bound to its server-created entry ID, subject, issuer,
  issuance time and expiry. `enabled: false` is a denial and takes precedence.
  Remove an entry with
  `DELETE /api/admin/team/access/staff/:id/temporary/:temporaryAccessId`.
  An attested active temporary grant can coexist with an intentionally empty
  permanent selection; empty permanent rights do not erase temporary decisions.
- Clients must not send `newsPublishGrant` or `specialRightsConfigured`.
  Provenance inputs fail with `PUBLICATION_GRANT_READ_ONLY`; supplied
  `grantedBy` does not establish authority. Staff creation, general account
  edits and legacy permission saves cannot issue publishing provenance.
  Historical grants without it must be re-saved/reissued by the Founder through
  these controls. There is no migration, backfill, new collection or new index.

**Publication calls for the subsequent Admin Panel integration**

- Prefer `POST /api/articles/:id/publish` with an optional `reason`. It publishes
  the authorized EN/HI/GU operation and returns the existing `article`,
  `data.article`, `translationGroupId`, `publishedLanguages` and `publicSync`.
  Use the newsroom News ID (a public copy's `sourceNewsId`), not the public
  Article copy's own ID.
- `POST /api/articles/:id/publish-group` and
  `POST /api/articles/:id/publish-all-languages` use the identical authority and
  retain their `articles` array response.
- Canonical `POST /api/articles` with `status: "published"` returns the normal
  201 creation envelope. `PUT/PATCH /api/articles/:id` with publication intent
  uses the same preflight **before** content edits. Staff cannot use these
  requests to alter other lifecycle, provenance, source/group or visibility
  control fields.
- `PATCH /api/admin/workflow/articles/:id/stage` with
  `{"action":"set","toStage":"published"}` uses the same authority, without
  granting staff arbitrary workflow-set, scheduling or unpublishing access.
- The existing article router mounts share these handlers: the empty prefix,
  `/api`, `/api/admin`, `/admin-api`, `/admin-api/api`, `/admin-api/admin`,
  `/admin-api/api/admin`, `/api/api` and `/api/api/admin`. No separate alias
  permission exists. Raw legacy `/api/news` publication writes and restoration
  to Published remain Founder-only; delegated staff must use canonical calls.
- `GET /api/access/me` (`data` / `access`) and
  `GET /api/access/my-modules` (`data` and top level) expose the additive,
  read-only `newsPublishGrantRecorded` flag. Staff DTOs and Founder effective
  access responses expose it too. Refresh access after grants/revocations.
  This flag describes a recorded grant, **not** a final authorization decision:
  an active denial, restricted account, issuer change or inaccessible group can
  still prevent publication. Generic effective-right lists retain legacy preset
  semantics, so the presence of `news_publish` in a list alone is insufficient.

Unauthorized publication returns 403 (`ARTICLE_PUBLISH_FORBIDDEN` for authority/
provenance, or the existing `ARTICLE_SAVE_FORBIDDEN` for edit scope); authentication
retains its existing 401/403 responses. Group changes return 409 and require a
reload. Validation/provider/public-sync errors retain their existing status
codes and envelopes. A 200 response with `committed: true`, failed `revalidation`
or `postCommitWarnings` describes a saved change: reload and handle the warning,
do not blindly repeat publication. The server rechecks authority and all affected
records on transaction retries and preserves publication dates, language/media
identities and bounded public-copy synchronization.

This contract does not authorize scheduling or request-driven translation of
published/protected groups. Existing draft-only staff translation protections,
Founder human-overwrite confirmation and trusted SYSTEM scheduling remain
separate. No Admin Panel or Frontend change is included here.

## Public visibility and Gujarat Regional metadata

[publicArticleVisibility.service.js](./services/publicArticleVisibility.service.js)
provides separate News and Public Article filters. Both enforce published,
non-deleted content and applicable timestamp/privacy constraints. News also
checks lock/embargo fields. Preserve the appropriate filter at each read path.

For exact `category === "regional"`, the canonical public sync represents the
Gujarat desk using:

- `geo.state: "gujarat"`;
- legacy `state: "Gujarat"`;
- a `state:gujarat` tag through the existing location-tag merger.

District/city metadata is normalized from existing geo, location, legacy
fields, or tags. Existing geographic tags are retained, and sync does not mutate
the source location. This category rule does not infer state from article text
and does not add Gujarat metadata to other categories.

The Regional endpoint still requires both the Regional category and supported
state metadata. Its state clause accepts canonical geo, supported state tags,
and legacy state aliases. Optional district/city clauses remain independent.
The sort is `publishedAt` descending, then `createdAt` descending. English/Hindi
requests select originals or ready cached translations. For translated Regional
records, title, summary, and content must each be scalar strings containing
non-whitespace text, matching the locale serializer's JavaScript `trim()` rule.
This eligibility check runs before selection, counting, and pagination.
The native-language branch and Gujarati base-language fallback are unchanged.
Language-variant deduplication remains a separate part of response handling.

Public article responses use
[publicArticleSerializer.service.js](./services/publicArticleSerializer.service.js)
after eligibility and localization. Its response-only allowlist preserves each
route's envelope, public rendering/SEO fields, EN/HI/GU representations, source
links, bylines, Pulse Dialogue public editor notes, and sponsored disclosures.
CMS workflow notes/history/comments, private submission links, intake/review metadata
and translation diagnostics are not public fields. Full-document CMS detail
requires verified authentication and the existing `manageNews` module permission
on every ID/slug/by-slug alias, regardless of URL prefix. Authorized admin-named
ID aliases also retain their administrative translation-group metadata.

CMS article lists and translation-status reads use `requireAdminModule('manageNews')`
from [adminAuth.js](./middleware/adminAuth.js) on every mounted alias. Anonymous
requests remain unauthorized (401); authenticated accounts denied that module
receive 403 before article lookups or counts. Authorized Founder/Admin responses
retain their existing CMS fields and envelopes.

The public News translation POST uses the same complete News visibility rules
before serving a cached bucket or generating a translation. A conditional
Mongoose document save also enforces that predicate, so an article hidden while
translation is in flight cannot receive the translation write or response.
This does not change publication stages or introduce a translation-approval gate.

Changing the mapper does not retroactively rewrite stored public records.
[resyncPublishedRegionalArticles.js](./scripts/resyncPublishedRegionalArticles.js)
is a separate manual utility that calls the same canonical sync. Operational
policy requires approval before execution; this is not an in-script Founder
authentication check. It defaults to dry run and requires an explicit connection
configuration. Neither mode should be run merely to validate code or documentation.

## Authentication, Reporter Portal, and settings

[adminAuth.js](./middleware/adminAuth.js) validates signed access JWTs from
supported headers/cookies and checks persisted account state and token version.
Authorization uses account/module permissions and Founder checks, not merely
a client-supplied role. Shared policy helpers include
[teamAccess.js](./lib/teamAccess.js),
[accountLifecycle.js](./lib/accountLifecycle.js), and
[authRequestSecurity.js](./lib/authRequestSecurity.js).

### Temporary Staff Access module precedence

The shared module evaluator in
[founderAccessPolicyService.js](./services/founderAccessPolicyService.js) gives
an active temporary denial precedence over active grants for the same canonical
module, regardless of entry order. Canonical and legacy stored keys use the
existing normalization; display aliases are normalized when temporary access
is saved. Without an active denial, the first valid grant and its reported
expiry are preserved. Invalid/expired-entry handling and expired-access
diagnostics are unchanged. Founder authority, the fixed Dashboard control,
Safe Zone, global module restrictions and account eligibility retain their
existing boundaries. This does not change Special Rights or publishing rights.

### Founder Special Rights: opt-in permanent selection

[User.js](./models/User.js) stores an optional, server-controlled Boolean
`specialRightsConfigured`. Only the value `true` activates authoritative
individual permanent rights. The field has no persisted default or new index.
Missing, `false`, or `null` markers retain the legacy additive calculation:
role defaults, individual additions, and mapped legacy permissions. Older
`specialRightsOverride: []` records are not inferred to be Founder revocations.
There is no migration, backfill, or read-time write for this transition.

The only activating operation is the existing Founder-authorized
`PATCH /api/admin/team/access/staff/:id/rights` in
[adminTeam.routes.js](./routes/adminTeam.routes.js), including its mounted
compatibility aliases. It requires the existing audit reason and protected-target
checks. It atomically saves the normalized permanent `specialRightsOverride`,
sets `specialRightsConfigured: true`, and increments `accessVersion`.
Clients must not supply the marker.

Send the intended permanent selection as `specialRightsOverride: []` or an
array/key map of existing backend keys, for example `["news_edit"]`.
The existing `rights` and `specialRights` request aliases remain supported.
If multiple selection fields are supplied, their normalized selections must
agree; otherwise the request fails with `CONFLICTING_SPECIAL_RIGHTS` before
writing. Do not round-trip a computed/effective rights list into these fields.
Existing registry normalization and blocked-Founder-only-right reporting remain
in place. `news_publish` and `news_edit` are distinct keys; neither is inferred
from the other.

For configured staff, `[]` means no permanent Special Rights, while a selected
list replaces all preset and legacy permanent Special Rights. The shared
permanent-right calculation in [teamAccess.js](./lib/teamAccess.js) is used by
both effective-right lists and detailed effective-access states. Recognized
legacy permission aliases and canonical right keys in the projected
`permissions` list cannot restore a removed right. Unrelated legacy permissions,
task rights, account-control rights, and Staff Access module policy are separate.
Stored legacy permission strings are not destructively rewritten to infer
their provenance. For configured staff, team-action guards ignore broad legacy
`staff_manage`, `staff.manage`, and `team.manage` fallbacks: selecting one
Special Right cannot authorize other staff actions. Separate account-control
grants remain independent.

Temporary entries remain separate: active grants add rights, active denials win,
and expired/invalid-expiry entries do not apply. Existing null-expiry legacy
Special Rights entries retain their existing behavior; the dedicated temporary
API still requires a future expiry. Configured non-Founders cannot acquire
Founder-only Special Rights through these calculations. Founder full access,
account eligibility, Safe Zone checks, and global module restrictions remain
at their existing authorization boundaries. The configured-selection marker
alone does not delegate publication; the additional recorded Founder grant and
publication scope described above are required.

Staff creation (including supplied preset selections), general staff updates,
legacy permission saves, and the older combined `/users/:id/access` endpoint
never activate the marker. Once configured, general/combined updates containing
Special Rights fields fail with `SPECIAL_RIGHTS_SAVE_REQUIRED`; module-only and
ordinary profile/account updates remain independent. Direct marker inputs to
the staff access parser or dedicated rights save fail with
`SPECIAL_RIGHTS_CONFIGURED_READ_ONLY`. There is no client reset-to-legacy action.

Backend response contract for the Admin Panel:

- Staff `user` DTOs retain `specialRightsOverride` as the saved permanent list
  and `specialRights` as the effective list, and add the Boolean
  `specialRightsConfigured`. A configured empty list must not fall back to a
  role preset or effective list.
- Detailed `effectiveAccess` retains its per-right states, `allowed` decisions,
  `effectiveSpecialRights`, and separate `temporaryAccess`, and adds the same
  marker. Raw effective lists are not substitutes for account/module decisions.
- `/access/me` (also embedded as `/auth/me`'s `access`) adds the marker alongside
  the existing `specialRights` summary. That summary's `specialRights` list
  remains the stored selection, not a newly computed effective list.
- `/access/my-modules` keeps its effective `specialRights` arrays and adds the
  marker in both existing response envelopes.
- The Admin Panel must save only intentional permanent selections, preserve
  configured `[]` on reload, keep temporary rights separate, omit read-only
  marker fields, and use an authoritative reload after its separate access
  requests. No Admin Panel implementation is part of this backend change.

  Legacy updates containing permanent Special Rights also require the marker
  not to be `true` in the atomic database update predicate. If an intentional
  Founder save configures the account while an older general/combined request is
  in flight, the older request returns HTTP 409 `SPECIAL_RIGHTS_SAVE_REQUIRED`
  without updating any of its fields. Module-only updates do not use this guard.

  The canonical save uses the MongoDB `user.id`/`user._id`, not the display Staff ID:

  ```http
  PATCH /api/admin/team/access/staff/:id/rights
  Content-Type: application/json

  {"specialRightsOverride":[],"auditReason":"Founder reviewed permanent rights"}
  ```

  For a selected save, replace `[]` with the intended existing keys, such as
  `["news_edit"]`. The successful HTTP 200 envelope remains
  `{ ok, success, status, message, data: { user, blockedFounderOnly, effectiveAccess }, user, blockedFounderOnly }`.
  Both `user` copies expose the same saved `specialRightsOverride`, Boolean
  `specialRightsConfigured`, and effective `specialRights`.
  `data.effectiveAccess.accessVersion` is the incremented access version.
  Reload with `GET /api/admin/team/access/staff/:id`; its existing envelope is
  `{ ok, success, status, data: { user, effectiveAccess }, user, effectiveAccess }`.
  Missing/malformed selections return HTTP 400 `NO_RIGHT_CHANGES`; conflicting
  selection aliases return HTTP 400 `CONFLICTING_SPECIAL_RIGHTS`; client marker
  inputs return HTTP 400 `SPECIAL_RIGHTS_CONFIGURED_READ_ONLY`. The audit reason
  must contain at least three trimmed characters (`AUDIT_REASON_REQUIRED`).
  These validation failures do not configure the account.

  Legacy `PUT/PATCH /api/news/:id` in [news.js](./routes/news.js) use
`requireAdminAuth` before [updateNews](./controllers/newsController.js) reads or
saves an article. The server's `/api/api/news/:id` normalization reaches the
same guard. Signed bearer and supported cookie sessions require a persisted,
eligible account and current token version; cookie writes also require a trusted
Origin. Public GET routes remain separate, unauthenticated registrations.

Legacy `POST /api/news` and `/api/news/news`, including their `/api/api/...`
normalized aliases, also require `requireAdminAuth`. Creation checks the
constructed News document's effective status before saving: `published` and
`scheduled` require the verified account's Founder role, not role-preset-derived
`news_publish`. Scheduled creation is protected because the system scheduler can
later publish it. Missing status still defaults to `draft`; ordinary creation
must meet the shared creation authorization below. Authorized draft creation
retains the existing payload handling and 201 message-only response.
The public Community Reporter and Youth Pulse submission endpoints are separate
from these privileged CMS creation routes.

### Limited own-draft read contract

[ownArticleDrafts.routes.js](./routes/ownArticleDrafts.routes.js) adds a separate
authenticated read surface, mounted before the dynamic article detail routes:

- `GET /api/articles/own-drafts`
- `GET /api/articles/own-drafts/:id`

The same handlers inherit the article router's root, `/api/admin`, `/admin-api`,
`/admin-api/api`, `/admin-api/admin` and `/admin-api/api/admin` mounts and leading
duplicate-`/api` normalization. They are never public reads, even on a public-looking
alias. HEAD uses the same guards. Existing full-CMS list/detail and translation
reads retain their Manage News guards and existing response contracts.

Authentication is the existing signed bearer or `np_admin_token`, `np_token`,
or `token` cookie flow, including persisted User, account lifecycle and token-version
checks. The new read guard evaluates that persisted User's effective `addNews`
OR `draftDesk` using the existing Founder module-policy evaluator and a read-only
policy lookup. It does not initialize settings, require `news_edit`, calculate
new rights, or alter Staff Access/Special Rights. Global restrictions and active
temporary module denials still apply. Founder retains broader access through the
existing CMS endpoints; this deliberately named own-draft surface remains owner
scoped for everyone.

List, count and detail share a database predicate:

- `createdByUserId` must match the verified persisted User `_id`, never a request
  parameter, display Staff ID, byline, task link or translation-group relationship.
- `status` must be exactly `draft`. Deleted/publication/scheduling timestamps must
  be absent or null; previously published or still schedule-marked drafts do not
  qualify for this limited contract.
- Both workflow stage representations must be absent/null or `draft`/`DRAFT`.
  The workflow container must be absent/null or an object, never an array/scalar.
  Locks and `requiresFounderApproval` must be absent/null/false; future embargoes
  in either representation are excluded. Past embargoes no longer restrict reads.
- Legacy `isPrivate` must be absent/null/false, and `visibility` absent/null/public.
  Their query predicates are preserved with `strictQuery: false`, rather than
  relying on unknown-schema query casting. Array-valued ownership and restriction
  fields are rejected, not treated as scalar membership matches.

No legacy creator is inferred or backfilled. There is no established article
assignment grant: `StaffTask.relatedNewsId` and task assignees are not one.
Assigned-but-not-owned drafts remain unavailable pending a separate authoritative
assignment contract.

#### List request and response

Only `page`, `limit` (or `pageSize`), `sort` and optional `status=draft` are accepted.
Defaults: page 1, limit 20, `sort=-createdAt`. Zero is normalized to 1; pagination
must otherwise be a non-negative integer, limits are capped at 100 and unsupported
or overflowing offsets are rejected. Supplying both limit aliases requires equal
values. Supported sorts are `-createdAt` and `-updatedAt`, each with descending
`_id` as the stable tie-breaker. There are no creator, assignment, group,
localization, deleted, published or arbitrary search/filter overrides.

HTTP 200:

```js
{
  ok: true, success: true, status: 200,
  data: { items, page, limit, total, pages },
  items, articles: items, total, page, limit, pages, sort
}
```

`total` counts only matching owned eligible News records, not global records or
logical translation groups. `pages = Math.ceil(total / limit)` (zero when empty).
The list and count are independent scoped reads, not a transactional pagination
snapshot; concurrent changes can affect totals between reads.

Each list item allowlists `_id`, `id`, `title`, `slug`, `status`, `category`,
`imageURL`, `description`, `summary`, `language`, `lang`, `coverImageUrl`,
`createdAt` and `updatedAt`. Both ID aliases identify that single owned CMS record.
`summary` aliases its stored `description`; language fallback uses only that
record's `language`/`lang`, never another language bucket. Dates are ISO strings
or null when absent. Optional absent/invalid scalar fields may be omitted.
The cover URL follows existing CMS precedence: `coverImage.url`, legacy string
`coverImage`, `coverImageUrl`, then `imageURL`.

#### Detail request and response

`:id` is the owned News `_id`, not a public-copy ID or translation-group ID.
No query parameters are supported; detail never localizes the requested record.
HTTP 200 is `{ ok: true, success: true, status: 200, article, data: { article } }`.
Both article envelopes contain the same DTO. It adds these allowlisted fields
to the list item:

- `content`, `body` (same stored content), `editorialType`, `track`, `topic`.
- String arrays: `tags`, `externalUrls`, `embeds`, `gallery`, `stateTags`, `stateNames`.
- `coverImage`: only `url`, `publicId`, `alt`.
- `seo`: only `metaTitle`, `metaDescription`, `canonicalUrl`.
- `location`: only `state`, `stateSlug`, `district`, `districtSlug`, `city`, `citySlug`, `country`, `isUT`.
- `geo`: only `state`, `district`, `city`.

There are no translation buckets, sibling IDs/titles/statuses/counts, group/source
links, locale availability, translation jobs/diagnostics, creator/account IDs,
task/submission/contributor links, workflow notes/history/comments, byline internals,
advertising metadata or computed permission flags. Nested fields are allowlisted;
neither a raw document spread nor CMS/public enrichment is used. Reads query only
News and authentication/module policy, with no sibling/public-copy fallback,
translation generation, synchronization, article writes or content-cache operations.
Existing authentication-time account-expiry handling remains unchanged.

All responses, including authentication and validation errors, use
`Cache-Control: private, no-store`, `Pragma: no-cache` and `Vary: Authorization, Cookie`
(alongside any existing Vary values). Invalid, missing, foreign, unknown-creator
and ineligible detail IDs share HTTP 404 `DRAFT_NOT_FOUND`, without sibling details.
Missing effective module access returns 403 `DRAFT_READ_FORBIDDEN`; malformed or
unsupported query parameters return 400 `INVALID_DRAFT_QUERY`. Authentication
errors retain existing codes. Storage failures return 503 `DB_UNAVAILABLE` or
500 `DRAFT_READ_FAILED`, not an empty successful list. New errors use
`{ ok: false, success: false, status, code, message }`.

#### Admin Panel integration boundary

The limited Draft Desk client must opt into these endpoints and normalize the
existing `data.items`/`items`/`articles` list envelope to its `rows` helper. Its
verified `status=draft&page=1&limit=100&sort=-createdAt` request is supported.
Draft Workspace's `_id`, title, summary, content, category, tags, language and
cover-URL hydration needs are covered. Source classification and full specialized
editor metadata are not part of this purpose-specific DTO.

The existing Draft Desk opens the full article editor, which expects more metadata
and automatically requests translation-group siblings. A separate limited-client
adapter/workflow is required: do not call those broader APIs, infer owners, enable
the Deleted tab, or treat omitted fields as instructions to erase saved metadata.
This DTO is not a full-CMS replacement or a lossless PUT payload.
There is no own-draft fallback to the separate legacy `/api/admin/drafts` list.
That unscoped list, including `deleted=1` and its aliases, requires effective
Manage News access; Add News or Draft Desk alone cannot disclose its records.

Read access grants no edit, publish, delete or assignment permission. Existing
PUT/PATCH authorization still evaluates the complete save operation and may deny
a readable own draft when protected siblings would be modified. Do not retry
that denial via an alternate endpoint or assume a successful read authorizes a
save. No Admin Panel implementation is included here.

### Article soft-delete authorization

Soft deletion is authorized inside
[articleLifecycle.service.js](./services/articleLifecycle.service.js), before
the first content or `syncVersion` write. Every transaction attempt reloads the
persisted account through [articleMutationActor.js](./lib/articleMutationActor.js),
the same account/lifecycle/token-version check used by content saves.

- Founder retains authorized control. Other accounts require effective
  `manageNews` AND effective `news_delete`, including current global/individual
  module restrictions, configured-empty rights, temporary grants/denials,
  account eligibility and Safe Zone. A role label or module grant alone is
  insufficient; `news_edit` is not a substitute or an additional delete requirement.
- That combination is the existing broad CMS action scope. There is no
  established limited own-draft deletion exception. Add News/Draft Desk,
  creator identity, bylines, StaffTask links and group membership do not grant
  deletion authority. Unknown/generated creators are not assigned an owner.
- The entire logical News group and all matching public copies are read in
  the transaction before deletion. CMS and public updates are bounded to those
  record IDs and their expected status/identity snapshots. Public matched counts
  and the final member sets are checked before commit; a conflict rolls back
  the whole operation. Existing group writers retain their shared News write
  dependencies. No claim is made of a cross-request bulk transaction.
- Denied operations do not change News, public copies, translation jobs,
  topic pins, related submissions, or content caches. An access-denied audit
  record is separate. Successful soft deletes preserve content, IDs, slugs,
  language links and publication timestamps, retain pre-delete status/history,
  and preserve existing post-commit revalidation/warning responses.

Active routes are `DELETE /articles/:id` on every article-router mount and
`POST /drafts/:id/delete` under `/api/admin`, `/admin-api/admin` and
`/admin-api/api/admin`, including leading duplicate-`/api` normalization.
Founder canonical PUT/PATCH `status=deleted` uses the same service. Staff
PUT/PATCH lifecycle transitions remain denied by content-save authorization,
including legacy `/api/news/:id`; staff must use the dedicated delete action.
The legacy Founder updater retains its single-record behavior. There is no
active bulk soft-delete endpoint; permanent bulk deletion remains Founder-only.
Unreferenced legacy article routers are not active aliases.

Permission denial is HTTP 403 `ARTICLE_DELETE_FORBIDDEN` with a generic action
permission message, never sibling metadata. Scope changes use HTTP 409
`ARTICLE_DELETE_SCOPE_CHANGED` and the existing reload/retry message. Canonical
success retains `article`, `data.article`, `deletedCount` and `deletedIds`;
legacy draft success retains its `data` document and deletion counts/IDs.
Draft-delete failures retain their existing fields and add a machine-readable
`code`. Restore authorization is described below; unpublish, scheduling and
permanent-delete authorization remain independent and unchanged.

The current Admin Panel Manage News tables, Draft Desk and Draft Workspace
use `deleteArticle` (DELETE `articles/:id`, browser `/admin-api`).
`deleteArticleSoft` delegates to it. The draft POST compatibility path has no
current wired consumer. Bulk hard-delete uses `articles/forever/bulk`, not
soft delete. Clients must treat 403 as a permission denial, not a reason to
retry another route or mutate an entire group locally. No client changes or
additional rights grants accompany this backend correction.

### Article creation and restore authorization

Ordinary creation is authorized by the shared transactional helper in
[articleSaveAccess.service.js](./services/articleSaveAccess.service.js), including
canonical `POST /articles` mounts and legacy `/api/news` creation aliases.
After persisted-account verification, a verified Founder is allowed. Other
eligible accounts need effective Add News or Draft Desk for ordinary scoped
drafts, or effective Manage News plus effective `news_edit`. Roles alone do not
grant editorial module access. Existing linked-story, public-copy, ownership,
publication, scheduling, account, temporary-denial and Safe Zone checks remain.

Every transaction attempt in
[articleLifecycle.service.js](./services/articleLifecycle.service.js) now
authorizes restoration before content writes. A verified Founder retains
existing restore authority. Staff must have effective Manage News access,
`specialRightsConfigured === true`, `news_restore` in the normalized permanent
selection, and effective `news_restore` after temporary denials and Safe Zone.
Temporary-only restore grants are not accepted in this phase. Neither role
presets, legacy unconfigured selections, publishing/deletion rights, bylines,
assignments nor request claims substitute for the configured restore right.
There is no limited own-draft restore exception.

Staff restoration is limited to resolved deleted draft/archive groups. Every
affected edition and matching public copy must satisfy the protection checks:
no publication/scheduling provenance, unknown pre-delete state, locks, Founder
approval requirement, private visibility, active/invalid embargo, conflicting
group identities or unresolved source links. Matching public copies must be
deleted and belong to resolved CMS members. Broad Manage News restoration does
not derive authority from creator ownership; a foreign or missing creator alone
is neither a grant nor a denial. Any previously published/scheduled edition
keeps the whole restore Founder-only. Founder legacy Draft fallback for unknown
pre-delete history is retained and reported explicitly.

Canonical and legacy draft restore aliases share this service. Missing restore
entitlement returns HTTP 403 `ARTICLE_RESTORE_FORBIDDEN`; legacy errors also
propagate the machine-readable code. The unscoped legacy draft list requires
Manage News, not `news_restore` or `news_delete`. Restoration preserves IDs,
slugs, publication chronology, language synchronization, rollback/retry behavior
and deferred post-commit effects. No grants, migrations or client changes are
introduced.

#### Restore eligibility read contract

`GET /api/articles/:id/restore-eligibility` provides an informational assessment
of a deleted News story before displaying Restore. It uses the same article
router mounts as POST restore: root, `/api`, `/api/admin`, `/admin-api`,
`/admin-api/api`, `/admin-api/admin` and `/admin-api/api/admin`, including leading
duplicate-`/api` normalization. HEAD has the same guards. It is not a public API.
There are no query/body permission overrides or eligibility tokens.

The existing signed bearer/supported-cookie authentication is required. The new
internal read-only authentication mode in
[adminAuth.js](./middleware/adminAuth.js) retains persisted-account, lifecycle,
login and token-version checks without persisting account expiration. Before
looking up any article, the service rechecks the persisted actor inside a
snapshot read transaction. Founder is allowed; staff must satisfy the exact
POST restore entitlement: effective `manageNews`, `specialRightsConfigured === true`,
permanent `specialRightsOverride` containing `news_restore`, effective
`news_restore`, account eligibility and Safe Zone. Temporary-only restore,
role presets, other news rights and limited own-draft access do not qualify.
Entitlement denials return no article/member data and perform no article lookup.

[articleLifecycle.service.js](./services/articleLifecycle.service.js) shares
restore authority, News/source/group resolution, matching public-copy resolution,
staff scope checks, destination resolution and structural validation with POST.
Every resolved existing News edition and matching public copy is considered;
there is no selected-language filter or assumption that exactly three editions
must exist. A linked public-copy ID resolves to its News source; a public-only
or missing source does not become an independently restorable story.

HTTP 200 means the assessment completed, **not** that restoration is authorized.
The response contains only this envelope and allowlisted assessment data:

```json
{
  "ok": true,
  "success": true,
  "status": 200,
  "data": {
    "articleId": "507f1f77bcf86cd79943a001",
    "eligible": true,
    "decision": "eligible",
    "complete": true,
    "requiresFounder": false,
    "reasonCodes": [],
    "members": [
      {
        "id": "507f1f77bcf86cd79943a001",
        "language": "en",
        "status": "deleted",
        "restoreStatus": "draft",
        "historyKnown": true
      }
    ],
    "publicCopies": [
      {
        "id": "607f1f77bcf86cd79943a001",
        "sourceNewsId": "507f1f77bcf86cd79943a001"
      }
    ]
  }
}
```

The example is a valid one-edition story; arrays enumerate the full resolved
operation, not a paginated subset. `members` contains News records and their
individual proposed destinations. `publicCopies` identifies all existing
copies examined, without exposing their content or history. Invalid stored IDs
are represented as null in an incomplete assessment, never coerced into claims.
Language is `en`, `hi`, `gu`, or null for invalid metadata. `status` is a recognized
current lifecycle status or null. `restoreStatus` is `draft`, `archived`,
`published`, `scheduled`, or null when the history cannot safely be resolved;
`historyKnown` describes that destination, not a claim that all historical
events were retained. No raw history, notes, titles, slugs, creator/account
details or full deleted documents are returned.

- `eligible` is the current actor's result, not a durable grant.
- `decision` is `eligible`, `founder_required`, `blocked`, or `incomplete`.
  `founder_required` describes a fully assessed staff scope restriction;
  `blocked` describes a known structural/state conflict.
- `complete: false` always means `eligible: false` and `decision: "incomplete"`.
  Unknown/malformed history, unresolved/ambiguous identity, invalid metadata and
  incomplete publication cannot be interpreted as a known safe Draft.
- `requiresFounder` reports a group restriction that ordinary staff restore
  authority cannot satisfy. It does not assert that Founder can bypass a
  structural conflict or incomplete assessment. Founder may have
  `eligible: true` with this flag and explanatory reason codes.
- `reasonCodes` is a sorted, deduplicated list of non-sensitive findings.
  Findings can describe staff restrictions even in an eligible Founder response;
  they are not a replacement for `eligible`, `complete` and `decision`.

Assessment reason codes:

| Code | Meaning |
| --- | --- |
| `RESTORE_PUBLICATION_HISTORY` | Published/Scheduled provenance in a News member or matching copy; Founder required |
| `RESTORE_HISTORY_UNKNOWN` | A News member's pre-delete destination cannot be resolved |
| `RESTORE_HISTORY_INVALID` | Malformed pre-delete state or workflow history |
| `RESTORE_GROUP_IDENTITY_CONFLICT` | Conflicting News/group/copy keys |
| `RESTORE_SOURCE_UNRESOLVED` | A source link is outside the resolved News membership |
| `RESTORE_COPY_OWNERSHIP_CONFLICT` | A matching copy does not belong to a resolved News member |
| `RESTORE_MEMBER_IDENTITY_INVALID` | Invalid/duplicate stored IDs, language, status or identity field shapes |
| `RESTORE_INVALID_WORKFLOW` | Malformed workflow container |
| `RESTORE_METADATA_INVALID` | Invalid timestamps, flag types, stages or visibility metadata |
| `RESTORE_INVALID_SLUG` | Missing/blank/non-string slug or malformed language-slug data |
| `RESTORE_DUPLICATE_LANGUAGE` | Duplicate News editions for a language |
| `RESTORE_PUBLICATION_INCOMPLETE` | A Published destination lacks required existing publication data |
| `RESTORE_NOT_DELETED` | A News member or matching copy is not deleted; a non-deleted News member blocks all actors |
| `RESTORE_SLUG_CONFLICT` | A slug conflicts with a different News story |
| `RESTORE_LOCKED` | An edition/copy is locked |
| `RESTORE_FOUNDER_APPROVAL_REQUIRED` | An edition/copy requires Founder approval |
| `RESTORE_PRIVATE` | Private/non-public visibility prevents staff restoration |
| `RESTORE_EMBARGOED` | Active/invalid embargo prevents staff restoration |

Known negative assessments retain HTTP 200 with explicit negative data.
Request/resolution/storage errors instead return
`{ ok: false, success: false, status, code, message }` without `data`:
400 `INVALID_ARTICLE_ID` (requires an ObjectId/24-hex ID),
403 `ARTICLE_RESTORE_FORBIDDEN`,
404 `ARTICLE_NOT_FOUND`,
409 `ARTICLE_RESTORE_SCOPE_CHANGED`,
503 `RESTORE_ELIGIBILITY_UNAVAILABLE`, or
500 `RESTORE_ELIGIBILITY_FAILED`.
Authentication retains its existing 401/403 account/session errors and
`AUTH_UNAVAILABLE` 503 responses. Failures never become empty eligible groups.
All assessment responses, including authentication errors, carry
`Cache-Control: private, no-store`, `Pragma: no-cache`, and
`Vary: Authorization, Cookie` alongside existing Vary values.

Assessment performs no persistence writes, including denial audits, account
expiry updates, settings initialization, News/public-copy changes, translation
work, cache invalidation or index operations. It creates no grants, jobs or
stored assessment state. Existing connection/startup index policy is unchanged.

The preview is deliberately fail-closed for unknown legacy history even for
Founder: `restoreStatus: null` requires manual review, not a guessed Draft.
The existing explicit Founder POST fallback to Draft and its
`restoreFallbackIds` response remain unchanged. Other valid Founder restore
capabilities and existing mutation response envelopes are preserved.

Admin must enable staff Restore only for a complete, eligible assessment and
still handle POST denials/conflicts. POST never consumes the assessment as
authority: it independently resolves the current group, reloads permissions,
validates all affected records and reauthorizes inside every transaction attempt,
including retries. Changes after a GET can therefore invalidate its result.

Archived-to-Draft is a separate Founder-only lifecycle transition through
`PUT/PATCH /api/articles/:id`; changed `status` remains forbidden to staff even
with `news_edit` or permanent `news_restore`. This API does not authorize
unarchiving, publishing, scheduling or permanent deletion.

### Article content-save authorization and synchronization

[articleSaveAccess.service.js](./services/articleSaveAccess.service.js) protects
canonical `PUT/PATCH /articles/:id` on every existing router mount: the root,
`/api`, `/api/admin`, `/admin-api`, `/admin-api/api`, `/admin-api/admin` and
`/admin-api/api/admin`. Leading duplicate `/api` normalization uses the same
handlers. Legacy `PUT/PATCH /api/news/:id` and `/api/api/news/:id` use the same
authorization rules but retain their single-record update behavior; they do not
silently acquire canonical group synchronization.

- A verified Founder retains authorized editorial control.
- Other broad content edits require effective `manageNews` Staff Access and
  effective `news_edit`. Module policy, account eligibility, Safe Zone,
  configured permanent rights and active temporary grants/denials are reused,
  not replaced by role names or a second permission system.
- Without broad edit authority, effective `addNews` or `draftDesk` permits a
  save only when every required CMS write is to an unlocked, unscheduled draft
  with the same verified `createdByUserId` as the authenticated account.
  Published siblings, other creators and unknown/generated creators fail
  closed. A group ID, byline, task link or client creator claim is not ownership.
- Limited rights do not authorize a linked Youth Pulse submission/contributor
  update merely because the News draft is owned. Such saves require an
  authorized Editor or Founder. Editors' actual stored Youth Pulse links are
  preflighted and checked by the real News save hook.
- Public-only records have no inferred creator exception. They require broad
  edit authority; staff cannot edit deleted records through that fallback.

The authenticated context is adapted from `req.admin`/`req._authUserDoc`.
Authorization reloads the account and resolves the complete group before the
first content or group-wide `syncVersion` write, inside the existing article
transaction. The version guard is bound to the approved IDs and their expected
status, identity and, for limited drafts, creator/lock state. Transaction retries
discard the previous scope and deferred effects and reauthorize.

Metadata, translation buckets, current/previous-slug public-copy matches and
Youth Pulse related writes remain in that transaction. Public writes are bound
to resolved copy IDs (or a new allocated ID). Their planned ordering preserves
mixed draft/published shared-slug groups without releasing draft text or
changing existing visibility gates; final copy state is checked before commit.
Faith topic-only source changes now share the synchronization transaction.
Youth Pulse submission saves and contributor statistics use the same session;
a transactional hook failure aborts the save rather than being swallowed.
Authorization and protected enqueue configuration reads do not create or
backfill settings.

Ordinary staff content saves cannot change publication, scheduling, deletion, restoration,
workflow/visibility controls or source/group linkage through the request body.
An unchanged `status` accompanying a content save is a no-op. Canonical requests
explicitly publishing a draft, or submitting only a published status/reason,
instead use the separate scoped publication authorizer before the first write.
Canonical
allowlists continue to ignore resubmitted computed sync/timestamp/ID fields
rather than treating them as editable data. The raw legacy updater rejects
changes to server-controlled fields and Mongo operator payloads from staff.
Creation follows the policy above rather than a blanket `news_edit` requirement;
existing creator stamping and authorized draft contracts remain intact.
Canonical create-as-published uses the same verified publication authority.
Scheduling and other protected lifecycle boundaries remain independent and
unchanged; restoration follows the explicit restore policy above.
Manual translation-generation/backfill endpoints also retain their existing
authorization; this PUT/PATCH correction does not certify those independent
entry points.

Response compatibility:

- Canonical success retains `ok`, `success`, `status`, `message`, `article` and
  `data.article`; legacy success remains `{ message: "News updated successfully" }`.
- Permission denial is HTTP 403 `ARTICLE_SAVE_FORBIDDEN`. Canonical responses
  retain `{ ok: false, success: false, status: 403, code, message }`; legacy
  responses use `{ error, code }`. The generic message requires an authorized
  Editor or Founder and does not identify private siblings.
- Scope/state conflicts return 409 and require reloading. An unauthorized main
  save does not partially persist article, public-copy, job or Youth Pulse
  changes, and does not invalidate related caches.
- Translation enqueue runs in a separate post-commit transaction and rechecks
  the current account and group. Revocation or a follow-up failure cannot undo
  an already committed edit. The existing HTTP 200 `committed: true` and
  `postCommitWarnings`/`revalidation` contract remains authoritative: reload the
  saved state, do not report rollback or blindly repeat the save. Public-only
  cache invalidation also uses the committed-save warning mechanism.

No ownership backfill, account mutation, new role/right, migration or pending
revision workflow is introduced.

The Reporter Portal has its own OTP/session and ownership flow in
[reporterPortal.js](./routes/reporterPortal.js),
[reporterPortalAuth.js](./middleware/reporterPortalAuth.js), and
[reporterPortalSessionService.js](./services/reporterPortalSessionService.js).
[CommunitySubmission.js](./models/CommunitySubmission.js) is distinct from
News. [communityDraftFromSubmission.js](./services/communityDraftFromSubmission.js)
can create a linked News draft; submission approval is not itself public
publication.

The public-settings flow uses
[PublicSiteSettings.js](./models/PublicSiteSettings.js) and
[publicSiteSettingsController.js](./controllers/publicSiteSettingsController.js)
to separate draft/admin operations from published public reads. Legacy
[siteSettings.routes.js](./routes/siteSettings.routes.js) also exists; do not
conflate its model or endpoint with the canonical public-settings flow.

## Analytics, integrations, and operations

[articleAnalytics.service.js](./services/articleAnalytics.service.js) uses
Article identity with event, deduplication, daily, and summary models. Replacing
a public article to repair metadata would cross this identity boundary.

[cache.js](./lib/cache.js) and [redis.js](./lib/redis.js) support shared caching;
[publicContentInvalidation.service.js](./services/publicContentInvalidation.service.js)
handles public-content invalidation/revalidation. Redis is configuration-driven
and disabled by default in tests. Cache eligibility and HTTP cache headers are
route-specific.

Public-news feed keys in [publicNews.routes.js](./routes/publicNews.routes.js)
use `v3` for latest/general-category responses and `faith-v2` for Faith & Culture.
Stale, rebuild-lock and canonical last-known-good keys inherit the feed version.
Cache misses and prewarming populate the current namespace through the public
controller and serializer; retired `v2`/`faith-v1` responses are not read or copied.
The version change does not purge retired entries. The shared `np:v1` prefix,
hash inputs, TTLs and article-invalidation prefixes remain unchanged, as do the
separate advertising, broadcast and settings cache namespaces.

External adapters include [mailer.js](./lib/mailer.js) for scoped mail delivery,
[cloudinary.js](./lib/cloudinary.js) for media,
[googleTranslate.service.js](./services/googleTranslate.service.js) for
translation, and [firebaseAdmin.js](./lib/firebaseAdmin.js) for Firebase.
Presence in the code does not prove a provider is configured or healthy.
Development mail stubs and Reporter OTP scope are intentional parts of the
environment boundary.

[environmentSafety.js](./lib/environmentSafety.js) defines local/production
checks and CORS helpers. Direct server startup can trigger database, index,
worker, and cleanup activity; importing the app in tests is not a substitute
for isolating environment variables and external adapters.

In production-like environments (production `NODE_ENV` or Render indicators),
[server.js](./server.js) sets Mongoose `autoIndex` and `autoCreate` to Boolean
`false` before importing application models and skips the five startup
`syncIndexes()` calls. Non-production index bootstrap is unchanged. Read-only
TTL audits, health checks, workers, cleanup and publication scheduling remain
active under their existing conditions. Production collections and required
indexes must already exist; startup neither installs missing indexes nor
reconciles drift. Index maintenance remains a separate, explicitly authorized
operation, not a deployment side effect. Rollback builds must retain this policy.

## Validation entry points

[package.json](./package.json) defines `npm test` as Node's test runner and
`npm run build` as a syntax check of the root server, not a bundled build.
Representative regression suites include:

- [article_publishing_pipeline.test.js](./tests/article_publishing_pipeline.test.js)
- [staff_news_publish_authorization.test.js](./tests/staff_news_publish_authorization.test.js)
- [special_rights_precedence.test.js](./tests/special_rights_precedence.test.js)
- [article_publication_bypass_regression.test.js](./tests/article_publication_bypass_regression.test.js)
- [sync_public_article_clears_deleted_at_on_publish.test.js](./tests/sync_public_article_clears_deleted_at_on_publish.test.js)
- [public_regional_state_lang_ready_only.test.js](./tests/public_regional_state_lang_ready_only.test.js)
- [public_article_visibility_regression.test.js](./tests/public_article_visibility_regression.test.js)
- [translation_group_sync.test.js](./tests/translation_group_sync.test.js)
- [environment_safety.test.js](./tests/environment_safety.test.js)
- [reporter_portal_mvp.test.js](./tests/reporter_portal_mvp.test.js)

Run the relevant tests with isolated dependencies, not against production.
This list describes coverage locations, not a claim that every suite currently
passes.
