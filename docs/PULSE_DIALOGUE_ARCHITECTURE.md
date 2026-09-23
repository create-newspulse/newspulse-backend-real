# News Pulse — Pulse Dialogue Architecture

STATUS: CANONICAL PRODUCT / EDITORIAL SPECIFICATION

IMPORTANT:
Read this file before making any change related to Pulse Dialogue.

This document defines the approved future product architecture, editorial
model, contributor model, article metadata, public rendering rules,
multilingual behavior, publishing workflow, and upgrade direction for
Pulse Dialogue.

This document is a specification, NOT proof that the described features
have already been implemented.

Before implementing a future Pulse Dialogue task, inspect the current
codebase and compare the implementation against this specification.

If existing implementation and this specification conflict, STOP and
report the difference before modifying production code.

News Pulse is publicly live.
Existing working logic must be preserved unless a future approved task
explicitly requires a change.

---

## 1. Identity

Pulse Dialogue is a signed-contributor publishing desk for:

- Columns
- Essays
- Political and social viewpoints
- Interviews and conversations
- Literature and cultural writing
- Academic perspectives
- Expert commentary
- Public-interest ideas
- Guest contributions
- Recurring columnist contributions

Pulse Dialogue is NOT News Pulse Editorial.

News Pulse Editorial represents:

- Editorial
- Special Story
- Institutional/editorial position of News Pulse

Pulse Dialogue represents identifiable contributor voices.

---

## 2. Public Positioning

Approved description:

"Ideas, essays, conversations and perspectives from writers, scholars,
experts and independent voices."

---

## 3. Existing Core Workflow — MUST BE PRESERVED

Pulse Dialogue must reuse the existing News Pulse workflow:

Contributor provides article
→ Add News
→ Category = Pulse Dialogue
→ Save Draft
→ Draft Desk
→ Editorial Review
→ Preview
→ Publish / Schedule
→ Public Pulse Dialogue article

Future Pulse Dialogue features must extend this workflow rather than replace it.

DO NOT create a separate:

- Pulse Dialogue article editor
- Draft Desk
- scheduler
- article database
- translation engine
- Media Library
- contributor self-publishing system
- permission architecture

unless separately approved by Founder in the future.

---

## 4. Contributor Model — PHASE 1 TARGET

A contributor is a reusable public author identity.

Contributor profile should support:

- Stable Contributor ID
- Canonical Name
- Optional Gujarati Display Name
- Optional Hindi Display Name
- Contributor Photo
- Public Designation
- Contributor Type
- Affiliation / Organisation
- Short Bio
- Location
- Profile Slug
- Website
- Public Social Links
- Status
- Internal Contact Email
- Internal Notes
- Rights / Consent records

A Contributor Profile is NOT automatically a News Pulse staff account.

One contributor identity should be reusable across multiple articles.

---

## 5. Contributor Types

Recommended controlled values:

- Columnist
- Guest Columnist
- Guest Contributor
- Author
- Scholar / Academic
- Researcher
- Subject Expert
- Journalist
- Writer
- Poet / Literary Writer
- Public Intellectual
- Industry Expert

Contributor Type describes who the person is.

Public Designation remains flexible.

Example:

Contributor Type:
Scholar / Academic

Public Designation:
Professor of Political Science

The public page normally uses the Public Designation rather than displaying
all internal contributor classifications.

---

## 6. Dialogue Formats

Dialogue Format describes the type of contribution.

Recommended:

- Column
- Guest Column
- Essay
- Viewpoint
- Conversation
- Interview
- Literary Essay
- Culture & Ideas
- Expert Perspective
- Open Letter

Contributor Type and Dialogue Format must remain separate concepts.

---

## 7. Add News Integration — PHASE 1 TARGET

The normal Add News form must remain unchanged for other categories.

Only when:

Category = Pulse Dialogue

may Pulse Dialogue-specific controls appear.

Planned Pulse Dialogue Details may include:

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

