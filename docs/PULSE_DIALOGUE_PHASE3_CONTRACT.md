# Pulse Dialogue Phase 3 Backend Contract

## Scope and release boundary

This is an additive backend foundation, not a deployment instruction. No production
indexes, packages, or migrations are required or executed by this change. Review
query plans on isolated staging data before release. Phase 1 publishing, snapshots,
standard disclosure/disclaimer text, Editor's Note, authorByline, existing Phase 2
URLs, directory fields, Ads Manager and homepage Spotlight remain separate.

## Public articles

`GET /api/public/pulse-dialogue/articles`

| Parameter | Contract |
| --- | --- |
| `lang` | Exact `en`, `hi`, or `gu`; default `gu` |
| `page` | Decimal positive integer, default 1, maximum 1000 |
| `limit` | Decimal positive integer, default 12, maximum 24 |
| `q` | String, maximum 80 input characters, trimmed; empty means no search |
| `contributor` | Exact current canonical public Contributor slug, maximum 140 characters |
| `seriesSlug` | Exact canonical visible Series slug, maximum 140 characters |
| `dialogueFormat` | One or comma-separated distinct existing format values |
| `sort` | `newest` (default) or `oldest` |

Unknown parameters, arrays/objects where strings are expected, invalid slugs,
out-of-range integers, unsupported formats/locales, and unavailable contributor or
Series filters return 400. Old contributor slugs remain supported on Phase 2 URLs,
but this new filter expects the current canonical slug.

Contributor filtering resolves the ID once and permits visible active or inactive
profiles, matching Phase 2 archive eligibility. Series filtering requires
`profileVisible:true`. Published article visibility itself is independent of the
contributor's profile availability, preserving Phase 1 historical contributions.

Filters of different types are ANDed. Format values are ORed. Search is escaped,
case-insensitive literal substring matching of stored `title`, `summary`, and
`description` only. It does not search article bodies, cached translation buckets,
contributor biographies, or Series descriptions. A localized returned title need
not contain the original query. This does not change global search.

Only public published Pulse Dialogue News records qualify. Existing deletion,
privacy, scheduling, embargo and lock gates apply to both matching and hydration.
Requested locale editions and ready cached translations are preferred, with base
fallback inside the same eligible story and category. EN/HI/GU share canonical
story identities and do not become duplicate list items.

Each story selects its locale representative, then sorts by that representative's
`publishedAt`, `createdAt`, and `_id`, all descending for newest or ascending for
oldest. Story identity uses translationKey, translationGroupId, canonical slug,
then document ID, in the same precedence as existing archives.

Response shape:

```json
{
  "ok": true,
  "items": [],
  "lang": "gu",
  "total": 0,
  "count": 0,
  "page": 1,
  "limit": 12,
  "totalPages": 0,
  "hasNextPage": false
}
```

`total` counts unique matching stories, not editions; `count` is returned cards.
Out-of-range-but-valid pages return an empty page with the matching total.
Cards use the existing public serializer with this compact allowlist (optional
source fields are omitted): `id`, `_id`, `articleId`, `title`, `summary`,
`description`, `slug`, `slugs`, `canonicalSlug`, `category`, `imageUrl`,
`coverImageUrl`, `imageAlt`, `publishedAt`, `createdAt`, `language`, `lang`,
`requestedLang`, `resolvedLang`, `isTranslated`, `isFallback`, `translationKey`,
`translationGroupId`, `canonicalDetailUrl`, `detailApiUrl`, `pulseDialogue`, and
`authorByline`. No `content` or translation-body buckets are returned.

Existing Pulse metadata and byline snapshots are reused without rewriting stored
values. `series` remains display text; an assigned `seriesSlug` remains canonical.
No slug is inferred or assigned to legacy/unassigned stories. The PublicArticle
fallback of `/api/public/news/:slugOrId` now retains this existing metadata too.

## Public discovery

`GET /api/public/pulse-dialogue/discovery?lang=gu`

Only `lang` is accepted, with the same exact values/default as articles.

```json
{
  "ok": true,
  "lang": "gu",
  "featuredDialogue": [],
  "featuredVoices": [],
  "formatGroups": {
    "columns": [],
    "essays": [],
    "culture": [],
    "conversations": []
  }
}
```

- Featured Dialogue: maximum six compact cards in configured order.
- Featured Voices: maximum six current public contributor summaries in configured
  order: `{slug,name,publicDesignation,photoUrl,shortBio}`.
- Each format preview: maximum four compact unique-story cards, newest first.
- Columns: `column,guest_column`; Essays: `essay,literary_essay`;
  Culture: `culture_ideas`; Conversations: `conversation,interview`.
