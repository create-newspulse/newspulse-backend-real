# News Pulse — Pulse Dialogue Phase 1 Audit Baseline

Audit Date: 2026-09-23

STATUS: READ-ONLY PRE-IMPLEMENTATION SNAPSHOT

ARCHITECTURE SPEC
= permanent approved design and future direction

PHASE 1 AUDIT
= snapshot of the actual Backend, Admin Panel and Frontend codebases
before Phase 1 implementation

IMPORTANT:
This audit is a historical baseline.

Future coding agents must not assume every implementation detail in this
document is still current.

Before any future Pulse Dialogue development:

1. Read docs/PULSE_DIALOGUE_ARCHITECTURE.md
2. Read this audit baseline
3. Inspect the currently affected code
4. Compare current code with this baseline
5. Make only the smallest approved safe change

If current code differs from this audit, current verified code wins.
Report important architectural differences before modifying production code.

No Pulse Dialogue implementation had started when this baseline was created.

This document is not the architecture specification, not an implementation
contract, and does not authorize coding.

---

## 1. Backend Audit

### Current Article Architecture

At audit time, the backend article pipeline already used two related
collections/models:

- CMS/admin article records are stored as News documents.
- Public story copies are stored as Article documents.

Relevant backend files identified in the audit:

- docs/PULSE_DIALOGUE_ARCHITECTURE.md
- models/News.js
- models/Article.js
- routes/articles.routes.js
- routes/adminArticles.js
- routes/adminDrafts.js
- routes/admin/workflow.routes.js
- services/articlePublishing.service.js
- services/syncPublicArticleFromNews.service.js
- services/translationGroupSync.service.js
- services/mapArticleForLang.js
- services/publicArticleVisibility.service.js
- controllers/publicArticlesController.js
- controllers/publicNewsController.js
- routes/public.routes.js
- models/Media.js
- services/mediaLibraryService.js
- models/ReporterProfile.js
- models/ReporterContact.js
- models/YouthPulseContributor.js
- models/User.js
- server.js

Current relevant News fields included:

- title
- description
- content
- slug
- slugs
- tags
- category
- editorialType
- lang
- language
- originalLang
- translations
- translationStatus
- translationKey
- translationGroupId
- sourceArticleId
- sourceLanguage
- status
- scheduledAt
- publishAt
- publishedAt
- deletedAt
- imageURL
- coverImageUrl
- coverImage.url
- coverImage.publicId
- coverImage.alt
- externalUrls
- embeds
- gallery
- seo.metaTitle
- seo.metaDescription
- seo.canonicalUrl
- workflow fields
- sponsor fields
- geo/location fields
- Youth Pulse provenance fields

Current relevant public Article fields included public-copy equivalents for:

- title/body/category/language
- translations and translation status
- status and scheduling
- cover image and media arrays
- SEO
- sponsor fields
- geo/location fields
- sourceNewsId

### News vs Public Article Relationship

News is the CMS/admin source record. Article is the public synchronized copy.

The public sync path was handled by services/syncPublicArticleFromNews.service.js.
That sync copied title, body, category, translations, scheduling/status,
cover image, SEO, sponsor data, media arrays, tags, and geo fields from News
into Article.

Pulse Dialogue contributor metadata did not exist in either model at audit
time, so no contributor data was being synced from News to Article.

### Add News / Create / Edit / Publish / Schedule Flow

The existing backend flow already supported:

- Add News create through POST /api/articles
- Edit through PUT /api/articles/:id
- Publish through POST /api/articles/:id/publish
- Publish translation group through publish-group / publish-all-languages
- Schedule through POST /api/articles/:id/schedule
- Archive through POST /api/articles/:id/archive
- Soft delete through DELETE /api/articles/:id
- Draft listing through routes/adminDrafts.js
- Workflow movement through routes/admin/workflow.routes.js

Workflow movement deliberately did not directly publish or schedule. Publish
and schedule used dedicated routes.

Founder authorization was required for publish. Scheduling was available to
Editor/Founder-level roles and blocked for staff.

### News -> Article Synchronization

The public Article copy was synchronized by syncPublicArticleFromNews.