Existing actions must continue to be reused:

- Save Draft
- Preview
- Publish
- Schedule

Do not create Pulse Dialogue-specific replacements for these actions.

---

## 8. Contributor Creation — PHASE 1 TARGET

Planned Contributor Profile creation may support:

- Contributor Photo
- Contributor Name
- Public Designation
- Contributor Type
- Affiliation / Organisation
- Short Bio
- Location
- Website
- Public Social Links
- Status
- Internal Contact Email
- Rights / Consent
- Internal Notes

After a contributor is created, future Add News integration may allow that
profile to be selected for Pulse Dialogue articles.

---

## 9. Contributor Photo

Contributor Photo represents the WRITER.

Recommended:

- reusable profile image
- preferably square portrait
- reuse existing News Pulse Media Library where practical

One contributor photo should be reused rather than uploaded separately for
every article.

Possible future uses:

- article byline
- contributor profile
- Featured Voices
- contributor archive
- optional contributor information area

---

## 10. Article Cover Image

Article Cover Image represents the ARTICLE / STORY SUBJECT.

This is separate from Contributor Photo.

Canonical rule:

ARTICLE COVER IMAGE
= story/topic

CONTRIBUTOR PHOTO
= writer/person

Reuse the existing News Pulse article featured/cover-image architecture
where possible.

Relevant article-image metadata may include:

- Cover / Featured Image
- Alt Text
- Caption
- Image Credit / Source
- Rights confirmation

Do not create a duplicate Media Library just for Pulse Dialogue.

---

## 11. Contributor Photo as Article Cover

Contributor portrait should NOT normally be used as the article cover.

It may be appropriate for:

- Interview
- Q&A
- Profile conversation
- Writer spotlight
- Columnist introduction
- Article specifically about the contributor

For essays, viewpoints, columns and cultural writing, prefer a topic-related
article image.

---

## 12. Image Rights

For externally supplied article images, future implementation may record:

- Image supplied by contributor
- Permission to publish confirmed
- Image credit
- Image source

Examples:

Courtesy: Contributor

Photo: News Pulse / Staff

Use existing News Pulse media governance where available.

---

## 13. Public Byline

Recommended public presentation:

[Contributor Photo]

By Dr. Anil Mehta
Professor of Political Science
Gujarat University

Avoid overloaded public labels.

Contributor Type does not need to be publicly displayed when Public
Designation already appropriately identifies the contributor.

---

## 14. Byline Snapshot

Contributor articles should remain linked to a stable Contributor ID.

Where practical, publication should preserve the byline identity used at
the time of publication.

Example:

Contributor ID:
abc123

Published Name:
Dr. Anil Mehta

Published Designation:
Professor of Political Science

Future contributor-profile edits should not unexpectedly rewrite historical
article attribution.

---

## 15. Byline Designation Override

An article may optionally use an article-specific designation.

If override is empty:
use Contributor Profile designation.

If override is present:
use article-specific designation for that article.

---

## 16. Series / Regular Column

Pulse Dialogue may support optional Series / Column metadata.

Examples:

- The Gujarat Lens
- India in Conversation
- Ideas & Society
- Books & Beyond
- Culture Notes
- Technology & Society
- Campus Voices

For Phase 1 this may remain simple article metadata.

Dedicated public series archives belong to a later phase.

---

## 17. Contributor Disclosure

Optional.

Used where relevant for relationships, roles or interests that readers
should know.

Display publicly only when populated.

Contributor Disclosure is separate from Editor's Note.

---

## 18. Editor's Note

Optional News Pulse editorial context.

Examples:

- Edited for clarity and length.
- Part of a News Pulse special series.

Keep Editor's Note separate from Contributor Disclosure.

---

## 19. Contributor Disclaimer

Where appropriate, Pulse Dialogue may display:

"The views expressed in this contribution are those of the author and do
not necessarily represent the editorial position of News Pulse."

