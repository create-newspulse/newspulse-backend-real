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
