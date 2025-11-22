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
{ "ok": false, "success": false, "status": 404, "message": "Route not found", "path": "/missing" }
```

## Development Notes
- Socket.IO path: `/socket.io` (origins limited via CORS).
- Mongo connection retries every 30s if unreachable; server stays up.
- Avoid using the nested folder for new changes; all future changes belong at repo root.

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

Deprecated File:
`lib/emailService.js` is retained for reference but not used; all active email sending flows use `lib/mailer.js`.

### OTP Request Response Examples
Endpoint: `POST /auth/otp/request` (also mounted at `/request`, `/auth/otp/request-reset`, `/admin-api/auth/otp/request` etc.)

Success:
```json
{ "ok": true, "success": true, "message": "OTP sent to your email.", "emailMasked": "ne***@domain.com" }
```

Failure to send (SMTP rejected / config missing):
```json
{ "ok": false, "success": false, "message": "Could not send OTP email. Please try again or contact support." }
```

Generic gating response (email not allowed by founder gating):
```json
{ "ok": true, "success": true, "message": "If this email is registered, an OTP has been sent." }
```

Logs emitted:
- `[OTP_REQUEST][start]` when request begins (masked email, IP)
- `[OTP_REQUEST][generated]` OTP stored (masked email, expiry)
- `[OTP_REQUEST][sent]` accepted by SMTP (messageId, accepted array)
- `[OTP_REQUEST][send-error]` on send exception
- `[OTP_REQUEST][send-empty-accepted]` when SMTP returns no accepted recipients
- `[MAILER][startup]` if SMTP env missing at boot

Set `OTP_DEV_ECHO=1` locally ONLY to include `devCode` in the JSON response for quick testing.