This distinguishes contributor viewpoints from News Pulse Editorial.

---

## 20. About the Contributor

OPTIONAL.

Planned article-level control:

Show About the Contributor
On / Off

When enabled, a short contributor biography may appear after the article.

Example:

ABOUT THE CONTRIBUTOR

Dr. Anil Mehta is a scholar and researcher specialising in public policy,
democracy and urban governance.

View all contributions →

No separate additional contributor photo is required.

When disabled:
nothing should be displayed.

---

## 21. Contributor Status

Recommended future statuses:

- Draft
- Active
- Inactive

Active:
may be selected for new contributions.

Inactive:
historical articles remain intact but the contributor is not normally
selected for new work.

Do not delete contributor history merely because someone stops contributing.

---

## 22. Rights & Consent

Internal-only contributor records may eventually include:

- Contribution publication rights confirmed
- Contributor profile consent confirmed
- Contributor photo usage permission confirmed
- Conflict / disclosure reviewed
- Internal notes

These should not clutter public pages.

---

## 23. Public Article Structure — TARGET

Recommended Pulse Dialogue presentation:

PULSE DIALOGUE • [FORMAT]

Headline

Standfirst / Summary

[Article Cover Image]

[Small Contributor Photo]

By Contributor Name
Public Designation
Affiliation

Published date • Reading time

ARTICLE BODY

Optional:
- Contributor Disclosure
- Editor's Note
- Contributor Disclaimer
- About Contributor

This is a target public structure and must reuse existing News Pulse article
components wherever practical.

---

## 24. Public Pulse Dialogue Landing Page — PHASE 1 TARGET

The existing News Pulse category shell must be preserved.

Keep existing:

- Global header
- Advertisement areas
- Trending strip
- Explore Categories
- Right rail
- Footer
- Language behavior
- Theme behavior
- Responsive shell

Do not create a completely separate page architecture for Pulse Dialogue.

Approved page header:

Label:
PULSE DIALOGUE DESK

Title:
Pulse Dialogue

Description:
Ideas, essays, conversations and perspectives from writers, scholars,
experts and independent voices.

### Pulse Dialogue Article Cards

Pulse Dialogue article cards may eventually display:

- Dialogue Format
- Article Cover Image
- Headline
- Summary / Standfirst
- Contributor Photo
- Contributor Name
- Public Designation
- Optional Series / Column
- Publication date
- Reading time

Canonical visual rule:

Article Cover Image
= story/topic

Contributor Photo
= writer/person

Do not replace the article cover with the contributor photo by default.

### Initial Landing-Page Structure

Phase 1 may eventually support:

Featured Dialogue
→ one selected or leading Pulse Dialogue contribution

Latest Contributions
→ normal Pulse Dialogue article feed

Do not create many empty content sections before enough real content exists.

### Empty State

Until published Pulse Dialogue articles exist, preserve the existing safe
empty state.

Do not inject:

- demo articles
- sample articles
- unrelated articles
- stale articles

just to fill the page.

---

## 25. Author / Editor / Publisher Separation

For Pulse Dialogue:

AUTHOR
= Contributor

EDITORIAL REVIEW
= News Pulse newsroom

PUBLISHER
= News Pulse

The logged-in News Pulse staff member who enters or edits a contributed
article must not automatically become the public author merely because they
used Add News.

---

## 26. Scheduling

Reuse the existing News Pulse scheduling system.

Do not create Pulse Dialogue-specific scheduling logic.

---

## 27. Multilingual Rules

News Pulse languages:

- English
- Hindi
- Gujarati

One contributor identity should be shared across all translated versions of
the same contribution.

Do not create separate contributor profiles merely because an article exists
in EN / HI / GU.

Shared identity may include:

- Contributor ID
- Photo
- Canonical identity
- Public URLs

Fields that may later support localization include:

- Public Designation
- Bio
- Dialogue Format labels
- Series descriptions