Current sync copied existing article data but did not copy any Pulse Dialogue
contributor, byline, dialogue format, series, disclosure, editor note,
disclaimer, or About Contributor data because those fields did not exist.

PROPOSED / PHASE 1 TARGET:
Future implementation would need to update the sync to preserve:

- stable contributorId
- published byline snapshot
- contributor photo snapshot or reference
- public designation used at publication time
- dialogue format
- series / column
- disclosure
- editor note
- disclaimer
- show-about-contributor control

### Translation Architecture

The backend already had EN/HI/GU translation infrastructure using:

- translationGroupId
- translationKey
- sourceArticleId
- sourceLanguage
- originalLang
- lang / language
- translations
- translationStatus

Publish required a complete EN/HI/GU-ready translation group before public
sync. Translation siblings were synchronized from a source/master article.

PROPOSED / PHASE 1 TARGET:
Pulse Dialogue contributor identity should be shared across all sibling News
documents in the translation group and copied to public Article copies.
Contributor names should not be blindly machine-translated as article body
text. Optional manually controlled Hindi/Gujarati display names would belong
on the Contributor profile.

### Public Visibility

Public visibility was controlled by services/publicArticleVisibility.service.js.

The public filters required published status and guarded against deleted,
locked, embargoed, future-published, future-scheduled, private, or hidden
records.

Pulse Dialogue did not require a separate public visibility system in the
audit findings.

### Existing Media / Cover Support

Reusable current image/media fields included:

- imageURL
- coverImageUrl
- coverImage.url
- coverImage.publicId
- coverImage.alt
- externalUrls
- embeds
- gallery
- Media.url
- Media.assetUrl
- Media.secureUrl
- Media.publicId
- media dimensions
- MIME type
- provider metadata

The backend had Media Library infrastructure through models/Media.js and
services/mediaLibraryService.js.

Genuinely missing at backend level for article cover governance:

- cover caption
- cover credit/source
- explicit image rights confirmation
- supplied-by-contributor flag

PROPOSED / PHASE 1 TARGET:
Contributor photo should reuse existing media storage patterns and remain
separate from article cover image metadata.

Canonical visual rule:

Article Cover Image = story/topic

Contributor Photo = writer/person

### Existing SEO Support

Current article SEO fields existed as:

- seo.metaTitle
- seo.metaDescription
- seo.canonicalUrl

Public SEO infrastructure already existed. No parallel SEO system was
recommended by the audit.

PROPOSED / PHASE 1 TARGET:
Pulse Dialogue could add contributor data into existing SEO/structured-data
pipelines additively so author can be a Person while publisher remains News
Pulse.

### Contributor-Like Models Inspected

The backend audit inspected existing models resembling public identity or
contributors:

- User
- ReporterProfile
- ReporterContact
- YouthPulseContributor

Audit conclusion:

- User represents staff/auth identity and must not become canonical public
  external contributor identity.
- ReporterProfile is tied to reporter/community identity, verification,
  coverage, and story stats.
- ReporterContact is tied to reporter directory/contact/portal and verified
  journalist workflows.
- YouthPulseContributor is specific to Youth Pulse submissions.

These models may provide adjacent patterns but should not be reused as the
canonical Pulse Dialogue contributor model.

### What Can Be Reused

Reusable backend systems:

- existing Add News create/edit flow
- existing category architecture
- existing Draft Desk
- existing workflow board and review stages
- existing publish route
- existing schedule route
- existing translation grouping
- existing public visibility filters
- existing public Article sync
- existing cover image and media infrastructure
- existing SEO metadata infrastructure

Pulse Dialogue already existed as an article category key in the public
Article category enum at audit time.

### What Was Missing

Backend Phase 1 gap classification:

| Item | Audit status |
| --- | --- |
| Stable Contributor ID | MISSING |
| Canonical name | MISSING |
| Optional Hindi/Gujarati display name | MISSING |
| Contributor photo | MISSING, but media infrastructure exists |
| Public designation | MISSING |
| Contributor type | MISSING |
| Affiliation | MISSING |
| Short bio | MISSING |
| Contributor status | MISSING |
| Internal email | MISSING for Pulse Dialogue |
| Rights/consent metadata | MISSING |
| Dialogue Format | MISSING |
| Series / Column | MISSING |
| Article-specific byline designation override | MISSING |
| Contributor disclosure | MISSING |
| Editor's Note | MISSING |
| Contributor disclaimer | MISSING |
| Show About Contributor | MISSING |
| Article cover metadata | PARTIALLY EXISTS: URL/publicId/alt only |
| Contributor/article relationship | MISSING |
| Byline snapshot | MISSING |
| EN/HI/GU contributor identity sharing | PARTIALLY EXISTS for article groups only, not contributors |

