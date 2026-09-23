# News Pulse — Pulse Dialogue Phase 1 Implementation Contract

STATUS: FOUNDER REVIEW — NOT YET AUTHORIZED FOR CODING

This document defines the exact scope proposed for the first Pulse Dialogue
implementation.

It is derived from:

- PULSE_DIALOGUE_ARCHITECTURE.md
- PULSE_DIALOGUE_PHASE1_AUDIT_2026-09-23.md

Nothing in this contract is implemented merely because it appears here.

Coding may begin only after Founder approval.

News Pulse is publicly live.

All implementation must be:

- additive
- backward compatible
- locally tested
- isolated from production until approved
- compatible with existing publishing, scheduling, translation, media,
  permissions, SEO and public visibility architecture

---

## 1. Phase 1 Goal

Phase 1 must turn Pulse Dialogue from an ordinary category into a
signed-contributor publishing experience while preserving the existing
News Pulse article workflow.

Existing workflow must remain:

Add News
→ Save Draft
→ Draft Desk
→ Editorial Review
→ Preview
→ Publish / Schedule
→ Public Article

No separate Pulse Dialogue publishing pipeline.

---

## 2. Contributor Model — Exact Phase 1 Contract

Create one dedicated reusable Contributor identity.

Contributor must NOT be:

- User
- Staff account
- ReporterProfile
- ReporterContact
- YouthPulseContributor

Recommended Contributor fields:

Public identity:

- canonicalName
- displayNameHi — optional
- displayNameGu — optional
- photo — optional/recommended
- publicDesignation
- contributorType
- affiliation — optional
- shortBio — optional
- location — optional
- slug
- website — optional
- socialLinks — optional
- status

Internal only:

- internalEmail — optional
- internalNotes — optional
- rightsConsent

Status values:

- draft
- active
- inactive

Internal-only fields must NEVER appear in public Article payloads.

No contributor login.
No contributor self-publishing.

---

## 3. Contributor Types

Approved Phase 1 contributor types:

- columnist
- guest_columnist
- guest_contributor
- author
- scholar_academic
- researcher
- subject_expert
- journalist
- writer
- poet_literary_writer
- public_intellectual
- industry_expert

Public Designation remains free text.

Example:

Contributor Type:
scholar_academic

Public Designation:
Professor of Political Science

---

## 4. Dialogue Formats

Approved Phase 1 formats:

- column
- guest_column
- essay
- viewpoint
- conversation
- interview
- literary_essay
- culture_ideas
- expert_perspective
- open_letter

Contributor Type and Dialogue Format are separate concepts.

---

## 5. Article Metadata — Exact Shape

Pulse Dialogue article metadata should conceptually live under:

pulseDialogue

Recommended shape:

```js
pulseDialogue: {
  contributorId,
  dialogueFormat,
  series,
  bylineDesignationOverride,
  bylineSnapshot,
  contributorDisclosure,
  editorNote,
  contributorDisclaimer,
  showAboutContributor
}
```

All fields must be optional/backward compatible unless specifically required
for a Pulse Dialogue publish action.

Normal/non-Pulse articles must remain unaffected.

---

## 6. Byline Snapshot

At publication/sync time, preserve the public identity used for that article.

Recommended snapshot:

```js
bylineSnapshot: {
  name,
  designation,
  affiliation,
  photo
}
```

Reason:

Future edits to the master Contributor profile must not unexpectedly rewrite
historical article attribution.

Do NOT copy internal contributor data into the snapshot.

---

## 7. Translation Identity

One Contributor identity must be shared across:

EN
HI
GU

Do NOT create three contributor profiles for the same person.

Same contributorId must be preserved across translation siblings.

Contributor names must not be blindly machine-translated.

Optional manually controlled:

- displayNameHi
- displayNameGu

Localized public designation/bio may be supported later or where the agreed
data model safely allows it.

Existing article translationGroupId / translation architecture must remain.

---

## 8. Contributor Photo vs Article Cover

Canonical rule:

Article Cover Image
= story/topic

Contributor Photo
= writer/person

Contributor photo must not replace ArticleHeroImage by default.

Reuse existing Media Library/storage patterns.

Do not create a separate media system.

---

## 9. Article Cover Image — Phase 1

Reuse the existing article cover-image architecture.

Do NOT redesign the global cover-image system during Pulse Dialogue Phase 1.

Existing article cover support should remain compatible.

If cover caption/credit/rights controls are not currently available in Add News,
do not expand them globally unless required by implementation and separately
approved.

Contributor-photo consent belongs to contributor governance.

---

