# Pulse Dialogue Profiles and Archives

## Architecture and Compatibility

The existing Contributor collection remains the only contributor system.
Canonical News records remain the archive source; public Article mirrors are not
unioned into archive results. Existing Add News, editorial review, publication,
scheduling, translation generation, and translation-group synchronization remain
the publishing workflow.

Reused Contributor fields: `slug`, `canonicalName`, `displayNameHi`,
`displayNameGu`, `photo` (`url`, `publicId`, `alt`), `publicDesignation`,
`shortBio`, and `status`. Existing internal fields remain Admin-only.

New Contributor field: `profileVisible`, boolean, default false. The existing
status enum gains `hidden`; `draft`, `active`, and `inactive` remain supported.
Only active/inactive contributors with `profileVisible: true` have public
profiles and archives. General Contributor discovery includes only active,
visible contributors. Missing visibility is treated as false. Inactive
contributors retain historical profiles/archives but are excluded from discovery
and cannot be published as new contributors under the unchanged Phase 1 check.

| Status | profileVisible | Public profile/archive | General discovery |
| --- | --- | --- | --- |
| active | true | Available | Included |
| inactive | true | Available | Excluded |
| hidden | any | 404 | Excluded |
| draft | any | 404 | Excluded |
| any | false/missing | 404 | Excluded |

Historical published contributor name/photo snapshots remain visible regardless
of later profile visibility/status changes.

Existing `pulseDialogue.contributorId`, `dialogueFormat`, `series`,
`bylineSnapshot`, `bylineDesignationOverride`, `showAboutContributor`,
`contributorDisclosure`, `contributorDisclaimer`, and `editorNote` are retained.
Normal `authorByline` remains independent. Standard disclosure/disclaimer text,
editor notes, explicit localized byline names, and snapshot fallback behavior
are unchanged.

## Stable Slugs and Series

Contributor creation generates a Unicode-safe slug using the existing slug
utility. Generated collisions retry inserts as `name-2`, `name-3`, etc., bounded
to 100 attempts. Creation checks both current and reserved historical slugs.
Explicit duplicate slugs return 409. Name-only edits never change slugs.
Ordinary profile PUT/PATCH containing any `slug` field (even the unchanged value)
returns 400 with `Use the dedicated contributor slug-change action`, before any
write. Omit slug entirely from ordinary profile edits.

Contributor storage uses `slug` for the current canonical identity and the new
`slugHistory` string array for ALL reserved names, including the current slug.
Reservations are retained through the Admin contract, normalized using the shared
Contributor helper (string-only, decoded, NFKC, lowercase, Unicode slug rules),
and deduplicated. Invalid values are removed on intentional history writes.
History cannot be supplied/cleared through ordinary profile writes. Example after an explicit edit:

```json
{"slug":"shailesh-rathod-journalist","slugHistory":["shailesh-rathod","shailesh-rathod-journalist"]}
```

The existing unique current-slug index remains. A unique multikey `slugHistory`
index with partial filter `{"slugHistory.0":{"$exists":true}}` reserves every
array member across contributors. Keeping current and historical names in this
same indexed array prevents cross-field uniqueness races. Creation stores its
initial slug in history. Rename checks all normalized reservations against other
contributors, then atomically sets slug and normalized history including old/new
names, conditional on both the previously read slug and history. Concurrent stale
edits return 409 rather than losing history.
The owner may explicitly restore its own historical slug; every other name stays
reserved. No historical slug may be transferred to another contributor.

Legacy contributors without history remain readable by current slug. A legitimate
ordinary profile write best-effort initializes a missing history only when the
current slug is already canonical, no other exact reservation conflicts, and a
conditional write confirms the slug/history have not changed. Conflicting,
malformed or concurrently changed records are left for release preflight; profile
edits still succeed and never change the slug. No article snapshot is rewritten.
Admin responses expose slugHistory; public profile summaries do not.

### Slug Rename Capability

`PULSE_DIALOGUE_CONTRIBUTOR_SLUG_RENAME_ENABLED` defaults to false in every runtime.
Only the explicit value `true` (case-insensitive, surrounding whitespace ignored)
requests enablement. It is the operator's attestation that release preflight and
the version transition are complete, not a replacement for those steps.
Backend additionally reads the actual indexes and checks for missing canonical
reservations on each capability/rename request. Both named unique indexes must
match the expected key/options; no sparse, hidden, differently collated or
incorrect partial index is accepted. Missing reservations, read errors or index
mismatches fail closed. No index creation occurs in these checks.