### Recommended Dedicated Contributor Model

PROPOSED / PHASE 1 TARGET:
A new Contributor model was justified by the audit.

Potential Contributor fields:

- canonicalName
- displayNameHi
- displayNameGu
- photo
- publicDesignation
- contributorType
- affiliation
- shortBio
- location
- slug
- website
- socialLinks
- status
- internalEmail
- internalNotes
- rightsConsent

This model was not implemented at audit time.

### Proposed Future pulseDialogue Metadata Location

PROPOSED / PHASE 1 TARGET:
Pulse Dialogue article metadata should live on News and sync to Article.

Potential shape:

- pulseDialogue.contributorId
- pulseDialogue.bylineSnapshot
- pulseDialogue.dialogueFormat
- pulseDialogue.series
- pulseDialogue.bylineDesignationOverride
- pulseDialogue.contributorDisclosure
- pulseDialogue.editorNote
- pulseDialogue.contributorDisclaimer
- pulseDialogue.showAboutContributor

This structure was not implemented at audit time.

### Byline Snapshot Requirement

PROPOSED / PHASE 1 TARGET:
Publication should preserve the contributor identity used at publish time so
future Contributor profile edits do not unexpectedly rewrite historical
article attribution.

Potential snapshot fields:

- publishedName
- publishedDesignation
- publishedAffiliation
- publishedPhoto
- contributorId

### Translation Identity Considerations

PROPOSED / PHASE 1 TARGET:
One Contributor identity should be shared across EN/HI/GU sibling articles.
Contributor selection should not create separate contributor profiles per
language. Localized contributor display fields should be manually controlled.

### Public API Impact

At audit time, public APIs exposed article fields such as title, summary,
description, content, slug, category, language, translations, translation
status, cover image, image URL, SEO, published dates, sponsor fields, and geo
fields.

They did not expose contributor/byline metadata.

PROPOSED / PHASE 1 TARGET:
Future public API additions should be additive and Pulse-specific, for
example a pulseDialogue or contributor object for category pulse-dialogue.
Existing imageUrl and coverImage fields should not be replaced.

### Backward Compatibility Risks

Backend risks identified:

- Required new fields on News or Article would break old articles.
- Future fields must default safely to null, empty object, or false.
- Public response contracts should remain additive.
- Existing publish requires EN/HI/GU readiness.
- Contributor metadata must not block non-Pulse categories.
- User must not be reused as public contributor identity.
- Historical bylines must not be rewritten unexpectedly after Contributor
  profile edits.

### Likely Future Backend Files Affected

Likely implementation files if Founder later approves backend work:

- models/News.js
- models/Article.js
- routes/articles.routes.js
- services/syncPublicArticleFromNews.service.js
- services/translationGroupSync.service.js
- services/articlePublishing.service.js
- controllers/publicArticlesController.js
- controllers/publicNewsController.js
- routes/public.routes.js
- routes/adminDrafts.js, only if draft cards need contributor labels
- routes/admin/workflow.routes.js, only if workflow cards need contributor labels
- server.js, only to mount new contributor routes if approved

### Likely New Backend Files Required

Likely new files if Founder later approves implementation:

- models/Contributor.js
- routes/adminContributors.routes.js or similar
- controllers/adminContributorsController.js or similar
- optional service: services/pulseDialogueContributor.service.js
- focused tests for contributor schema, article metadata sync, public API
  exposure, translation sibling preservation, and backward compatibility

### Suggested Backend Implementation Sequence

PROPOSED / PHASE 1 TARGET:

1. Add Contributor model with safe optional/default fields.
2. Add admin-only contributor CRUD/list/search endpoints.
3. Add optional pulseDialogue metadata object to News.
4. Add matching optional public-copy metadata object to Article.
5. Update Add News create/update backend to accept Pulse Dialogue metadata only
   when category = pulse-dialogue.
6. Update publish/sync logic to preserve byline snapshot and copy metadata to
   public Article.
7. Update translation group sync so sibling News docs inherit contributor
   identity.
8. Add public API additive contributor payloads for Pulse Dialogue only.
9. Add focused tests for existing categories to prove no behavior changed.
10. Add Pulse Dialogue-specific tests for draft, publish, schedule, sync,
    translations, public visibility, and empty/default cases.

No backend Pulse Dialogue implementation existed at audit time.

---

## 2. Admin Panel Audit

### Add News Route / Page / Form Architecture

The completed Admin Panel audit identified:

- App.tsx maps /add, /admin/add, and /admin/add-news.
- AddNews.tsx renders ArticleForm mode="create".
- ArticleEditPage.tsx renders the same ArticleForm mode="edit".
- ArticleForm.tsx is the main Add/Edit form.
- ArticleForm.tsx contains the category selector.
- Category options come from articleCategories.ts.
- Save Draft, Preview, and Publish are handled in ArticleForm.tsx.
- Schedule in Add News is handled as status = scheduled plus a datetime field
  in ArticleForm.tsx.
- Manage News also has ScheduleDialog.tsx.
- Cover image is handled by CoverImageUpload.tsx wired into ArticleForm.tsx.
- Media Library selection is handled by MediaLibrarySelector.tsx.
- Article API type/payload helpers are in articles.ts.

### Edit Mode

Edit mode reuses ArticleForm through ArticleEditPage.tsx with mode="edit".

PROPOSED / PHASE 1 TARGET:
Future Pulse Dialogue fields would need edit hydration, reset behavior,
snapshot/dirty-state inclusion, and round-trip persistence.

### Category Selector

ArticleForm.tsx owns category selection, using articleCategories.ts options.

At audit time, pulse-dialogue was already allowed as a category in the Admin
Panel flow and could save/publish as an ordinary article category.

### Existing Category-Conditional Patterns

Reusable category-conditional blocks already existed:

- category === 'editorial' shows Editorial Type.
- category === 'youth-pulse' shows Youth Pulse Track.

Current category = pulse-dialogue behavior:

- already allowed as a category
- passed publish category validation
- saved/published as an ordinary article category
- had no Pulse Dialogue-specific contributor/byline controls

### Cover Image / Media Library Behavior

Current article cover image supported:

- upload
- remove
- preview
- Choose from Media Library

Current payload sent:

- imageUrl
- coverImageUrl
- coverImage.url
- coverImage.publicId

Media Library assets already normalized:

- altText
- caption
- rights

Inline article images already supported:

- caption
- credit

Cover image alt had state/API plumbing through imageAltText, but no visible
Add News input was found for editing cover alt/caption/credit/rights.

Audit note:
Do not duplicate existing inline-image controls for cover image.

### Save Draft

Save Draft exists in ArticleForm.tsx.

PROPOSED / PHASE 1 TARGET:
Future Pulse Dialogue fields must participate in Snapshot and dirty state so
draft save/autosave behavior remains reliable.

### Preview

Preview exists in ArticleForm.tsx.

At audit time, preview had no contributor/byline metadata.

PROPOSED / PHASE 1 TARGET:
Future preview payloads and preview rendering would need Pulse Dialogue
contributor/byline metadata.

### Publish

Publish exists in ArticleForm.tsx.

Backend dependency identified:
Current backend article create/update routes whitelist fields. Unknown Pulse
Dialogue fields would currently be dropped. Backend contract support must
exist before Admin implementation can be considered complete.

### Schedule

Schedule inside Add News used status = scheduled plus datetime in
ArticleForm.tsx. Manage News also used ScheduleDialog.tsx.

PROPOSED / PHASE 1 TARGET:
Pulse Dialogue fields must not interfere with scheduling or non-Pulse drafts.

### Existing Permission Architecture

Add News route was protected by:

- AdminModuleRoute moduleKey="add_news"

Existing module/special rights included:

- add_news
- media
- editorial
- can_create_news
- can_edit_news
- can_publish_news
- can_schedule_news

