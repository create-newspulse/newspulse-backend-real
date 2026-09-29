# Backend Privacy and Security Review

## Authentication and Deployment Compatibility

- Privileged access requires a current persisted account, an explicitly typed access JWT, allowed account state, and matching tokenVersion. Database outages return an error, never claims-only authorization. Existing unsigned, untyped, deleted-account and refresh credentials cannot grant access.
- Active admin login aliases use the account-backed staff handler. Environment credentials are not a maintenance bypass. Seed/repair workflows remain separate, controlled operations; this pass does not run them.
- Refresh atomically increments the existing account-wide tokenVersion. A refresh is single-use and invalidates prior access/refresh credentials for that account, including other devices. Clients must serialize refresh and replace both tokens. Logout revokes the account-wide version. This is not per-device rotation.
- Cookie-authenticated writes require an allowed Origin. Bearer requests and explicitly supplied refresh credentials remain supported. Admin proxies must forward the legitimate Origin or use Bearer authentication. Production cookies remain HttpOnly/Secure; login and refresh responses are no-store.
- Existing trusted-proxy depth and explicit CORS policy are retained. The deployment edge must overwrite forwarding headers and block direct backend bypass. OTP/privacy limiters use Express req.ip, not the first caller-supplied forwarding value. In-process rate limits require an edge/shared limiter for multi-instance deployments.

## OTP and Reset Credentials

- Admin and Reporter Portal OTP generation uses crypto.randomInt. Admin verification reserves one of five persisted attempts atomically; request/verify/reset aliases share IP/email throttling.
- Admin reset tokens are random, stored as SHA-256 digests, expire after 15 minutes, and are atomically consumed once. OTP verification cannot repeatedly mint reset tokens. Both reset aliases enforce the common password policy and invalidate account credentials.
- Existing raw admin reset tokens are intentionally not accepted; request a new OTP after rollout. No migration or cleanup is required. A database failure after reset-token consumption requires a new OTP, not reuse of a consumed credential.
- Production-like environments never echo OTPs. Local response-only development delivery remains available; logs do not contain OTPs or reset links.

## Privacy Authorization and Action Scope

- Admin privacy routes require Founder or an explicit existing dpdpCompliance module grant, subject to Founder policy locks. The DELETE/ANONYMIZE text is confirmation, not authorization.
- Production privacy storage fails closed when MongoDB is unavailable; it never falls back to repository JSON. Review any historical file-backed requests separately before rollout; no migration was performed.
- Matching/actions require verifiedAt and actionable status, and match only the verified email. Request-supplied phone numbers and pending reporter email addresses do not prove identity. Editing workflow status cannot substitute for email verification.
- Delete means physical deletion of explicitly selected supported records. Linked/published editorial submissions refuse deletion and require the explicit legacy anonymize action. That action reports structured_private_identity_redacted, not an assertion that editorial text is anonymous.
- Community and journalist contacts are explicit selectable sources. Contact actions redact linked submission identity/contact methods, profile email/phone/location, and revoke retained contact portal access. Story-level actions do not implicitly authorize deleting an entire reporter account.
- Private document cleanup uses the dedicated authenticated storage service and protected legacy directories. Provider/local deletion failures return an error and prevent database transaction commit. Known document references remain available for retry.
- Database actions require MongoDB transaction support (replica set/Atlas); there is no silent nontransactional fallback. Media storage cannot join that transaction: deletion is idempotent, so a database rollback after media deletion must be retried. Review error outcomes before recording completion.
- Published news/articles, legal/security/audit/payment records and staff/admin/Founder accounts are not mass-deleted. Retained editorial bodies, public bylines, shared article assets, orphan profiles, Youth Pulse records and historical exports/backups require scoped manual review. Reporter actions stay In Review until that review; completion is a separate verified, authorized decision.
- Archive/soft delete changes visibility/lifecycle only and is not erasure. Contact/profile archives in this path also explicitly clear supported private identity fields.

## Retention Decisions

Existing security expiry is retained: admin OTP validity is 10 minutes, reset validity is 15 minutes, and OtpToken has expiresAt TTL plus a one-hour createdAt TTL. Reset issuance extends expiresAt to its reset deadline. TTL deletion is asynchronous; application expiry checks remain authoritative. Existing reporter session/challenge expiry is unchanged.

Founder/legal approval is still required for retention periods and legal-hold rules for submissions, reporter identity/profile/contact data, privacy requests and audit trails, moderation/security logs, mail-provider logs, uploaded identity documents, publications, exports and backups. No arbitrary business-data TTLs or production deletion jobs were added. Historical plaintext reset tokens/logs/backups need a separately approved inventory/retention process; no data was inspected or purged here.

## Youth Policy Decision

Youth Pulse is an intentional submission workflow with consent declarations, not verified parental consent. Community intake also accepts age groups. No blanket under-18 rejection or invented parental verification system was added. Founder/legal review must decide eligibility, age assurance, parental-consent requirements, private contact collection, publication and retention before claiming under-18 compliance.

## Local Verification Boundary

Focused tests use synthetic credentials, model/provider mocks and temporary document directories. No production database, live email/OTP, deployment, migration, cleanup, or real cloud deletion is part of local verification. The historical privacy_requests test writes repository JSON stores and is not an approved safe full-suite gate. This document is an engineering review, not legal certification.