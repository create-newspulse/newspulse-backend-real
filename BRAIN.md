# News Pulse Backend - Project Brain

This file contains durable repository context for coding agents and developers.

It is not a changelog, release log, implementation-status report, roadmap, or task tracker.

## Repository Identity

Repository:

`newspulse-backend-real-main`

Application:

News Pulse production backend API.

Primary runtime:

- Node.js
- Express
- MongoDB
- Render deployment

Primary entry point:

`server.js`

## Source of Truth

When documentation and implementation disagree, use this order:

1. current backend code
2. current automated tests
3. current route/middleware/service/model implementation
4. environment-safety code and `.env.example`
5. this `BRAIN.md`
6. maintained README/security/deployment documentation
7. Git history

Do not treat historical implementation-complete, deployment-complete, verified, or production-ready statements as proof of current behavior.

## Production Safety

This repository contains the production backend implementation.

Production data, credentials, authentication, email delivery, and external services must be protected.

Never:

- print or expose `.env`
- commit credentials or secret values
- hardcode database credentials
- hardcode JWT/session secrets
- hardcode SMTP/API credentials
- expose private keys or service-account credentials
- copy production secrets into documentation or tests
- silently connect local development to production services

Use `.env.example` to document variable names and safe examples.

The actual `.env` file is private and must not be copied into documentation, logs, prompts, or commits.

## Local / Production Isolation

Local development must remain isolated from production wherever practical.

Before modifying database, authentication, Reporter Portal OTP, email delivery, or destructive maintenance code, inspect the current environment-safety implementation and relevant tests.

Do not silently use:

- production MongoDB
- production email delivery
- production OTP delivery
- production authentication state
- production destructive maintenance operations

from localhost or test code.

## Authentication

The current implementation is authoritative.

Admin authentication currently includes credential-based routes such as `/admin/login`.

Do not revive or assume historical authentication designs merely because older routes or documentation still exist.

Before changing authentication, inspect:

- current auth routes
- auth middleware
- token/session implementation
- Founder protections
- related tests

Do not weaken authentication or Founder-only protections for convenience.

## Founder Protection

Founder authorization is a security boundary.

Routes or actions protected by Founder authentication must remain protected unless an intentional architecture change explicitly requires otherwise.

Never turn Founder-only authorization into a client-side-only check.

Destructive Founder/system actions require special care and current tests should be consulted before modification.

## Reporter Portal and OTP

Reporter Portal authentication and OTP delivery are active backend capabilities.

Relevant implementation includes Reporter authentication routes, OTP challenge persistence, delivery behavior, logging controls, mail configuration, and environment-safety checks.

The codebase currently contains both:

- general mailer/provider infrastructure
- development/stub email behavior

Do not assume the stub is obsolete merely because SMTP or Resend support exists.

Do not assume stub delivery is production-safe.

Inspect the actual route conditions, mail scope, environment checks, and tests before changing Reporter OTP behavior.

OTP codes, credentials, and email-provider secrets must never be exposed in documentation or logs intended for production.

## Email

Mail functionality is implemented through current mailer/email modules and route-specific behavior.

Supported behavior can depend on:

- environment
- mail scope
- provider selection
- development-delivery mode
- production safety checks

Use the current implementation and tests as the source of truth.

Do not replace scoped mail behavior with a single global assumption without verifying all callers.

## Community Reporter

Community Reporter and Reporter Portal functionality are active backend systems.

Preserve current submission, identity, authentication, review, Founder-governance, and related safety behavior unless the requested change explicitly modifies that architecture.

Migration, normalization, repair, and cleanup scripts can affect stored data.

Never run destructive scripts against production merely to test them.

## Public Site Settings

Public Site Settings are an active backend capability.

Current implementation includes the model, controller, public route, and admin route.

Use current code and tests as the source of truth for:

- public published settings
- admin draft/published settings
- authentication
- environment separation
- CORS
- route behavior

`DEPLOYMENT_CHECKLIST.md` may contain operational history or feature-specific deployment guidance. Do not treat its historical implementation-status statements as current architecture proof.

## Security and Lockdown

Security/lockdown functionality is active.

Current route mounts include security, alerts, and threat/dashboard functionality.

`SECURITY_LOCKDOWN_ENDPOINTS.md` is supporting documentation, but current routes, middleware, services, and tests are authoritative.

Do not weaken:

- security authorization
- lockdown confirmation requirements
- incident handling
- threat controls
- alert protections

without an explicit requirement.

## News Pulse Engine

News Pulse Engine backend functionality includes system health/diagnostics and related operational checks.

Founder-only diagnostics must preserve their authorization boundary.

Provider health or availability must not be reported as healthy without evidence from the current implementation.

## Publishing and Public Content

Public content APIs must not expose unpublished or draft material unless an endpoint is explicitly designed and authorized to do so.

When changing article lookups, translations, feeds, scheduling, publishing, or status behavior, inspect the current public-visibility tests and authorization rules.

## Environment Variables

Never infer production configuration from documentation alone.

Use:

- `.env.example`
- environment validation/safety code
- current runtime code
- tests

to determine required variable names and behavior.

Never display actual values from `.env`.

## Deployment

Production deployment is hosted on Render.

`server.js` is the production entry point unless the repository architecture is intentionally changed.

Before deployment-related changes:

- verify startup behavior
- verify environment requirements
- verify database safety
- verify authentication
- verify public/admin route behavior
- run applicable tests

Do not make deployment documentation itself the source of truth over current code.

## Tests and Validation

Current package scripts include:

- `npm run build` for syntax validation
- `npm test` for the Node test suite

For focused changes:

1. inspect `git status`
2. inspect the diff
3. run relevant focused tests
4. run `npm run build`
5. run broader tests when appropriate
6. inspect the final diff again

Do not fix unrelated historical test failures in the same change unless the task explicitly includes them.

## Maintenance Scripts

This repository contains migration, repair, inspection, cleanup, and verification scripts.

Treat scripts that mutate data as potentially destructive.

Before running one:

- inspect its code
- determine which database/environment it uses
- confirm whether it performs writes or deletes
- confirm local/staging versus production target

Never run a production repair, migration, cleanup, or destructive script simply as a development test.

## Documentation Policy

Keep documentation that provides continuing value for:

- architecture
- security
- deployment
- environment safety
- operational procedures

Avoid adding:

- temporary task status
- one-off debugging notes
- duplicate implementation reports
- outdated completion reports
- transient bug notes
- large snapshots of current implementation

Git history should preserve historical implementation details.

## Updating This Brain

Update `BRAIN.md` only when durable repository facts change, such as:

- architecture
- production safety rules
- authentication model
- source-of-truth hierarchy
- deployment architecture
- major subsystem ownership
- durable environment-isolation rules

Do not update it for routine fixes, task progress, temporary bugs, or release notes.