Authenticated `GET /api/admin/pulse-dialogue/contributors/capabilities` (and the
existing Contributor admin aliases) returns:

```json
{"ok":true,"success":true,"capabilities":{"slugRename":false},"data":{"capabilities":{"slugRename":false}}}
```

Admin should disable Change Public URL unless `capabilities.slugRename === true`.
This endpoint reveals no index metadata or connection information. Public routes
are unchanged. Disabled `PATCH /:id/slug` returns HTTP 503:

```json
{"ok":false,"success":false,"code":"CONTRIBUTOR_SLUG_RENAME_UNAVAILABLE","capabilities":{"slugRename":false},"message":"Contributor slug changes are temporarily unavailable pending release readiness."}
```

When the flag is off this action performs no Contributor database reads/writes.
Authentication still runs first. When enabled and verified, the existing success,
validation, duplicate-conflict, stale-write and alias-response contracts apply.

The new `PulseDialogueSeries` registry contains exactly these application fields:

| Field | Contract |
| --- | --- |
| slug | Required, unique, generated if omitted, immutable after creation |
| title | Required, max 200 characters |
| description | Optional, max 1000 characters |
| ownerContributorId | Optional reference to the existing Contributor |
| profileVisible | Boolean, default false |

Mongoose also supplies `_id`, timestamps, and its normal version key.
Columns and Series use this one registry, not separate publishing systems.

News and Article gain optional `pulseDialogue.seriesSlug`. Existing
`pulseDialogue.series` remains the article label. Admin article writes validate
that a supplied non-null slug exists. Send null to remove the association.
Changing a registry title does not rewrite article labels or byline snapshots.
Legacy text-only Series are not automatically assigned to a registry entry.

## Public API

Base: `/api/public/pulse-dialogue`

| Method | Path | Response |
| --- | --- | --- |
| GET | /contributors | Paginated public profile summaries |
| GET | /contributors/:slug | Contributor summary and contributionCount |
| GET | /contributors/:slug/articles | Contributor summary, contributionCount, article cards and pagination |
| GET | /series | Paginated visible Series summaries |
| GET | /series/:slug | Series summary, safe optional ownerContributor, articleCount |
| GET | /series/:slug/articles | Series summary, articleCount, article cards and pagination |

Identical public aliases exist under `/admin-api/public/pulse-dialogue` and
`/admin-api/api/public/pulse-dialogue`. These endpoints are GET-only and do not
generate translations or write data. Responses use `Cache-Control: no-store`.
Missing, hidden, draft, or invisible profiles return 404 for both profile and
archive. Invisible/missing Series return 404. Visible empty archives return 200.

Contributor profile and archive lookup resolve either current slug or slugHistory
under the SAME visibility rules. For an old-slug request only, the JSON response
adds top-level `requestedSlug`, `canonicalSlug`, and `redirectRequired: true`.
The contributor summary always exposes the current canonical slug. HTTP remains
200 with no Location header. Current-slug requests retain their existing response
shape (these extra redirect fields are omitted). Frontend performs the permanent
webpage redirect, preserving the page/locale as appropriate. Alias requests for
hidden/draft/invisible contributors return 404 with no redirect information.

Contributor summaries allowlist only `slug`, `name` (canonicalName),
`publicDesignation`, `photoUrl`, and `shortBio`. Optional values are null.
Photo URLs must be HTTP(S). Detail/archive responses add `contributionCount`.
No contributor ID, contact details, asset storage ID, rights notes, permissions,
or moderation metadata are included in these profile summaries.

Series summaries allowlist `slug`, `title`, and `description`. Detail/archive
responses add `articleCount` and `ownerContributor`, which is null when missing
or not publicly visible. An unavailable owner does not hide an otherwise public
Series or its published articles.

Pagination: `page` defaults to 1 and is capped at 10000; `limit` defaults to 12
and is clamped to 1-50. Invalid numeric input uses defaults. Responses contain
`items`, `total`, `count` (returned page length), `page`, `limit`, `totalPages`,
and `hasNextPage`. Archives group before paginating, then sort by the selected
edition's publishedAt and createdAt, using the existing category-feed resolver.
Discovery totals count profiles/Series, not stories. Empty lists have
`totalPages: 0`; an out-of-range page keeps the real total with empty items.

