# News Pulse Backend Rules

Read [BRAIN.md](./BRAIN.md) before changing this repository. This document is a
practical safety checklist; [architecture.md](./architecture.md) maps the active
implementation. Neither document overrides current code and tests.

## Source of truth

- Inspect the active entry point, route mounts, services, models, and relevant
  tests before editing. Start with [server.js](./server.js), not a similarly
  named file in a legacy directory.
- Follow the source-of-truth order in [BRAIN.md](./BRAIN.md): current code and
  tests take precedence over historical documentation or implementation reports.
- Trace compatibility aliases and callers before deciding a module is unused.
  Some nested legacy modules are still imported by the running application.
- Keep documentation factual and durable. Do not use it as a release log,
  transient task tracker, or claim of production verification.

## Production and secret safety

- This is a live production backend. Local work does not authorize production
  API requests, database access, repairs, resynchronization, or deployment.
- Never display, copy, log, or commit private environment files, credentials,
  passwords, signing secrets, tokens, OTP values, or private keys.
- Consult [environmentSafety.js](./lib/environmentSafety.js) and the relevant
  integration code before running anything with external effects.
- Keep development/testing isolated from production MongoDB, Redis, authentication
  state, email/OTP delivery, translation providers, media storage, and other APIs.
  Use approved non-production resources or mocks.
- Do not assume `NODE_ENV=test` alone proves isolation. Importing
  [server.js](./server.js) still loads environment configuration, even though
  its normal database startup and scheduler are skipped in test/import mode.
- Inspect maintenance scripts before execution: target connection, scope,
  read/write behavior, implicit index operations, and failure handling.
  A dry run can still connect to a database; it is not automatically offline.
- Obtain explicit approval before production mutations, commits, pushes, or
  deployment. A code fix does not authorize running its maintenance utility.

## Authentication and access boundaries

- Preserve signed-token validation, persisted account checks, account lifecycle,
  token-version checks, module permissions, and Founder-only authorization.
  Review [adminAuth.js](./middleware/adminAuth.js),
  [requireAuth.js](./middleware/requireAuth.js), and their callers when relevant.
- Do not revive legacy opaque tokens, email cookies, or client-side role checks
  as substitutes for the active server-side authentication flow.
- Preserve Reporter Portal ownership/session checks, OTP protections, review
  gates, and Community Reporter governance.
- Preserve cookie-request security, CORS rules, security/lockdown confirmation,
  and Founder-only diagnostics. Do not weaken them to make a test pass.
- Keep general mail and Reporter OTP mail scopes distinct. Inspect the current
  provider/stub conditions instead of assuming every mail route behaves alike.

## Publishing, identity, and public visibility

- Reuse the active publishing and sync services; do not add a parallel write
  path merely to fix metadata.
- Preserve the applicable filters in
  [publicArticleVisibility.service.js](./services/publicArticleVisibility.service.js).
  The News and Public Article filters are not identical; use the correct one.
- Never expose drafts, deleted/private content, or future-scheduled content
  through a public endpoint as a workaround for missing metadata.
- A metadata-only fix is not republication. Preserve existing record IDs,
  slugs/URLs, creation/publication timestamps, status, views, analytics identity,
  source linkage, and media.
- Do not merge language siblings by translation-group ID when updating a public
  copy. Follow the existing source-ID/slug matching in
  [syncPublicArticleFromNews.service.js](./services/syncPublicArticleFromNews.service.js).
- Exact `category === "regional"` is the Gujarat desk. Canonical public sync
  supplies Gujarat state metadata while retaining district/city information
  and geographic tags. Do not infer state from article text or apply this
  category rule to unrelated categories.
- Fix upstream geography rather than loosening the Regional feed predicate.
  Preserve category filtering, ordering, language selection, and response shape.

## EN/HI/GU and media

- Preserve the English, Hindi, and Gujarati language architecture, including
  `translationGroupId`, `translationKey`, `sourceArticleId`, `sourceLanguage`,
  per-language slugs, translation buckets, and readiness state.
- Do not regenerate translations, reset translation state, overwrite human
  edits, or invoke a provider as an incidental part of an unrelated change.
- Preserve child-language cover images. Source/group synchronization is not
  permission to replace a child's media with the parent's.
- Review both publication and translation-group tests when changing a shared
  sync path. Ordinary public-copy synchronization and translation generation
  are separate responsibilities.

## Change scope and validation

- Make the smallest complete change. Reuse helpers and existing conventions;
  avoid duplicate geography, authorization, publishing, or translation logic.
- Preserve unrelated worktree changes. Do not bundle unrelated cleanup,
  historical test repairs, frontend/Admin UI changes, or data maintenance.
- Surface failures through repository-standard errors and safe logging.
  Do not disguise incomplete public synchronization as successful synchronization.
- Add focused regressions for changed behavior and its preservation boundaries.
  Run tests only after isolating external dependencies and credentials.
- Use [package.json](./package.json) as the command source:
  `npm test` uses Node's test runner; `npm run build` performs the
  [server.js](./server.js) syntax check. Check other changed JavaScript files
  explicitly with `node --check`.
- Run the smallest relevant suite first. Separate pre-existing failures from
  regressions; do not weaken tests or authorization to obtain a green result.
- Review `git diff --check`, `git status`, and the final diff before handoff.
  Report validation limits and actions not performed accurately.
- Documentation-only changes need link/content and whitespace review; they do
  not require application startup or production access.