Contributor names should not be blindly machine-translated as ordinary
article body text.

Optional manually controlled Gujarati and Hindi display names may be supported.

---

## 28. SEO / Structured Data — FUTURE

Pulse Dialogue should eventually distinguish:

AUTHOR
= Person

PUBLISHER
= News Pulse

Contributor identity may provide:

- name
- image
- contributor profile URL
- affiliation

Reuse existing News Pulse SEO infrastructure rather than creating a
parallel SEO system.

---

## 29. Phase 1 — Approved Target

Phase 1 may eventually include:

- Contributor Profiles
- Contributor Photo
- Contributor Type
- Public Designation
- Affiliation
- Short Bio
- Contributor Status
- Rights / Consent
- Dialogue Format
- Contributor selection in Add News
- Create Contributor
- Byline Designation Override
- Series / Column metadata
- Article Cover Image using existing media architecture
- Image metadata / rights
- Contributor Disclosure
- Editor's Note
- Contributor Disclaimer
- Optional About Contributor
- Public Pulse Dialogue landing page using the existing category shell
- Phase 1 landing-page header and safe empty state
- Featured Dialogue / Latest Contributions structure when real content exists
- Existing Draft Desk
- Existing Preview
- Existing Publish
- Existing Schedule

IMPORTANT:
These are APPROVED TARGET CAPABILITIES.
Do not assume they already exist in code.

---

## 30. Phase 2 — Later

Possible future work:

- Public Contributor Profile
- All Articles by Contributor
- Contributor archive
- Series / Column archive
- View All Contributions

Do not implement Phase 2 unless separately approved.

---

## 31. Phase 3 — Later

Possible future work:

- Featured Voices
- Featured Dialogue
- Columns section
- Essays section
- Culture & Literature section
- Conversations section
- Contributor discovery

Do not implement Phase 3 unless separately approved.

### Future Public Page Enhancements — Later Phase

These ideas must be preserved in the architecture document so they are not
forgotten, but they are NOT part of the initial implementation.

Do not implement them until:

1. enough real Pulse Dialogue content exists, and
2. Founder separately approves the upgrade.

Possible future filters:

- All
- Columns
- Essays
- Viewpoints
- Conversations
- Culture & Ideas

Possible future sections/features:

- Featured Dialogue
- Featured Voices
- Columns
- Essays
- Culture & Literature
- Conversations
- Contributor discovery
- Contributor archives
- Series / Column archives

Important:
Do not build empty sections or filters before enough real content exists.

The current Pulse Dialogue category shell should remain usable until these
later enhancements are needed.

---

## 32. Explicit Non-Goals

Do NOT build unless separately approved:

- Contributor login
- Contributor self-publishing
- Separate Pulse Dialogue dashboard
- Separate article database
- Separate article editor
- Separate Draft Desk
- Separate scheduler
- Separate translation system
- Separate Media Library
- New permissions architecture

---

## 33. Upgrade Rule

Before any future Pulse Dialogue implementation or upgrade:

1. Read this specification completely.
2. Inspect the current implementation.
3. Determine what already exists.
4. Do not assume this specification has already been implemented.
5. Reuse existing News Pulse architecture.
6. Identify the smallest safe change.
7. Do not break existing publishing workflows.
8. Keep localhost/testing isolated from production.
9. Run focused regression tests.
10. Run appropriate type-check/build validation.
11. Do not commit or push until Founder approval.
12. Update this document when an approved architectural decision changes.
13. Never silently change an approved rule in this document.
14. If code and specification conflict, report the conflict before changing code.

---

## 34. Core Identity Summary

Article Cover Image
→ represents the story/topic

Contributor Photo
→ represents the writer

Byline
→ identifies the contributor

About Contributor
→ optional extended information

Contributor
→ author / voice

News Pulse
→ editorial reviewer and publisher

Pulse Dialogue
→ signed-contributor publishing desk

News Pulse Editorial
→ institutional editorial voice