`contributionCount`, `articleCount`, and archive `total` count UNIQUE publicly
visible Pulse Dialogue stories, not language editions. Identity uses the existing
`getPublicContentGroupKey`: trimmed translationKey, then translationGroupId,
then canonical slug (slugs.en, slug, slugs.hi, slugs.gu), then document _id.
No new identity or backfill is introduced. EN/HI/GU editions in one group count
once. Profile/Series detail counts do not shrink with the requested language.

Archive locale precedence follows public News: `lang`, `language`, `X-Lang`,
`X-Language`, default `gu`. Existing supported locale aliases are normalized;
unsupported supplied values return 400. Archive responses add top-level `lang`.
Discovery does not localize names or filter on language. Detail endpoints may
accept the same language inputs, but their public profile text and counts stay
the same across locales.

Each group uses the existing grouped public category resolver: prefer a stored
requested-language edition, otherwise a usable complete cached translation,
otherwise a base-language edition. Cached translations require the existing
published-locale checks (complete, ready or allowed legacy missing status).
Missing/pending translations do NOT remove a story; category-feed base fallback
is enabled. Ties use the resolver's publication/creation ordering. The explicit
`fallback` query does not disable category fallback, matching category feeds.
There is never more than one card per group on an archive page or across pages
of an unchanged dataset. Private/draft siblings never become fallback candidates.

Inspect each card's `resolvedLang`/`resolvedLanguage`, `requestedLang`, and
`isFallback`; top-level `lang` is the requested locale, not a promise that every
card has that locale. Identity, canonical profile name, photo, and Series slug
remain shared. No profile text is machine-translated and no Contributor is
created per translation. Existing card translation-availability fields describe
the selected document; they are not recomputed as a group-wide language summary.

Archive filters reuse canonical public News visibility: published Pulse Dialogue
only, excluding deleted, private, locked, embargoed, and future/scheduled records,
including workflow-level restrictions. Cards reuse the existing public News
projection and serializer with batched contributor attachment. Phase 1 card
fields, including its pre-existing contributor ID fields, remain compatible.

## Admin and Frontend Integration

Contributor base: `/api/admin/pulse-dialogue/contributors`, plus
`/admin-api/admin/pulse-dialogue/contributors` and
`/admin-api/api/admin/pulse-dialogue/contributors`.
GET/POST collection, GET `/:id` (also slug lookup), PUT/PATCH `/:id` (MongoDB ID).
Existing `requireAdminAuth` protects all Contributor and Series Admin routes.

Contributor update body is top-level, not nested under `contributor`:

| Accepted update field | Current behavior |
| --- | --- |
| publicDesignation | Trimmed string, max 300; null/empty clears |
| shortBio | Trimmed string, max 1000; null/empty clears |
| photo | URL string, or object with url/publicId/alt; null clears |
| status | draft, active, inactive, hidden; null/empty maps to draft |
| profileVisible | Strict boolean; false by default |
| canonicalName | Existing display-name edit, never regenerates slug |
| slug | Forbidden in ordinary profile PUT/PATCH; use the dedicated action |

The existing photo aliases assetUrl/secureUrl, storageId, altText remain accepted.
Send canonical fields in new clients. Do not send public output `photoUrl` or
`name` as Admin update fields; use `photo` and `canonicalName`.

Explicit slug action (same existing Admin authentication/authorization):

`PATCH /api/admin/pulse-dialogue/contributors/:id/slug`

Aliases: `/admin-api/admin/pulse-dialogue/contributors/:id/slug` and
`/admin-api/api/admin/pulse-dialogue/contributors/:id/slug`.

```json
{"slug":"shailesh-rathod-journalist"}
```

This action accepts ONLY a slug string; extra fields are rejected. It normalizes
with the existing Unicode slug utility, max 120 characters. Empty/punctuation-only
slugs, non-string values, extra fields, or invalid IDs return 400. Missing
contributors return 404. A current/historical slug belonging to anyone else,
unique-index conflicts, or a stale concurrent edit return 409. A current-slug
request is idempotent (and initializes history on a legacy record).
Success is HTTP 200 with `{ok:true, success:true, contributor, data:{contributor}}`,
using the existing Admin DTO, now including `slugHistory`. No article or byline
snapshot is rewritten. Only Pulse Dialogue category caches are invalidated.

