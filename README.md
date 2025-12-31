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
Server will attempt to listen on `PORT` (default 10000) and auto-fallback up to 4 higher ports if occupied.

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
- `language` (new) — `en|hi|gu` (missing language in DB is treated as `en`)
- `q` (existing search)
- `page` (default 1), `limit` (default 30)

Examples:
```bash
curl "http://localhost:10000/api/public/news?category=national&language=en&limit=5"
curl "http://localhost:10000/api/public/news?category=national&language=hi&limit=5"
curl "http://localhost:10000/api/public/news?q=budget&language=en&limit=5"
```

Response shape (unchanged):
```json
{ "items": [], "page": 1, "limit": 30, "total": 0, "totalPages": 1 }
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

- If any credential is leaked (e.g., MongoDB Atlas `MONGO_URI`), immediately rotate the user/password in the provider (Atlas), then update `MONGO_URI` in deployment and local `.env`.
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
| `EMAIL_FROM` | `"NewsPulse Admin <newspulse.team@gmail.com>"` | Display name + sender |
| `SMTP_FROM` | `noreply@newspulse.co.in` | Optional envelope override |
| `OTP_ALLOW_ANY` | `0` (prod) / `1` (dev) | Gating: restrict OTP requests to founder email |
| `OTP_EMAIL_TIMEOUT_MS` | `5000` | Max wait before background send detaches |
| `OTP_DEV_ECHO` | `0` | When `1` echoes OTP in response (dev only) |
| `SMTP_POOL` | `true` | Enable connection pooling |
| `SMTP_MAX_CONN` | `3` | Pool size |
| `SMTP_DEBUG` | `false` | Set `true` for verbose Nodemailer logs |

Gmail Setup:
1. Enable 2FA on the account.
2. Create an App Password (select Mail + Other). Use that as `SMTP_PASS`.
3. Use either explicit host/port (`smtp.gmail.com`, `465`, `SMTP_SECURE=true`) or set `SMTP_SERVICE=gmail`.
4. Set `EMAIL_FROM` to include a friendly display name.

Testing Locally:
```bash
cp .env.example .env
node scripts/test-email.js --to=your-test@gmail.com
```
If you see `[EMAIL][transporter-ready]` followed by `[EMAIL][sent]` with your address in `accepted`, the configuration is working. If not:
- Check for missing vars printed by `[EMAIL][config-error]`.
- With `SMTP_DEBUG=true` review low-level protocol logs.
- Confirm the Gmail App Password is correct and not revoked.

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
