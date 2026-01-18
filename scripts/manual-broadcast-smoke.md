# Manual smoke: Broadcast (admin + public)

Assumes backend running on `http://localhost:3001` (adjust as needed).

## Admin login

### Legacy/simple admin cookie (dev)
Some admin endpoints accept a legacy cookie:

```bash
curl -i http://localhost:3001/api/admin/broadcast \
  -H "Cookie: np_admin=admin@newspulse.ai"
```

### POST login (token flow)
```bash
curl -i -X POST http://localhost:3001/admin-api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"your-password"}'
```

## Admin: add broadcast item (POST)

```bash
curl -i -X POST http://localhost:3001/admin-api/admin/broadcast/items \
  -H "Content-Type: application/json" \
  -H "Cookie: np_admin=admin@newspulse.ai" \
  -d '{"type":"breaking","lang":"en","text":"Test ticker","autoTranslate":true}'
```

## Admin: config (both tickers)

### GET config
```bash
curl -s http://localhost:3001/admin-api/admin/broadcast/config \
  -H "Cookie: np_admin=admin@newspulse.ai" | cat
```

### PUT config (replace both together)
```bash
curl -i -X PUT http://localhost:3001/admin-api/admin/broadcast/config \
  -H "Content-Type: application/json" \
  -H "Cookie: np_admin=admin@newspulse.ai" \
  -d '{
    "breaking": {"enabled": true, "mode":"auto", "durationSec": 18},
    "live": {"enabled": true, "mode":"auto", "durationSec": 20}
  }'
```

### PATCH one side (merge-safe)
```bash
curl -i -X PATCH http://localhost:3001/admin-api/admin/broadcast/config/breaking \
  -H "Content-Type: application/json" \
  -H "Cookie: np_admin=admin@newspulse.ai" \
  -d '{"durationSec": 22}'
```

Confirm `live` stays unchanged:
```bash
curl -s http://localhost:3001/admin-api/admin/broadcast/config \
  -H "Cookie: np_admin=admin@newspulse.ai" | cat
```

## Public: read config + items (no auth)

```bash
curl -i http://localhost:3001/public/broadcast/config
curl -i "http://localhost:3001/public/broadcast/items?type=breaking&lang=en"
```

## CORS/OPTIONS preflight (should be 204, never 405)

```bash
curl -i -X OPTIONS http://localhost:3001/admin-api/admin/broadcast/items \
  -H "Origin: https://admin.newspulse.co.in" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Content-Type, Authorization"

curl -i -X OPTIONS http://localhost:3001/admin-api/public/broadcast/config \
  -H "Origin: https://www.newspulse.co.in" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: Content-Type"
```