Series Admin base: `/api/admin/pulse-dialogue/series`, plus
`/admin-api/admin/pulse-dialogue/series` and
`/admin-api/api/admin/pulse-dialogue/series`.
Supported methods: GET/POST collection, GET `/:id` (also slug lookup), and
PUT/PATCH `/:id` (MongoDB ID). Existing Admin authentication is required.
There is no delete endpoint. Series create accepts top-level `title` (required),
optional `slug`, `description`, `ownerContributorId`, and `profileVisible`.
PUT/PATCH accepts the same fields except slug; any supplied slug returns 400.
Omitted update fields are retained; null clears description/ownerContributorId.
An owner ID must identify an existing Contributor; it may be inactive/hidden, but
its public owner summary is null unless that Contributor has a public profile.
Series Admin list accepts page/limit, defaults 1/20, caps 10000/100, and returns
`{ok, items, total, page, limit}`. Detail/create/update return `{ok, series}`;
create returns 201, reads/updates 200, duplicate creation slugs 409.

Admin must explicitly enable profile visibility after editorial/consent review.
Use the existing Contributor selector and optional Series registry selector.
Use existing `POST /api/admin/articles` and `PUT /api/admin/articles/:id`
(also existing /api/articles and admin-api aliases), not a new publish endpoint.
The relevant assignment body, for a Pulse Dialogue article, is:

```json
{"pulseDialogue":{"contributorId":"507f1f77bcf86cd799439a01","series":"Ideas","seriesSlug":"ideas"}}
```

`contributorId` must accompany any pulseDialogue payload, including updates.
`series` is the optional article display label, max 200. `seriesSlug` is the
optional registry association; non-null values must be safe existing slugs.
Do not send `seriesId`, `columnId`, or a nested Series object; they are not accepted
assignment fields. Registry title changes do not replace article label text.
To clear BOTH the Series label and archive association, send:

```json
{"pulseDialogue":{"contributorId":"507f1f77bcf86cd799439a01","series":null,"seriesSlug":null}}
```

Omitting either series field on an update preserves that field. `seriesSlug: ""`
is invalid. Existing `dialogueFormat` remains required for publication and is
unchanged by a partial assignment update. Create still needs the normal required
article fields and Pulse Dialogue category. Do not silently assign legacy
published articles or change their snapshots.

Public Pulse Dialogue article payloads gain `contributorSlug` and
`profileAvailable`, computed from the current Contributor at read time. Frontend
must gate profile links on `profileAvailable === true`; unavailable links have a
null contributorSlug. Availability requires a routable slug, active/inactive
status, and profileVisible true. Invalid legacy slugs are not advertised as
reachable. Keep rendering historical bylines from `bylineSnapshot`,
not the current profile. Existing article-level About Contributor behavior is
not governed by the new profile-page visibility flag.

Frontend should URL-encode slugs, send the current locale for localized archives,
handle 404/empty states, and retain existing article routes and byline rendering.
Use `seriesSlug` for optional Series archive links and handle unavailable Series.

## Operational Boundaries

No migration or historical backfill is part of this foundation. Existing profiles
stay unavailable until explicitly opted in. Existing publication/republication
remains the explicit editorial path that may refresh a snapshot.

Before enabling this action in any deployment, verify BOTH Contributor unique
indexes (slug and slugHistory) have been created successfully. The history index
is required for race-safe namespace reservation; application prechecks alone do
not replace it. Review existing data/index compatibility and the Series/article
indexes in isolated staging first. No database index creation is executed by this
task. Mocked tests do not prove production index state or query plans.

### Two-Stage Production Release

Contributor alone sets `autoIndex: false` and `autoCreate: false` whenever
`NODE_ENV=production` or the repository's Render environment detection applies.
All Contributor index declarations remain, including the existing `slug_1`.
Nothing drops/modifies that existing index. Development/tests retain Mongoose
defaults. Unrelated models' startup index behavior is unchanged.

1. Obtain Founder approval for the initial deploy with rename explicitly false.
	Keep Contributor URL edits paused during the rolling replacement: old Phase 1
	instances cannot honor the new flag and accept slug edits through ordinary
	updates. If that cannot be enforced at the old Admin workflow, pause Contributor
	writes for the transition. Public reading is unaffected.