Important audit finding:
AddNews.tsx and ArticleEditPage.tsx passed userRole="admin" into
ArticleForm. ArticleForm internal publish gating used that prop rather than
the effective special-right model.

Future Pulse Dialogue work must NOT automatically turn this into a global
permissions refactor.

PROPOSED / PHASE 1 TARGET:
Contributor create/edit permissions should reuse existing effective
auth/module/special-right access where safely possible. If this cannot be
done safely without a wider permissions change, implementation should stop
and report the conflict.

### Contributor-Like UI Patterns Inspected

Reusable adjacent UI patterns found:

- Searchable media picker in MediaLibrarySelector.tsx.
- Drawer/profile preview pattern in ReporterProfileDrawer.tsx.
- Compact searchable contributor directory pattern in
  YouthPulseContributorDirectory.tsx.
- Generic confirmation modal in ConfirmModal.tsx.

Audit caution:
YouthPulseContributorDirectory.tsx uses localStorage metadata and must not be
reused as canonical contributor persistence.

### Current pulse-dialogue Behavior

At audit time, pulse-dialogue was treated as a normal category. It had no
Pulse Dialogue-specific Admin UI.

### Missing Pulse Dialogue UI

Missing Admin Panel Phase 1 UI:

- Pulse Dialogue Details conditional section
- Contributor search/select
- Create/edit Contributor modal/drawer
- Contributor photo picker using Media Library
- Selected Contributor preview
- Dialogue Format
- Series / Column
- Byline Designation Override
- Contributor Disclosure
- Editor's Note
- Contributor Disclaimer
- Show About Contributor
- Contributor rights/consent fields

Potentially missing if Founder later approves:

- Add News-visible article cover caption
- article cover credit/source
- article cover rights controls

### Recommended Conditional Placement

PROPOSED / PHASE 1 TARGET:
Place PULSE DIALOGUE DETAILS inside ArticleForm.tsx in the existing
Publishing Settings area.

Recommended position:

- after existing Editorial / Youth Pulse conditional blocks
- before Location Tags

Gate strictly with:

- category === 'pulse-dialogue'

Normal categories must remain unchanged.

### Proposed PulseDialogueDetailsSection

PROPOSED / PHASE 1 TARGET:
A PulseDialogueDetailsSection component was likely justified, using the
existing category-conditional form pattern rather than a separate Add News
architecture.

### Contributor Selector / Create-Edit Approach

PROPOSED / PHASE 1 TARGET:
Likely justified components:

- ContributorSelector
- ContributorCreateEditModal or drawer
- pulseDialogueContributors API helper/types

Contributor photo selection should reuse the Media Library.

A separate contributor dashboard was not required for Phase 1.

### API / Type Impacts

PROPOSED / PHASE 1 TARGET:
Admin frontend would need to extend article API/types with Pulse Dialogue
metadata and contributor snapshot fields.

Pulse Dialogue form state would need inclusion in:

- Snapshot
- dirty hash
- edit hydration
- reset
- preview payload
- public/admin payload building

Contributor API helpers would be needed for:

- list/search
- create
- update

Backend contract support was identified as a dependency because unknown Pulse
Dialogue fields would currently be dropped.

### Edit Hydration / Dirty-State / Preview Risks

Risks identified:

- Save Draft / autosave: new fields must participate in Snapshot/dirty state.
- Edit mode: new fields must hydrate and round-trip correctly.
- Publish: backend currently drops unknown fields unless backend is extended
  first.
- Preview: current preview has no contributor/byline metadata.
- Schedule: Pulse Dialogue fields must not interfere with scheduling or
  non-Pulse drafts.
- Translations: one contributor identity must be shared across EN/HI/GU.
- Do not create separate contributor profiles per language.

### Backend Whitelist Dependency

The Admin audit explicitly found that the backend must support Pulse Dialogue
metadata fields before Admin Panel implementation can be complete, because
current admin article create/update routes whitelist fields and would drop
unknown Pulse fields.

### Likely Future Admin Files Affected

Likely Admin Panel files for future Phase 1 implementation:

- ArticleForm.tsx
- API articles types/helper file
- PreviewModal.tsx
- ArticlePreview.tsx
- new contributor API helper/types
- new Pulse Dialogue UI components

articleCategories.ts did not need changes unless labels/keys change, which
Phase 1 did not require at audit time.

### Suggested Admin Implementation Sequence

PROPOSED / PHASE 1 TARGET:

1. Backend contributor model/API and Pulse metadata contract first.
2. Admin contributor/Pulse types and API.
3. PulseDialogueDetailsSection in ArticleForm.
4. Contributor search/select.
5. Create/edit Contributor.
6. Reuse Media Library for contributor photo.
7. Add Preview support.
8. Add focused tests for normal categories unchanged, Pulse draft save, edit
   hydration, preview, publish, and schedule.
9. Run typecheck/build and focused tests.

No Admin implementation existed at audit time.

---

## 3. Public Frontend Audit

### /pulse-dialogue Route Architecture

At audit time, /pulse-dialogue used CategoryFeedPage with:

- title="Pulse Dialogue"
- categoryKey="pulse-dialogue"
- useCategoryShell

Next i18n served the same page under:

- /pulse-dialogue
- /hi/pulse-dialogue
- /gu/pulse-dialogue

Pulse Dialogue was not a special standalone page. It was a normal shared
category feed.

### EN / HI / GU Route Behavior

The page fetched public news using:

- category=pulse-dialogue
- current language
- strictLocale=1

Current HI/GU Pulse Dialogue routes still showed the current English Pulse
Dialogue desk description.

Current localization gap recorded by the audit:

- Pulse Dialogue category label is localized.
- Current desk description is hard-coded English.
- Approved future desk description needs EN/HI/GU localization.
- Explore Categories Pulse Dialogue subtitle is also hard-coded English.

### CategoryFeedPage

CategoryFeedPage defined the current Pulse Dialogue header:

- PULSE DIALOGUE DESK
- Pulse Dialogue
- Conversations, interviews and public dialogue from News Pulse.

CategoryDeskHeader rendered the desk header.

PROPOSED / PHASE 1 TARGET:
Approved future description:

Ideas, essays, conversations and perspectives from writers, scholars,
experts and independent voices.

This description needs proper EN/HI/GU localization rather than hard-coded
English.

### NewsPulseCategoryShell

CategoryFeedPage passed Pulse Dialogue into NewsPulseCategoryShell.
NewsPulseCategoryShell owned the shared category shell.

The shared shell included:

- global/category header
- top ad
- trending strip
- Explore Categories
- center feed
- right rail
- bottom billboard
- Spotlight

Audit conclusion:
Do not create a separate page architecture for Phase 1.

### CategoryStoryHierarchy

CategoryFeedPage mapped articles into CategoryStoryHierarchyItem.

CategoryStoryHierarchy rendered:

- top story
- key stories
- latest rows
- load more
- empty state

Current generic feed labels included:

- Top Story
- Key Stories
- Latest
- Load More Pulse Dialogue Stories

PROPOSED / PHASE 1 TARGET:
Possible Phase 1 labels:

- Featured Dialogue
- Latest Contributions

Card mapping could be extended only for Pulse Dialogue to include optional
contributor metadata.

### Explore Categories

ExploreCategories contained Pulse Dialogue and rendered category navigation.

The audit found the Pulse Dialogue category label was localized, while the
Explore Categories Pulse Dialogue subtitle was hard-coded English.

### Right Rail

NewsPulseCategoryShell used HomeRightRail.

HomeRightRail rendered:

- ad
- latest news
- tall ad
- viral videos
- youth desk

The right rail was a shared module and should not be redesigned for Phase 1.

### Ads

Landing/category-shell ads were inside NewsPulseCategoryShell.
Article-detail ads were in pages/news/[slug].tsx.

Ads should remain unchanged unless separately approved.

### Spotlight

NewsPulseCategoryShell rendered Spotlight.
Spotlight data came from the existing canonical spotlight feed.

Spotlight should remain shared and unchanged unless separately approved.

### Empty State

The current empty state used the shared no-stories state.

Audit conclusion:
Do not inject demo, sample, unrelated, or stale articles just to fill the
Pulse Dialogue page.

### Article Detail Page