- `viewpoint,expert_perspective,open_letter` remain valid and discoverable through
  the unfiltered article endpoint, but have no dedicated preview group.
- Unpublished, deleted, missing or non-Pulse configured articles are omitted.
  Voices must be active and profileVisible; inactive, hidden, draft or invisible
  voices are omitted. Configured references are retained, not automatically deleted.
- There is no automatic or popularity-based replacement for a missing selection.
  Homepage Spotlight fields and selection do not participate.

One grouped aggregation selects all previews/featured identities, one bounded
hydration resolves the union (at most 22 story identities), and contributor data is
batch-loaded. There is no database or HTTP request per section/contributor.

All new public responses use `Cache-Control:no-store`. There are no new filtered
response caches or cache keys and no broad invalidation. Curation/visibility
changes are evaluated afresh on the next request. Empty data is a successful empty
payload; database/deadline errors return 503 with
`{"ok":false,"message":"Unable to load Pulse Dialogue"}`.

## Existing Phase 2 reuse

Contributor/Series directories and their fields are unchanged. Continue using:

- `GET /api/public/pulse-dialogue/contributors`
- `GET /api/public/pulse-dialogue/series`
- `GET /api/public/pulse-dialogue/contributors/:slug`
- `GET /api/public/pulse-dialogue/contributors/:slug/articles`
- `GET /api/public/pulse-dialogue/series/:slug`
- `GET /api/public/pulse-dialogue/series/:slug/articles`

Archive internals now count/group in MongoDB and hydrate only the requested page.
Their existing response envelopes, body-bearing cards, language aliases, fallback,
default limit 12, maximum limit 50, page ceiling 10000, and contributor old-slug
metadata remain intact. Profile counts no longer load every grouping key into Node.
For related items request a small page and omit the current canonical story group
client-side. No related endpoint or server-side exclusion parameter was added.

## Admin curation

Base: `/api/admin/pulse-dialogue/curation`.

Authentication uses the existing strict JWT/session middleware, not a new token
scheme. Founder is permitted. Editors also require the existing global Manage News
policy to permit staff, individual Manage News access, and the `news_publish`
special right. Account lifecycle, token version, and Safe Zone gates remain active.
Other roles are not admitted by these routes.

| Method/path | Body |
| --- | --- |
| `GET /` | none |
| `PUT /featured-dialogue` | `{"articleIds":["<News ObjectId>"]}` |
| `PUT /featured-voices` | `{"contributorIds":["<Contributor ObjectId>"]}` |

Each PUT replaces only its own ordered list. Empty arrays clear that list. Every
ID must be valid and publicly eligible at write time. More than six, duplicate
IDs, duplicate article story identities across editions, invalid/ineligible
targets and unexpected body keys return 400. Use News IDs for articles, not public
Article mirror IDs. Reads preserve missing configured entries with nullable labels
so Admin can remove them explicitly.

All successful operations return:

```json
{
  "ok": true,
  "configuration": {
    "featuredDialogue": [],
    "featuredVoices": [],
    "updatedAt": null
  }
}
```

Selected article entries: `{id,title,slug,status,missing}`. Selected existing voice
entries: `{id,slug,name,publicDesignation,photoUrl,shortBio,status,profileVisible,missing}`.
Missing voices return `{id,slug:null,name:null,status:null,profileVisible:false,missing:true}`.
No private contributor fields are returned. Authentication/policy errors retain
the shared middleware contracts (401/403); operational curation failures are 503.

Storage is a single `PulseDialogueCuration` document with fixed string ID
`pulse-dialogue`, ordered ObjectId arrays and timestamps. It declares no indexes,
and both `autoIndex` and `autoCreate` are false. No startup writes are performed.
Explicit admin writes may create the configuration/collection when permitted by
the deployment's database permissions.

## Discovery analytics

`POST /api/analytics/discovery`

```json
{
  "event": "series_click",
  "seriesSlug": "ideas",
  "lang": "en",
  "visitorId": "anonymous-visitor-id",
  "sessionId": "anonymous-session-id"
}
```

| Event | Required target |
| --- | --- |
| `contributor_profile_click` | `contributorSlug`: visible active/inactive canonical contributor |
| `featured_voice_click` | `contributorSlug`: active and visible canonical contributor |
| `series_click` | `seriesSlug`: visible canonical Series |
| `featured_dialogue_click` | `articleId`: public published Pulse News ObjectId |