2. Confirm every old instance is drained. Keep rename false. Pause all Contributor
	writes for the following release operations; flags below are operator
	acknowledgements, not an automatic distributed lock.
3. Use an approved operator environment to supply `PULSE_DIALOGUE_RELEASE_MONGODB_URI`
	and `PULSE_DIALOGUE_RELEASE_DBNAME` securely. The tool does not load `.env`, use
	the application's connection fallback, import models, or start the server.
	Use read-only database credentials for audit/verify when available. The explicit
	database name overrides any URI database; confirm the target before running.
4. Run the audit and resolve reported blockers through a separately approved plan.
	The tool reports IDs/counts, normalized reservation conflicts, missing/invalid
	slugs and histories, duplicates, current/history gaps and actual index options.
	It bounds the scan at 100,000 contributors and database reads at 10 seconds;
	exceeding these bounds fails rather than reporting a partial pass. Non-simple
	collection collation, validators and special collection options require review.
5. Approve and apply safe reservation initialization separately. This only appends
	the existing canonical slug to a missing/empty or otherwise clean history.
	It never renames, removes history, repairs malformed data or touches snapshots.
	It refuses conflicts and uses conditional per-record updates with majority
	acknowledgement. It is resumable, not all-or-nothing: a concurrent-change/error
	stops further work but earlier successful updates remain. Re-audit before retry.
6. Approve history-index creation separately, then verify. Creation refuses gaps,
	conflicts, an unverified canonical index, or a differently configured history
	index. It only creates `slugHistory_1` with `{slugHistory:1}`, `unique:true` and
	`partialFilterExpression:{"slugHistory.0":{$exists:true}}`. It never drops,
	replaces, synchronizes or creates the canonical index. An exact existing history
	index is a no-op. Creation is followed by another full read-only audit.
7. Only after verify reports `ready:true`, approve setting the rename flag to true
	on the new-version-only fleet. Check the authenticated capability before
	resuming Contributor writes and exposing Change Public URL. Turning the flag
	off disables renaming again without undoing reservations or indexes. Do not
	roll back to Phase 1 writers after enabling history-based renames.

Prepared commands below are for later approval; none is run as part of this task:

```powershell
node scripts/contributor-slug-history-release.js
node scripts/contributor-slug-history-release.js --action=backfill --dry-run
node scripts/contributor-slug-history-release.js --action=backfill --apply --writers-paused --new-version-only
node scripts/contributor-slug-history-release.js --action=create-index --dry-run
node scripts/contributor-slug-history-release.js --action=create-index --apply --writers-paused --new-version-only
node scripts/contributor-slug-history-release.js --action=verify
```

No arguments defaults to read-only audit; any action without `--apply` is read-only.
`--apply` is accepted only for backfill/create-index, with both rollout acknowledgements
and the rename flag off. Audit/verify cannot write. Exit 0 means readiness verified;
exit 2 means the report completed but readiness remains incomplete (including a
successful backfill before index creation); exit 1 means refusal/error. Connection
errors are reduced to a safe code; credentials, URIs and driver errors are not logged.

### Archive Operations

Grouping reuses the existing category implementation, which materializes matched
documents before pagination; the output page is bounded but total scan work is
not capped. Profile counts read only identity fields. Large archives need staging
query-plan/memory measurement and may need measured compound indexes later.

Successful explicit slug changes and profile updates containing status/profileVisible use the
existing safeDeleteByPrefix helper only for `np:v1:category:pulse-dialogue:*`.
This removes that category's locale/page/variant, stale, and lock keys when Redis
is available. No broad invalidateArticleCaches call is made. Latest, home,
trending, other categories, and unrelated article keys are not flushed.
Invalidation is best-effort; Redis outages/concurrent readers can retain old
responses temporarily. Mixed-feed caches continue their existing expiry/rebuild
policy (public News fresh TTL 45 seconds plus 0-15 seconds spread, with stale
serving); last-known-good recovery during outages can retain older content.
Public News detail reads have no response cache in their router. The uncached
profile/archive endpoints remain authoritative and enforce 404 immediately on
their next successful current-data read. This change does not remove snapshots.

Release, production data edits, and any backfill require separate Founder approval.

## Exact Public Response Examples

