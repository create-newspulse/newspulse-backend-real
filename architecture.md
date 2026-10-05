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
metadata-only maintenance operation. A saved News publication can report
incomplete public synchronization through `publicSync: { ok, failedArticleIds }`;
do not treat that flag as equivalent to the overall save result.

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

The root server also runs a scheduled-publication tick outside test/import mode.
[scheduledPublication.service.js](./services/scheduledPublication.service.js)
has separate ordinary-article and Pulse Dialogue branches; the latter delegates
to canonical publication. Do not assume all scheduled or legacy write paths
are identical to a CMS publish request.

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
requests select originals or ready cached translations; Gujarati reads retain
the endpoint's existing base-language fallback. Language-variant deduplication
is a separate part of response handling.

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

## Validation entry points

[package.json](./package.json) defines `npm test` as Node's test runner and
`npm run build` as a syntax check of the root server, not a bundled build.
Representative regression suites include:

- [article_publishing_pipeline.test.js](./tests/article_publishing_pipeline.test.js)
- [sync_public_article_clears_deleted_at_on_publish.test.js](./tests/sync_public_article_clears_deleted_at_on_publish.test.js)
- [public_regional_state_lang_ready_only.test.js](./tests/public_regional_state_lang_ready_only.test.js)
- [public_article_visibility_regression.test.js](./tests/public_article_visibility_regression.test.js)
- [translation_group_sync.test.js](./tests/translation_group_sync.test.js)
- [environment_safety.test.js](./tests/environment_safety.test.js)
- [reporter_portal_mvp.test.js](./tests/reporter_portal_mvp.test.js)

Run the relevant tests with isolated dependencies, not against production.
This list describes coverage locations, not a claim that every suite currently
passes.
