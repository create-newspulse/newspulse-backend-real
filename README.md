## CommunityAI Configuration

- `COMMUNITY_AI_URL`: Base URL for CommunityAI service (optional; info-only for logs/health).
- `COMMUNITY_AI_API_KEY`: API key for CommunityAI service (optional; info-only for logs/health).
- `OPENAI_API_KEY`: Required for OpenAI policy checks. If missing, the system logs a notice and gracefully falls back.

Behavior:
- Network errors or missing keys do not block submissions. We use a safe fallback (`ai_parse_error` flag, `status: PENDING_FOUNDER`).
- Health endpoint: `/api/system/community-ai-health` reports readiness (env presence) and last invoke status.

# NewsPulse Backend (Root)

This is the consolidated production backend. The older nested directory `newspulse-backend-real-main/` remains for reference but should not be used for deployment.

## Quick Start
```bash
cp .env.example .env
npm install
npm run dev
```
Local dev requires `MONGODB_URI` and a running MongoDB instance (local or Atlas).
Server listens on `PORT` (from `.env` in local dev).

If your frontend dev proxy targets `http://localhost:5000`, make sure your backend `PORT` matches it in local dev. If you hit an `EADDRINUSE` error, free the conflicting process or update the proxy target to the actual backend port.

## Media Upload Status (Admin Contract)

The admin article editor relies on a **stable** media upload status endpoint to decide whether Cover Image uploads are available.

Endpoint(s):
- `GET /api/media/status`
- `GET /admin-api/media/status`
- `GET /admin-api/api/media/status` (compat)

Response contract (top-level keys are stable):
```json
{
  "ok": true,
  "provider": "cloudinary",
  "available": false,
  "reason": "Cloudinary not configured",
  "configured": false,
  "message": "Cloudinary not configured"
}
```

Notes:
- `available` is the authoritative capability flag.
- When `available` is `true`, `reason` is `null`.

## MongoDB

This backend connects using a single variable: `MONGODB_URI`.
Provide the full connection string exactly as you want Mongoose to connect.

## Broadcast Auto-Translation (Google-only)

Broadcast items store per-language text in a single document (`text_i18n`). When a broadcast item is created, the backend saves the source text and (best-effort) auto-translates into the other supported languages.

Required env var:
- `GOOGLE_TRANSLATE_API_KEY` (Google Cloud Translation API v2 key)

Notes:
- If the key is missing or the API call fails, the backend leaves that translation empty (`null`).
- Public endpoints fall back to the source language (or any available text) so the UI never blocks on translation.

Endpoints:
- Admin create: `POST /api/admin/broadcast/items` body `{ "type": "breaking"|"live", "text": "...", "lang": "en"|"hi"|"gu" (optional, default "gu") }`
- Public ticker fetch: `GET /api/public/broadcast/items?type=breaking|live&lang=en|hi|gu`

## Public Site Settings: Dev/Prod Isolation

To prevent local admin/public changes from affecting production (and vice-versa), Public Site Settings are **namespaced by scope**.

- Default scope:
  - `NODE_ENV=production` -> `scope=production`
  - otherwise -> `scope=development`
- Optional override: set `PUBLIC_SITE_SETTINGS_SCOPE` (e.g. `staging`) if you want additional isolated environments.

This means even if a misconfiguration points dev and prod at the same MongoDB cluster, they will not share the same `PublicSiteSettings` document.

### Quick verification (recommended)

The backend includes safe debug headers so you can instantly tell which backend answered a request:

- `X-Newspulse-Env`: the backend `NODE_ENV`
- `X-Newspulse-Db`: connected DB name (or `connected`/`disconnected`)

Example:

```bash
curl -i "http://localhost:5000/api/public/settings"
```

Look for:
- `X-Newspulse-Env: development`
- JSON contains `"scope":"development"`

### Production Environment Variables (example)

```env
NODE_ENV=production
MONGODB_URI=mongodb+srv://USER:PASS@CLUSTER/YOUR_DB_NAME
ALLOWED_ORIGINS=https://admin.newspulse.co.in,https://newspulse.co.in,https://www.newspulse.co.in
```