These runtime-verified fixture examples contain one story stored in EN/HI/GU,
one active visible Contributor without photo/bio, and one visible owned Series.
Fields absent from the underlying article remain optional under the existing
card serializer. The IDs below are fixed test fixtures, not production data.

### Response: GET /contributors

```json
{"ok":true,"items":[{"slug":"writer","name":"Writer","publicDesignation":null,"photoUrl":null,"shortBio":null}],"total":1,"count":1,"page":1,"limit":12,"totalPages":1,"hasNextPage":false}
```

### Response: GET /contributors/writer

```json
{"ok":true,"contributor":{"slug":"writer","name":"Writer","publicDesignation":null,"photoUrl":null,"shortBio":null,"contributionCount":1}}
```

### Response: GET /contributors/writer/articles?lang=en

```json
{
	"ok": true,
	"contributor": {"slug":"writer","name":"Writer","publicDesignation":null,"photoUrl":null,"shortBio":null,"contributionCount":1},
	"items": [{
		"_id":"000000000000000000000001","title":"Story en","description":"Summary","content":"<p>Body</p>",
		"slug":"story-en","slugs":{"en":"story-en","hi":"story-hi","gu":"story-gu"},
		"category":"pulse-dialogue","status":"published","language":"en","lang":"en","originalLang":"en",
		"translationKey":"story-1","translationGroupId":"story-1","publishedAt":"2020-01-01T00:00:00.000Z",
		"pulseDialogue": {
			"profileAvailable":true,"contributorSlug":"writer","contributorId":"507f1f77bcf86cd799439a01",
			"dialogueFormat":"column","series":"Ideas","seriesSlug":"ideas",
			"contributorDisclosure":"This article is a contributor submission published after editorial review by News Pulse.",
			"contributorDisclaimer":"The views expressed in this contribution are those of the author and do not necessarily reflect the views of News Pulse.",
			"showAboutContributor":false,
			"bylineSnapshot":{"name":"Writer","designation":null,"affiliation":null,"photo":null},
			"contributor":{"id":"507f1f77bcf86cd799439a01","name":"Writer","canonicalName":"Writer","photo":null,"publicDesignation":null,"affiliation":null,"shortBio":null,"slug":"writer","website":null,"socialLinks":{}}
		},
		"requestedLang":"en","resolvedLang":"en","isTranslated":false,"summary":"Summary",
		"imageUrl":null,"coverImageUrl":null,"imageAlt":null,"imageCaption":null,
		"canonicalSlug":"story-en","localizedSlug":"story-en","localizedTitle":"Story en","localizedContent":"<p>Body</p>",
		"locale":"en","articleId":"000000000000000000000001","availableLocales":["en"],"publishedLocales":["en"],
		"requestedLanguage":"en","resolvedLanguage":"en","isFallback":false,
		"translationAvailability":{"requestedLang":"en","requestedLanguage":"en","resolvedLang":"en","resolvedLanguage":"en","isFallback":false,"isTranslated":false,"requestedLocalePublished":true,"translations":{"en":false,"hi":false,"gu":false},"availableLocales":["en"],"publishedLocales":["en"],"fallbackEnabled":true},
		"canonicalDetailUrl":"/news/story-en","detailApiUrl":"/api/public/news/story-en?lang=en&fallback=true",
		"id":"000000000000000000000001","excerpt":"Summary","readMinutes":1
	}],
	"lang":"en","total":1,"count":1,"page":1,"limit":12,"totalPages":1,"hasNextPage":false
}
```

### Response: GET /series

```json
{"ok":true,"items":[{"slug":"ideas","title":"Ideas","description":null}],"total":1,"count":1,"page":1,"limit":12,"totalPages":1,"hasNextPage":false}
```

### Response: GET /series/ideas

```json
{"ok":true,"series":{"slug":"ideas","title":"Ideas","description":null,"ownerContributor":{"slug":"writer","name":"Writer","publicDesignation":null,"photoUrl":null,"shortBio":null},"articleCount":1}}
```

### Response: GET /series/ideas/articles?lang=en

