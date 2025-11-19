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
| MONGO_URI | MongoDB connection string | Leave blank to run in limited mode |
| FOUNDER_EMAIL | Admin login email | Required for /admin/login success |
| FOUNDER_PASSWORD | Admin login password | Required for /admin/login success |
| FOUNDER_NAME | Display name for user | Defaults to `Founder` |
| FOUNDER_ID | Stable user id | Defaults to `founder-1` |
| JWT_SECRET | Token signing secret | Change in production |

## Auth Endpoints
### POST /admin/login
Body:
```json
{ "email": "<FOUNDER_EMAIL>", "password": "<FOUNDER_PASSWORD>" }
```
Success:
```json
{
  "success": true,
  "token": "<JWT>",
  "user": { "id": "founder-1", "email": "founder@example.com", "name": "Site Founder", "role": "founder" }
}
```
Failure: `401 { success: false, user: null, message: "Invalid credentials" }`
Rate limiting: 20 attempts per 15 minutes per IP (429 if exceeded).

### GET /admin-auth/session
Requires `Authorization: Bearer <JWT>` header.
Responses:
```json
{ "success": true, "user": { "id": "founder-1", "email": "...", "name": "...", "role": "founder" } }
{ "success": false, "user": null }
```

### GET /system/ai-training-info
Returns a stub:
```json
{ "success": true, "status": "online", "lastUpdated": "2025-11-20T00:00:00.000Z" }
```

### GET /admin/health
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