## Environment Variables
| Name | Purpose | Notes |
|------|---------|-------|
| PORT | Preferred listen port | Fallback logic tries next ports if busy |
{
  "success": true,
  "accessToken": "<ACCESS_JWT>",
  "refreshToken": "<REFRESH_JWT>",
  "user": { "id": "founder-1", "email": "founder@example.com", "name": "Site Founder", "role": "founder" },
  "accessExpiresInMinutes": 15,
  "refreshExpiresInDays": 30
}
| JWT_SECRET | Token signing secret | Change in production |

## Auth Endpoints
### POST /admin/login 
Requires these env vars to be set (official naming):
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `JWT_SECRET`

Backward compatibility:
- If `ADMIN_EMAIL`/`ADMIN_PASSWORD` are not set, the server will fall back to `FOUNDER_EMAIL`/`FOUNDER_PASSWORD`.

If credentials are missing, the admin login endpoints return HTTP 500 JSON:
`{ "ok": false, "message": "Admin credentials not configured" }`

Body:
```json
{ "email": "<FOUNDER_EMAIL>", "password": "<FOUNDER_PASSWORD>" }
```
Success:
```json

### POST /admin/refresh
Body:
```json
{ "refreshToken": "<REFRESH_JWT>" }
```
Success:
```json
{ "success": true, "accessToken": "<NEW_ACCESS_JWT>", "user": { "id": "founder-1", "email": "founder@example.com", "name": "Site Founder", "role": "founder" }, "accessExpiresInMinutes": 15 }
```
Failure:
```json
{ "success": false, "message": "Refresh failed" }
```
{
  "success": true,
  "token": "<JWT>",
  "user": { "id": "founder-1", "email": "founder@example.com", "name": "Site Founder", "role": "founder" }

### GET /admin/metrics
Returns uptime, activeUsers count, rate limiting backend (memory/redis), and token TTLs:
```json
{
  "success": true,
  "uptimeSeconds": 1234,
  "activeUsers": 0,
  "rateLimit": { "windowMs": 900000, "maxAttempts": 20, "backend": "memory", "inMemoryTracked": 3 },
  "tokens": { "accessTtlMinutes": 15, "refreshTtlDays": 30, "refreshStoreSize": 1 },
  "timestamp": "2025-11-20T00:00:00.000Z"
}
```
}
```
Failure: `401 { success: false, user: null, message: "Invalid credentials" }`
Rate limiting: 20 attempts per 15 minutes per IP (429 if exceeded).

### GET /admin-auth/session
Requires `Authorization: Bearer <JWT>` header.
Responses:
```json
{ "success": true, "user": { "id": "founder-1", "email": "...", "name": "...", "role": "founder" } }
| REDIS_URL | Redis connection string | Enables distributed rate limiting |
| ACCESS_TOKEN_TTL_MINUTES | Access token lifetime | Default 15 |
| REFRESH_TOKEN_TTL_DAYS | Refresh token lifetime | Default 30 |
{ "success": false, "user": null }
```
- Blacklist or rotate refresh tokens per logout.
- Move refresh token to httpOnly secure cookie.
- Redis cluster or sentinel for HA.
```json
{ "success": true, "status": "online", "lastUpdated": "2025-11-20T00:00:00.000Z" }
- Access tokens default to 15 minutes; refresh tokens 30 days.
- Rate limiter automatically prefers Redis if `REDIS_URL` is set, otherwise in-memory.
- Metrics endpoint supplies operational snapshot for dashboards.
Returns a simple JSON health indicator.

### 404 Handling
Unknown routes return:
```json
## Development Notes
- Avoid using the nested folder for new changes; all future changes belong at repo root.

## Public Articles API (Frontend Feeds)

### Required env vars

### Endpoints