pages/news/[slug].tsx was the public article renderer.
Legacy multi-part routes redirected through pages/news/[...parts].tsx.

The public article page currently handled:

- category
- headline
- summary
- article cover image
- generic author/byline
- publication date
- updated date
- article body
- image caption/credit
- SEO metadata
- structured data
- related content

Reading time was not currently rendered on the normal article detail page,
though a helper for reading time existed elsewhere.

### Cover Image Behavior

coverImages.ts resolved supported article cover fields.
StoryImage / ArticleHeroImage rendered the article hero.

Existing cover-image implementation already satisfied:

Article Cover Image = article/topic

Contributor Photo = writer/person

PROPOSED / PHASE 1 TARGET:
Contributor photo must be separate contributor metadata and must not be fed
into ArticleHeroImage by default.

### Current Generic Author / Byline Behavior

The current article page used generic author resolver logic.

Important risk:
Generic author fallback could use createdByName/userName/staff-like fields.
Pulse Dialogue must not accidentally display the staff member who entered a
contributed article as its public author.

PROPOSED / PHASE 1 TARGET:
For Pulse Dialogue only, visible generic byline should be replaced with
Contributor identity from backend-provided Pulse metadata.

### Current SEO / NewsArticle JSON-LD

seo.ts built Article SEO and NewsArticle JSON-LD.
pages/news/[slug].tsx injected metadata and JSON-LD.

Current NewsArticle JSON-LD already supported author = Person.
Publisher remained News Pulse.

PROPOSED / PHASE 1 TARGET:
For Pulse Dialogue only, future contributor metadata could supply:

- author.name
- author.image
- author.url
- author.affiliation

Do not create a parallel SEO system. Normal news SEO must remain unchanged.

### What Must Remain Unchanged

Must remain unchanged unless separately approved:

- NewsPulseCategoryShell
- global/category top header behavior
- Explore Categories
- right rail
- ads
- Spotlight
- article cover-image system
- article body renderer
- inline images
- gallery
- embeds
- article route structure
- locale routing
- translation polling/canonicalization
- SEO infrastructure
- existing publish/listing workflow surface

### Missing Pulse Dialogue Rendering

Landing page missing:

- approved description
- localized desk description
- Featured Dialogue label/section
- Latest Contributions label/section
- Dialogue Format on cards
- Contributor Photo
- Contributor Name
- Public Designation
- Series / Column

Article page missing:

- Pulse Dialogue conditional rendering
- Contributor Photo
- Contributor Name separate from staff author fallback
- Public Designation
- Affiliation
- Dialogue Format
- Series
- Disclosure
- Editor's Note
- Contributor Disclaimer
- optional About Contributor

Frontend types currently had no canonical Pulse Dialogue contributor shape.

### Landing-Page Phase 1 Target

PROPOSED / PHASE 1 TARGET:
Keep the existing shared category page.

Gate Pulse-specific behavior by:

- routeCategoryKey === 'pulse-dialogue'

Use the approved localized description:

Ideas, essays, conversations and perspectives from writers, scholars,
experts and independent voices.

Possible Phase 1 labels:

- Featured Dialogue
- Latest Contributions

Do not create a separate page architecture.

### Article Byline Target

PROPOSED / PHASE 1 TARGET:
Use conditional Pulse Dialogue rendering inside pages/news/[slug].tsx.

Determine Pulse status from normalized category key.

Add a small Pulse Dialogue metadata resolver/helper.

For Pulse Dialogue only:

- replace the visible generic byline with contributor identity
- optionally render disclosure, Editor's Note, contributor disclaimer, and
  About Contributor

Normal articles must retain existing author rendering unchanged.

### Contributor-Photo Separation From Cover Image

PROPOSED / PHASE 1 TARGET:
Contributor photo is writer/person metadata. Article cover image remains
story/topic metadata. Contributor photo must not replace the article cover
image by default.

### EN / HI / GU Considerations

Current locales:

- en
- hi
- gu

Shared contributor identity across languages should include:

- contributor ID
- canonical identity
- photo
- profile slug/URL
- social links

Potentially localized fields:

- manually controlled display name
- public designation
- bio
- Dialogue Format labels
- series display text