## 10. Backend Phase 1 Contract

Backend Phase 1 is authorized to propose implementation of:

NEW:

- Contributor model
- Admin-only Contributor list/search/create/update endpoints

EXTEND EXISTING:

- News with optional pulseDialogue metadata
- Article with optional public-safe pulseDialogue metadata
- admin article create/update whitelist
- News → Article synchronization
- translation sibling preservation
- public Pulse Dialogue API payload

Public API changes must be additive.

Existing article fields must not be replaced.

Internal contributor fields must never be synced to public Article.

Old articles without pulseDialogue must continue to work unchanged.

No DB migration should be required unless implementation proves otherwise.
If a migration appears necessary, STOP and report before proceeding.

---

## 11. Admin Panel Phase 1 Contract

When:

category === 'pulse-dialogue'

show:

PULSE DIALOGUE DETAILS

Recommended fields:

- Dialogue Format
- Contributor search/select
- Create Contributor
- Selected Contributor preview
- Series / Column — optional
- Byline Designation Override — optional
- Contributor Disclosure — optional
- Editor's Note — optional
- Contributor Disclaimer — optional
- Show About Contributor — optional

Recommended placement:

Existing Publishing Settings area,
after current Editorial / Youth Pulse conditional blocks
and before Location Tags.

Do not redesign Add News.

Do not change normal-category form behavior.

Use a dedicated small component such as:

PulseDialogueDetailsSection

to avoid making ArticleForm unnecessarily larger.

Contributor selection/create UI may use:

- ContributorSelector
- ContributorCreateEditModal or drawer

No separate Contributor dashboard in Phase 1.

---

## 12. Contributor Create/Edit UI

Phase 1 contributor create/edit may support:

- Photo via existing Media Library
- Contributor Name
- Public Designation
- Contributor Type
- Affiliation
- Short Bio
- Location
- Website
- Public Social Links
- Status
- Internal Contact Email
- Rights / Consent
- Internal Notes

Internal-only fields must never appear publicly.

---

## 13. Admin Form State Safety

Pulse Dialogue metadata must participate correctly in:

- create
- edit hydration
- dirty state
- autosave snapshot
- reset
- Preview
- Save Draft
- Publish
- Schedule

Normal article behavior must remain unchanged.

Backend support must exist first so Admin fields are not silently dropped by
the current backend whitelist.

---

## 14. Permissions

Reuse existing News Pulse access/module/special-right architecture.

Do NOT create a new permissions system.

Important audit finding:

AddNews / ArticleEdit currently pass userRole="admin" into ArticleForm.

Pulse Dialogue implementation must NOT turn this project into a broad
permissions refactor.

If safe contributor create/edit authorization cannot be implemented using the
existing effective access system without broader permission changes:

STOP and report the conflict.

---

## 15. Public Landing Page

Keep existing Pulse Dialogue category shell.

Do NOT replace:

- global header
- category header shell
- Explore Categories
- right rail
- ads
- Spotlight
- footer
- responsive behavior
- language routing

Approved description:

Ideas, essays, conversations and perspectives from writers, scholars,
experts and independent voices.

This text must be localized properly for EN / HI / GU.

Do not leave hard-coded English on HI/GU routes.

---

## 16. Landing Page Phase 1 Labels

Pulse Dialogue may use:

Featured Dialogue

Latest Contributions

Reuse CategoryFeedPage / CategoryStoryHierarchy architecture.

Do NOT create a completely separate landing-page system.

Do not build empty future sections merely to match the architecture vision.

---

## 17. Pulse Dialogue Article Cards

Where data exists, Pulse Dialogue cards may display:

- Dialogue Format
- Article Cover Image
- Headline
- Summary
- Contributor Photo
- Contributor Name
- Public Designation
- optional Series / Column
- publication date
- reading time where existing card architecture already supports it

Do not replace the generic card system unnecessarily.

Normal-category cards remain unchanged.

---

## 18. Public Article Page

For Pulse Dialogue articles only:

Use contributor identity instead of generic staff-author fallback.

Potential public display:

- Contributor Photo
- Contributor Name
- Public Designation
- Affiliation
- Dialogue Format
- Series

Optional article sections:

- Contributor Disclosure
- Editor's Note
- Contributor Disclaimer
- About Contributor

Normal news article rendering must remain unchanged.

---

## 19. About Contributor

Optional article-level setting:

showAboutContributor

When true:
display short contributor information.

When false:
render nothing.

Do not require a second contributor photo.

The same contributor identity/photo may be reused.

---

## 20. Contributor Disclaimer

Where enabled, approved meaning:

The views expressed in this contribution are those of the author and do not
necessarily represent the editorial position of News Pulse.

This distinguishes Pulse Dialogue contributor views from News Pulse Editorial.

---

## 21. SEO / JSON-LD

Reuse existing SEO infrastructure.

For Pulse Dialogue only:

author
= Contributor / Person

Publisher
= News Pulse

Potential Person data:

- name
- image
- public contributor URL if one exists later
- affiliation

Normal article SEO must remain unchanged.

Do not create a parallel SEO system.

---

## 22. Public API Safety

Public-safe Pulse Dialogue payload may contain:

- contributorId
- public contributor identity/snapshot
- dialogueFormat
- series
- disclosure
- editorNote
- disclaimer state/content
- showAboutContributor

Must NEVER expose:

- internalEmail
- internalNotes
- private consent records
- private administrative metadata

---

## 23. Backward Compatibility

Old articles must continue to work.

Missing Pulse Dialogue fields must safely resolve as:

null
empty
false

as appropriate.

Do not make Contributor fields globally required for ordinary articles.

Do not block:

- Regional
- National
- International
- Business
- Science & Technology
- Tech & Gadgets
- Sports
- Lifestyle
- Faith & Culture
- Glamour
- Editorial
- Youth Pulse
- other existing categories

---

## 24. Explicit Phase 1 Non-Goals

DO NOT build in Phase 1:

- Contributor login
- Contributor self-publishing
- Contributor portal
- Separate Pulse Dialogue dashboard
- Separate article database
- Separate article editor
- Separate Draft Desk
- Separate scheduler
- Separate translation system
- Separate Media Library
- New permissions architecture
- Public Contributor profile page
- Contributor archive
- Series archive
- Featured Voices
- Contributor discovery
- Phase 2/3 landing-page expansion

---

## 25. Implementation Order

Required sequence:

1. Backend
2. Backend tests
3. Admin Panel types/API
4. Admin Pulse Dialogue conditional UI
5. Admin Preview support
6. Admin tests/typecheck/build
7. Public Frontend types/resolvers
8. Pulse Dialogue landing copy/labels
9. Pulse article cards
10. Pulse article byline/optional sections
11. SEO conditional author mapping
12. Frontend tests/typecheck/build
13. Cross-repository local integration test
14. Founder visual/function review
15. Commit/push repository by repository
16. Production verification

Do NOT implement all repositories in one mixed coding task.

---

## 26. Required Backend Tests

Future implementation must cover at least:

- Contributor schema/defaults
- Contributor active/inactive behavior
- Admin CRUD authorization
- normal articles unchanged
- Pulse Draft save
- Pulse edit
- Pulse publish
- Pulse schedule
- News → Article metadata sync
- byline snapshot
- translation sibling contributorId preservation
- public payload excludes internal contributor fields
- public visibility unchanged
- old articles without pulseDialogue still work

---

## 27. Required Admin Tests

Future implementation must cover:

- Pulse section only appears for pulse-dialogue
- normal categories unchanged
- contributor select
- contributor create/edit
- Media Library photo selection
- edit hydration
- dirty-state preservation
- Save Draft
- Preview
- Publish
- Schedule
- missing optional values
- backend payload shape
- permissions behavior

---

## 28. Required Frontend Tests

Future implementation must cover:

- existing category shell unchanged
- EN/HI/GU Pulse route behavior
- localized approved description
- no staff-author fallback for Pulse articles
- contributor byline
- contributor photo separate from cover image
- optional disclosure
- optional Editor's Note
- optional disclaimer
- optional About Contributor
- normal article pages unchanged
- JSON-LD author = contributor for Pulse only
- Publisher remains News Pulse
- Spotlight/right rail unaffected

---

## 29. Live Site Safety

News Pulse is live.

Before every repository commit:

- git diff --check
- focused tests
- typecheck where applicable
- build where applicable
- git status
- review exact changed files

Do not commit or push until Founder approval for that repository stage.

Keep localhost/testing isolated from production.

---

## 30. Conflict Rule

If during implementation:

- current code differs materially from the audit
- architecture requires a wider change
- a migration becomes necessary
- permissions require global refactoring
- translation behavior conflicts
- public compatibility cannot be preserved

STOP.

Report the conflict.

Do not silently redesign working systems.

---

## 31. Final Phase 1 Identity

Contributor
= author / voice

News Pulse
= editorial reviewer and publisher

Article Cover Image
= story/topic

Contributor Photo
= writer/person

Pulse Dialogue
= signed-contributor publishing desk

News Pulse Editorial
= institutional editorial voice