Only the event, its one target field, `lang`, `visitorId`, and `sessionId` are
accepted. IDs use `[A-Za-z0-9_-]{1,128}`; slugs are canonical and at most 140
characters; article IDs are 24 hex characters. `lang` defaults to `gu` and accepts
only `en|hi|gu`. Unknown events, invalid input, and unavailable targets return 400.
Featured click validation checks public eligibility, not historical membership in
a particular curation revision.

Events extend the existing ArticleAnalyticsEvent architecture with `targetType`
and `targetId`; article discovery events also retain `articleId`. Existing
readership events still require articleId and keep their existing counters.
Visitor/session IDs and IP/user-agent metadata are hashed with the existing helper.
No raw IP, new provider, or analytics dependency is introduced.

Existing disabled/bot/admin-origin/localhost exclusions apply. Frontend must keep
using its consent gate and send telemetry independently of rendering/navigation.
The endpoint does not obtain user consent on the frontend's behalf.

There is a bounded per-process 60 requests/IP/minute guard (at most 5000 buckets),
plus existing Mongo dedup storage/unique index for one event/target/visitor/session
per 60 seconds. Dedup records reuse the existing two-day expiry/TTL convention.
Raw events follow the existing analytics retention behavior; no TTL was added.

Success: `{"ok":true,"skipped":false}`. A cooldown or operational failure returns
200 with `{"ok":true,"skipped":true,"reason":"cooldown"}` or reason `unavailable`.
Other skip reasons include privacy/exclusion reasons, `rate-limited`, and
`db-not-ready`. Operational failures are deliberately not navigation errors.

Public and admin routes retain the existing `/admin-api/public/...`,
`/admin-api/api/public/...`, `/admin-api/admin/...`, `/admin-api/api/admin/...`,
and analytics proxy-prefix aliases through the existing mounts.

## Query bounds and candidate indexes

All new article aggregations have `maxTimeMS:2500` and `allowDiskUse:false`.
Target/configuration/contributor lookups have matching query deadlines. Group
counts are exact for the metadata aggregation; only page identities and selected
editions are transferred to Node. Normal concurrent publish/unpublish changes
between selection and hydration can shorten a returned page; hydration rechecks
visibility rather than exposing a now-hidden article. Reads are not transactional.

MongoDB still examines matching metadata and evaluates short-field substring
searches. A deadline is a failure bound, not a promise of constant query cost.
No public-read rate limiter existed to reuse; only analytics has the new local
guard. A distributed limiter and query-plan review remain release considerations.

No schema index declarations were added. These are candidates for an explicit
release-readiness review, not automatic creation instructions:

```javascript
// News, select only the combinations justified by staging explain results:
{ category: 1, status: 1, publishedAt: -1, createdAt: -1, _id: -1 }
{ category: 1, status: 1, 'pulseDialogue.contributorId': 1, publishedAt: -1, createdAt: -1, _id: -1 }
{ category: 1, status: 1, 'pulseDialogue.seriesSlug': 1, publishedAt: -1, createdAt: -1, _id: -1 }
{ category: 1, status: 1, 'pulseDialogue.dialogueFormat': 1, publishedAt: -1, createdAt: -1, _id: -1 }
// Existing directories:
{ status: 1, profileVisible: 1, canonicalName: 1, _id: 1 } // Contributor
{ profileVisible: 1, title: 1, _id: 1 } // PulseDialogueSeries
// Only if discovery analytics reporting needs target/time lookups:
{ eventType: 1, targetType: 1, targetId: 1, createdAt: -1 } // ArticleAnalyticsEvent
```

Computed locale ranking/grouping can still require blocking sort/group work; the
above indexes are primarily candidate-filter improvements, not full coverage of
the aggregation. Match query/index collations. Ordinary B-tree/text indexes do
not make the current arbitrary substring semantics index-covered. No search-engine
or taxonomy change is bundled into this phase.

## Verification

Run `node scripts/test-pulse-dialogue.js` for the relevant regression slice, or pass
specific supported test filenames. It isolates each file, disables dotenv loading,
blocks Mongo connections and outbound non-loopback sockets, and leaves production
services untouched. Also run `npm run build`, syntax checks for changed JS files,
`git diff --check`, `git diff --stat`, and `git status --untracked-files=all`.

The aggregation fixture evaluates emitted pipeline stages over test records. It
does not replace MongoDB integration/explain testing on isolated staging data.
No local MongoDB binary was available for this implementation's verification.
The existing admin Spotlight-update test has an unmocked News.findOne timeout;
the same failure was reproduced with pre-change tracked source loaded in memory.
It was not repaired as part of this feature.