#### GET /api/articles
Query params:
- `status` (default `published`) — `published` or `draft` (draft requires admin auth)
- `category` — one of: `breaking`, `regional`, `national`, `international`, `business`, `tech`, `sports`, `lifestyle`, `glamour`, `web-stories`, `viral-videos`, `editorial`, `youth-pulse`, `inspiration-hub`
- `isBreaking` — `true|false`
- `lang` — `en|hi|gu`
- `state`, `district`, `city`
- `limit` (default 20), `page` (default 1)
- `q` (optional search)

Example:
```bash
curl "http://localhost:10000/api/articles?category=national&lang=en&limit=10&page=1"
```

Response:
```json
{
  "items": [
    {
      "_id": "676a7b0b0e2d2e5d9b7b1234",
      "title": "Example headline",
      "slug": "example-headline",
      "summary": "Short summary",
      "content": "Full content...",
      "category": "national",
      "language": "en",
      "status": "published",
      "publishedAt": "2025-12-24T10:00:00.000Z",
      "isBreaking": false,
      "coverImage": "https://cdn.example.com/image.jpg",
      "tags": ["politics"],
      "state": null,

## Public News API (Multilingual)

### GET /api/public/news
Returns **published** news stories (no auth required).

Query params:
- `category` (existing)
- `lang` (new) — `en|hi|gu` (default is `gu`; missing `lang` in DB is treated as `gu`)
- `q` (existing search)
- `page` (default 1), `limit` (default 30)

Examples:
```bash
curl "http://localhost:10000/api/public/news?category=national&lang=en&limit=5"
curl "http://localhost:10000/api/public/news?category=national&lang=hi&limit=5"
curl "http://localhost:10000/api/public/news?q=budget&lang=en&limit=5"
```

Backfill (one-time):
```bash
MONGODB_URI="<your-mongo-uri>" node scripts/backfill-news-lang.js
```

Response shape (unchanged):
```json
{ "items": [], "page": 1, "limit": 30, "total": 0, "totalPages": 1 }
```

## Broadcast Center (Breaking + Live Updates)

### Public

#### GET /api/public/broadcast
Returns a stable payload for the website ticker(s):
```json
{
  "breaking": { "enabled": true, "speedSec": 8, "items": ["..."] },
  "live":     { "enabled": false, "speedSec": 8, "items": [] }
}
```

No-cache: public broadcast responses include `Cache-Control: no-store`.

#### GET /api/public/broadcast?detailed=1
Returns a detailed payload (items include stable `id` field):
```json
{
  "breaking": { "enabled": true, "mode": "auto", "speed": 8, "items": [{"id":"...","type":"breaking","text":"...","createdAt":"...","expiresAt":"..."}] },
  "live":     { "enabled": false, "mode": "auto", "speed": 8, "items": [] }
}
```

Example:
```bash
curl "http://localhost:10000/api/public/broadcast"
```

Detailed example:
```bash
curl -i "http://localhost:10000/api/public/broadcast?detailed=1"
```

### Admin (via /admin-api)

All admin endpoints require:
- `Authorization: Bearer <ADMIN_JWT>` (or a compatible legacy admin cookie)

### Admin (standardized)

Admin Panel contract (preferred for production; same-origin via Vercel `/admin-api/*` rewrite):
- Base: `GET/PUT /admin-api/admin/broadcast`
- Items: `GET/POST /admin-api/admin/broadcast/items`
- Item delete: `DELETE /admin-api/admin/broadcast/items/:id`

Proxy alias (some admin builds):
- `GET/PUT /admin-api/api/admin/broadcast` (same endpoints under `/items`)

Backend direct (no proxy):
- Base: `GET/PUT/PATCH /api/admin/broadcast` (same endpoints under `/items`)

Notes:
- Success envelope: `{ ok: true, success: true, data: ... }`
- Settings contract: `breaking` + `live` return `{ enabled, mode, durationSec }` (legacy keys are still accepted on write for compatibility).
- Each item includes `id` (string) and `_id` (string), plus `type`, `text`, `createdAt` (and `expiresAt` when present).

Example: list items
```bash
curl "http://localhost:10000/admin-api/admin/broadcast/items?type=breaking" \
  -H "Authorization: Bearer <ADMIN_JWT>"
```

Example: create item (defaults to `isLive: true`)
```bash
curl -X POST "http://localhost:10000/admin-api/admin/broadcast/items" \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"type":"breaking","text":"Breaking: Airport roads closed due to fog"}'
```

Example: update item
```bash
curl -X PATCH "http://localhost:10000/admin-api/admin/broadcast/items/<ITEM_ID>" \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"isLive":false,"text":"Updated text"}'
```

Alias note: some admin UIs send `{ "enabled": true|false }` instead of `isLive`.

Example: delete item
```bash
curl -X DELETE "http://localhost:10000/admin-api/admin/broadcast/items/<ITEM_ID>" \
  -H "Authorization: Bearer <ADMIN_JWT>"
```

Example: update settings
```bash
curl -X PUT "http://localhost:10000/admin-api/admin/broadcast" \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"breaking":{"enabled":true,"mode":"auto","durationSec":18},"live":{"enabled":true,"mode":"auto","durationSec":20}}'
```

#### POST /admin-api/broadcast/breaking/items
Body:
```json
{ "text": "Breaking: Airport roads closed due to fog" }
```

Example:
```bash
curl -X POST "http://localhost:10000/admin-api/broadcast/breaking/items" \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d "{\"text\":\"Breaking: Airport roads closed due to fog\"}"
```

#### GET /admin-api/broadcast
Returns `{ settings, itemsLast24h: { breaking:[], live:[] } }`.

Example:
```bash
curl "http://localhost:10000/admin-api/broadcast" \
  -H "Authorization: Bearer <ADMIN_JWT>"
```

#### PATCH /admin-api/broadcast/settings
Body:
```json
{
  "breaking": { "enabled": true, "mode": "auto", "speedSec": 8 },
  "live": { "enabled": true, "mode": "force_off", "speedSec": 10 }
}
```

Example:
```bash
curl -X PATCH "http://localhost:10000/admin-api/broadcast/settings" \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"breaking":{"enabled":true,"mode":"auto","speedSec":8},"live":{"enabled":true,"mode":"force_off","speedSec":10}}'
```

#### DELETE /admin-api/broadcast/items/:id
Example:
```bash
curl -X DELETE "http://localhost:10000/admin-api/broadcast/items/<ITEM_ID>" \
  -H "Authorization: Bearer <ADMIN_JWT>"
```

### GET /api/public/news/translations/:translationGroupId
Returns all published translations for a translation group (no auth required), sorted by `language`.

Example:
```bash
curl "http://localhost:10000/api/public/news/translations/<translationGroupId>"
```
      "district": null,
      "city": null,
      "createdAt": "2025-12-24T10:00:00.000Z",
      "updatedAt": "2025-12-24T10:00:00.000Z"
    }
  ],
  "page": 1,
  "limit": 10,
  "total": 1,
  "totalPages": 1
}
```

#### GET /api/articles/:slug
Example:
```bash
curl "http://localhost:10000/api/articles/example-headline"
```

Returns the article document (published only unless admin auth is present).

### Secret Rotation & Hygiene

- If any credential is leaked (e.g., MongoDB Atlas `MONGODB_URI`), immediately rotate the user/password in the provider (Atlas), then update `MONGODB_URI` in deployment and local `.env`.
- Confirm `.gitignore` excludes all `.env*` files; only `.env.example` remains versioned with placeholders.
- Optional history scrub (recommended if a real secret was committed):
  - Install `git-filter-repo` and run:
    ```bash
    # Remove entire file from history (example)
    git filter-repo --force --invert-paths --path .env --path newspulse-backend-real-main/.env

    # Or surgically replace a leaked value
    git filter-repo --force --replace-text replacements.txt
    # replacements.txt format:
    # SECRET_VALUE==>REDACTED
    ```
  - Force-push and notify collaborators:
    ```bash
    git push --force-with-lease origin main
    ```
- CI guardrails: gitleaks GitHub Action scans pushes/PRs to `main` and fails on potential secrets.


## Deployment (Render)
Blueprint `render.yaml` sets rootDir to `.`. Build with `npm install`, start with `npm start` (which runs `node server.js`). Ensure the required env variables are configured.

### Deployment Steps
1. **Push to main branch**: Render auto-deploys from the main branch. Ensure your changes are committed and pushed.
2. **Check Render dashboard**: Confirm the latest commit hash matches your pushed commit.
3. **Environment variables**: In Render dashboard, set all required env vars (see `.env.example`).
4. **CORS**: Ensure `CORS_ORIGIN` includes:
  - `http://localhost:5173`
  - `https://admin.newspulse.co.in`
5. **Manual deploy**: If needed, trigger a manual deploy from the Render dashboard.
6. **Verify endpoints**: After deploy, run the verification script below.

### Endpoint Verification
To verify that the public/admin site settings endpoints are live and returning correct codes:

**Quick verification (Node.js):**
```bash
node verify-endpoints.js
```

**Comprehensive test (PowerShell) - Local:**
```powershell
.\test-all-endpoints.ps1
```

**Comprehensive test (PowerShell) - Production:**
```powershell
.\test-all-endpoints.ps1 https://newspulse-backend.onrender.com
```

Expected output:
```
=== Testing Public Site Settings API ===
1. GET /api/public/settings (no auth)
   ✅ PASS: HTTP 200, has 'ok' and 'published'
2. GET /api/admin/settings/public (no auth, expect 401)
   ✅ PASS: HTTP 401 (route exists, auth required)
3. GET /api/admin/settings/public/draft (no auth, expect 401)
   ✅ PASS: HTTP 401 (route exists, auth required)
4. PUT /api/admin/settings/public/draft (no auth, expect 401)
   ✅ PASS: HTTP 401 (route exists, auth required)
5. POST /api/admin/settings/public/publish (no auth, expect 401)
   ✅ PASS: HTTP 401 (route exists, auth required)
✅ All tests passed! Routes are correctly implemented.
```

**Production verification (cURL):**

Replace `<YOUR_DOMAIN>` with your Render backend URL (e.g., `newspulse-backend.onrender.com`):

```bash
# Test public endpoint (should return 200 with published settings)
curl https://<YOUR_DOMAIN>/api/public/settings

# Test admin endpoint without token (should return 401 Unauthorized)
curl https://<YOUR_DOMAIN>/api/admin/settings/public

# Test admin endpoint WITH token (should return 200 with draft + published)
curl -H "Authorization: Bearer <YOUR_ACCESS_TOKEN>" \
  https://<YOUR_DOMAIN>/api/admin/settings/public

# Test publish endpoint (should return 401 without token, 200 with token)
curl -X POST \
  -H "Authorization: Bearer <YOUR_ACCESS_TOKEN>" \
  https://<YOUR_DOMAIN>/api/admin/settings/public/publish
```

**Route inspection (dev only):**
```bash
# List all registered /api routes
curl http://localhost:5000/api/routes-check
```

If any check fails:
- Confirm backend is running and deployed
- Check environment variables in Render dashboard
- Verify CORS_ORIGIN includes your admin domain
- Check Render logs for startup errors

## Security Recommendations
- Set a strong `JWT_SECRET` (64+ random chars) in production.
- Consider moving the rate limiter to a shared store (Redis) for multi-instance scaling.
- Add HTTPS enforcement at the proxy layer (Render handles TLS by default).

## Future Enhancements
- Persistent account storage (replace env-based founder credentials).
- Proper refresh token rotation.
- Centralized logging & metrics.

## Email / OTP Configuration
To enable OTP and other email sends, set these environment variables (Render dashboard or local `.env`). Minimum required:

| Var | Example | Notes |
|-----|---------|-------|
| `SMTP_HOST` | `smtp.gmail.com` | Omit if using `SMTP_SERVICE` |
| `SMTP_PORT` | `465` | Use 465 with `SMTP_SECURE=true`, or 587 with STARTTLS |
| `SMTP_SECURE` | `true` | Auto-true if port 465; false for 587 |
| `SMTP_SERVICE` | `gmail` | Optional shortcut (use instead of HOST/PORT) |
| `SMTP_USER` | `newspulse.team@gmail.com` | Gmail address (must match App Password) |
| `SMTP_PASS` | `<app-password>` | 16‑char Gmail App Password (not regular password) |
| `MAIL_FROM` | `"NewsPulse Admin <newspulse.team@gmail.com>"` | Supported sender alias |
| `FROM_EMAIL` | `"NewsPulse Admin <newspulse.team@gmail.com>"` | Supported sender alias |
| `EMAIL_FROM` | `"NewsPulse Admin <newspulse.team@gmail.com>"` | Preferred display name + sender |
| `SMTP_FROM` | `noreply@newspulse.co.in` | Optional envelope override |
| `APP_BASE_URL` | `https://www.newspulse.co.in` | Preferred public base URL for reporter portal/runtime diagnostics |
| `SITE_URL` | `https://www.newspulse.co.in` | Fallback public base URL alias |
| `JWT_SECRET` | `<64+ random chars>` | Required for reporter portal session tokens |
| `REPORTER_PORTAL_JWT_EXPIRES_IN` | `24h` | Reporter portal session token lifetime |
| `OTP_ALLOW_ANY` | `0` (prod) / `1` (dev) | Gating: restrict OTP requests to founder email |
| `OTP_EMAIL_TIMEOUT_MS` | `5000` | Max wait before background send detaches |
| `OTP_DEV_ECHO` | `0` | When `1` echoes OTP in response (dev only) |
| `SMTP_POOL` | `true` | Enable connection pooling |
| `SMTP_MAX_CONN` | `3` | Pool size |
| `SMTP_DEBUG` | `false` | Set `true` for verbose Nodemailer logs |
| `EMAIL_PROVIDER` | `smtp` or `resend` | Optional explicit provider override; in production auto mode prefers Resend when configured |
| `RESEND_API_KEY` | `re_xxx` | Enables Resend when SMTP is absent or provider is forced to `resend` |
| `RESEND_FROM` | `NewsPulse <noreply@newspulse.co.in>` | Preferred Resend sender |
| `RESEND_REPLY_TO` | `support@newspulse.co.in` | Optional Resend reply-to |
| `EMAIL_PROVIDER_TIMEOUT_MS` | `10000` | Timeout used for SMTP connect/greeting/socket and Resend API requests |

Reporter OTP production overrides:
- Prefix any mailer variable with `REPORTER_OTP_` or `REPORTER_` to scope it only to the reporter portal OTP flow.
- Useful examples on Render: `REPORTER_OTP_EMAIL_PROVIDER=resend`, `REPORTER_OTP_RESEND_API_KEY=...`, `REPORTER_OTP_RESEND_FROM=NewsPulse Reporter <noreply@newspulse.co.in>`.
- Reporter OTP still falls back to the global/default mailer env when the scoped override is absent, so localhost and existing backend mail flows remain unchanged.

Gmail Setup:
1. Enable 2FA on the account.
2. Create an App Password (select Mail + Other). Use that as `SMTP_PASS`.
3. Use either explicit host/port (`smtp.gmail.com`, `465`, `SMTP_SECURE=true`) or set `SMTP_SERVICE=gmail`.
4. Set `EMAIL_FROM` (or `MAIL_FROM` / `FROM_EMAIL`) to include a friendly display name.

Testing Locally:
```bash
cp .env.example .env
node scripts/test-email.js --to=your-test@gmail.com
```
If you see `[EMAIL][transporter-ready]` followed by `[EMAIL][sent]` with your address in `accepted`, the configuration is working. If not:
- Check for missing vars printed by `[EMAIL][config-error]`.
- The visible sender header comes from `EMAIL_FROM`, `MAIL_FROM`, `FROM_EMAIL`, or `ADS_SMTP_FROM` (then falls back to the SMTP auth user). `SMTP_FROM` is envelope-only.
- With `SMTP_DEBUG=true` review low-level protocol logs.
- Confirm the Gmail App Password is correct and not revoked.

Reporter Portal production notes:
- Production-like environments now reject `EMAIL_MODE=stub`; real SMTP config is required.
- Reporter OTP now supports either SMTP or Resend. In production-like environments, Resend is preferred automatically when configured, with SMTP kept as fallback unless `EMAIL_PROVIDER=smtp` is set.
- Reporter OTP can use a dedicated provider on top of the global mailer by setting scoped env vars such as `REPORTER_OTP_EMAIL_PROVIDER`, `REPORTER_OTP_RESEND_API_KEY`, `REPORTER_OTP_RESEND_FROM`, `REPORTER_OTP_SMTP_HOST`, `REPORTER_OTP_SMTP_PORT`, `REPORTER_OTP_SMTP_USER`, and `REPORTER_OTP_SMTP_PASS`.
- `OTP_DEV_ECHO` is ignored in production-like environments, so the OTP is never echoed in live responses.
- For Render env changes, save the variables in the dashboard and redeploy the service. A restart/redeploy is required for Node to pick up new env values.
- Mailer failures now log and expose a safe `backendCode` such as `MAILER_NOT_CONFIGURED`, `SMTP_AUTH_FAILED`, `SMTP_CONNECT_FAILED`, `PROVIDER_TIMEOUT`, `RESEND_AUTH_FAILED`, `PROVIDER_UNAVAILABLE`, or `COOLDOWN_ACTIVE`.
- Use `GET /system/email-status` for both scopes, or `GET /system/email-status?scope=reporter-otp` / `GET /system/email-test?scope=reporter-otp`, to verify the reporter portal provider, secure mode, transport state, and backendCode on Render without exposing secrets.

Render Deployment:
- Add each SMTP/OTP variable in the Render dashboard (do NOT commit real secrets).
- Redeploy; use `GET /system/email-test` to confirm transporter status; then `POST /system/email-test/send` to send a probe message.

Deprecated Files:
`lib/emailService.js` and `lib/mailer.js` are retained for reference but the active OTP path now uses a stub sender in `lib/emailStub.js` which only logs the OTP (development/testing only).

### OTP Send Flow (Stub Sender)
1. User hits `POST /auth/otp/request` with `{ email }`.
2. Backend generates + stores hashed OTP (expires 10 min).
3. Stub `sendEmail({to,subject,text})` logs the OTP to console; no external delivery.
4. Success -> 200 `{ ok:true, success:true, message:"OTP (stub) logged for this email.", emailMasked: "ab***@domain" }`.
5. Failure (rare) -> 500 with `{ ok:false, success:false, message:"Failed to process OTP email stub." }`.

### OTP Request Response Examples
Endpoint: `POST /auth/otp/request` (also mounted at `/request`, `/auth/otp/request-reset`, `/admin-api/auth/otp/request` etc.)

Success (stub):
```json
{ "ok": true, "success": true, "message": "OTP (stub) logged for this email.", "emailMasked": "ne***@domain.com" }
```

Failure (stub exception):
```json
{ "ok": false, "success": false, "message": "Failed to process OTP email stub." }
```

Generic gating response (email not allowed by founder gating):
```json
{ "ok": true, "success": true, "message": "If this email is registered, an OTP has been sent." }
```

Logs emitted (stub mode):
- `[OTP_REQUEST][start]` request begins
- `[OTP_REQUEST][generated]` OTP stored
- `[EMAIL][stub-send]` OTP logged (contains extracted 6‑digit code)
- `[OTP_REQUEST][success]` final success response
- `[OTP_REQUEST][send-fail]` unexpected stub failure

Set `OTP_DEV_ECHO=1` locally ONLY to include `devCode` in the JSON response for quick testing.