```json
{
	"ok": true,
	"series":{"slug":"ideas","title":"Ideas","description":null,"ownerContributor":{"slug":"writer","name":"Writer","publicDesignation":null,"photoUrl":null,"shortBio":null},"articleCount":1},
	"items": [{
		"_id":"000000000000000000000001","title":"Story en","description":"Summary","content":"<p>Body</p>",
		"slug":"story-en","slugs":{"en":"story-en","hi":"story-hi","gu":"story-gu"},
		"category":"pulse-dialogue","status":"published","language":"en","lang":"en","originalLang":"en",
		"translationKey":"story-1","translationGroupId":"story-1","publishedAt":"2020-01-01T00:00:00.000Z",
		"pulseDialogue": {
			"profileAvailable":true,"contributorSlug":"writer","contributorId":"507f1f77bcf86cd799439a01",
			"dialogueFormat":"column","series":"Ideas","seriesSlug":"ideas",
			"contributorDisclosure":"This article is a contributor submission published after editorial review by News Pulse.",
			"contributorDisclaimer":"The views expressed in this contribution are those of the author and do not necessarily reflect the views of News Pulse.",
			"showAboutContributor":false,
			"bylineSnapshot":{"name":"Writer","designation":null,"affiliation":null,"photo":null},
			"contributor":{"id":"507f1f77bcf86cd799439a01","name":"Writer","canonicalName":"Writer","photo":null,"publicDesignation":null,"affiliation":null,"shortBio":null,"slug":"writer","website":null,"socialLinks":{}}
		},
		"requestedLang":"en","resolvedLang":"en","isTranslated":false,"summary":"Summary",
		"imageUrl":null,"coverImageUrl":null,"imageAlt":null,"imageCaption":null,
		"canonicalSlug":"story-en","localizedSlug":"story-en","localizedTitle":"Story en","localizedContent":"<p>Body</p>",
		"locale":"en","articleId":"000000000000000000000001","availableLocales":["en"],"publishedLocales":["en"],
		"requestedLanguage":"en","resolvedLanguage":"en","isFallback":false,
		"translationAvailability":{"requestedLang":"en","requestedLanguage":"en","resolvedLang":"en","resolvedLanguage":"en","isFallback":false,"isTranslated":false,"requestedLocalePublished":true,"translations":{"en":false,"hi":false,"gu":false},"availableLocales":["en"],"publishedLocales":["en"],"fallbackEnabled":true},
		"canonicalDetailUrl":"/news/story-en","detailApiUrl":"/api/public/news/story-en?lang=en&fallback=true",
		"id":"000000000000000000000001","excerpt":"Summary","readMinutes":1
	}],
	"lang":"en","total":1,"count":1,"page":1,"limit":12,"totalPages":1,"hasNextPage":false
}
```

### Empty Results and Unavailable Profiles

For a visible Contributor/Series with no public stories (HTTP 200):

```json
{"ok":true,"contributor":{"slug":"writer","name":"Writer","publicDesignation":null,"photoUrl":null,"shortBio":null,"contributionCount":0},"items":[],"lang":"gu","total":0,"count":0,"page":1,"limit":12,"totalPages":0,"hasNextPage":false}
```

```json
{"ok":true,"series":{"slug":"ideas","title":"Ideas","description":null,"ownerContributor":null,"articleCount":0},"items":[],"lang":"gu","total":0,"count":0,"page":1,"limit":12,"totalPages":0,"hasNextPage":false}
```

An unavailable owner is null, not a leaked private profile. Empty discovery has
`items: []` and the same zero pagination values, without lang/contributor/series.
Hidden, draft, invisible, or missing contributors and invisible/missing Series
return HTTP 404 on both detail and archive:

```json
{"ok":false,"message":"Not found"}
```

### Old-Slug Profile Response

GET `/api/public/pulse-dialogue/contributors/shared-writer` after an explicit
change to `shared-writer-journalist` (HTTP 200, no HTTP redirect):

```json
{
	"ok": true,
	"contributor": {
		"slug": "shared-writer-journalist",
		"name": "Shared Writer",
		"publicDesignation": null,
		"photoUrl": "https://example.test/new.jpg",
		"shortBio": null,
		"contributionCount": 1
	},
	"requestedSlug": "shared-writer",
	"canonicalSlug": "shared-writer-journalist",
	"redirectRequired": true
}
```

GET `/api/public/pulse-dialogue/contributors/shared-writer/articles?lang=gu`
returns the normal grouped archive envelope and adds the same three top-level
redirect fields. Its contributor.slug is canonical, totals refer to the same
contributor identity, and its items use the unchanged Gujarati/fallback resolver.