Do not blindly machine-translate contributor names. Continue using existing
article translation groups.

### SEO Person / Publisher Considerations

PROPOSED / PHASE 1 TARGET:
For Pulse Dialogue only, contributor metadata can supply NewsArticle author
Person details while publisher remains News Pulse.

Normal news SEO must remain unchanged.

### Regression Risks

Frontend risks identified:

- Changing NewsPulseCategoryShell could affect many categories.
- Changing CategoryStoryHierarchy could affect multiple public feeds.
- Generic article author fallback could expose staff identity.
- Hard-coded English could leak into HI/GU pages.
- Adding reading time globally could alter normal news articles.
- SEO author changes must be Pulse-only.
- Contributor photo must not replace article cover image.
- Strict-locale rules must remain unchanged.
- Spotlight and right rail are shared modules and must not be redesigned.

### Likely Future Frontend Files Affected

Likely Frontend Phase 1 files:

- CategoryFeedPage.tsx
- CategoryStoryHierarchy.tsx
- pages/news/[slug].tsx
- editorialDisplay.ts or a small Pulse Dialogue metadata helper
- seo.ts
- publicNewsApi.ts
- EN/HI/GU localization files
- focused tests

### Suggested Frontend Implementation Sequence

PROPOSED / PHASE 1 TARGET:

1. Confirm Backend Phase 1 public payload.
2. Add frontend optional types/resolvers first.
3. Add tests preventing staff-author fallback for Pulse Dialogue.
4. Localize approved Pulse Dialogue description.
5. Add Featured Dialogue / Latest Contributions labels.
6. Extend existing cards minimally.
7. Add Pulse-only contributor byline on article detail.
8. Add optional disclosure / Editor's Note / disclaimer / About Contributor.
9. Extend JSON-LD author conditionally.
10. Run focused category, article, i18n, SEO and cover-image regression tests.

No Frontend implementation existed at audit time.

---

## 4. Cross-Repository Findings

The completed Backend, Admin Panel, and Public Frontend audits established
these baseline conclusions:

1. Pulse Dialogue already exists as an article category.

2. Existing News Pulse publishing workflow should be reused:

   Add News
   -> Draft
   -> Draft Desk
   -> Review
   -> Preview
   -> Publish / Schedule

3. A dedicated reusable Contributor identity is justified.

4. Do not use User, ReporterProfile, ReporterContact or
   YouthPulseContributor as the canonical Pulse Dialogue contributor model.

5. Contributor identity must remain separate from News Pulse staff identity.

6. Article Cover Image and Contributor Photo are different:

   Article Cover Image = story/topic

   Contributor Photo = writer/person

7. One Contributor identity must be shared across EN/HI/GU versions.

8. Internal contributor information must never be exposed publicly.

9. Public APIs should be extended additively rather than replacing existing
   article fields.

10. Existing category shell, ads, right rail, Spotlight, article body
    renderer, publishing workflow and translation architecture should be
    reused wherever possible.

11. Normal/non-Pulse categories must remain unaffected.

12. No database migration should be assumed necessary unless future
    implementation proves otherwise.

---

## 5. Not Implemented At Audit Time

The following were NOT implemented when this audit baseline was created:

- Contributor model
- Contributor CRUD/search API
- Pulse Dialogue-specific Add News section
- Contributor selector
- Create/Edit Contributor UI
- Contributor public byline system
- Dialogue Format
- Series / Column metadata
- Byline designation override
- Contributor disclosure
- Editor's Note
- Contributor disclaimer
- Optional About Contributor
- Contributor public profiles
- Contributor archives
- Series archives
- Featured Voices
- Contributor self-publishing

This list prevents future agents from confusing the architecture plan with
existing code.

---

## 6. Future Audit Rule

This baseline does NOT need to be recreated for every small change.

For future work:

- Small frontend change:
  inspect affected frontend code only.

- Admin field/UI change:
  inspect Admin + API contract.

- Backend/data-contract change:
  inspect Backend + affected consumers.

- New Phase 2 feature:
  run a fresh targeted multi-repository audit.

- Major Pulse Dialogue architecture upgrade:
  run a new full three-repository audit.

Never rely blindly on this dated snapshot when the repository has changed.