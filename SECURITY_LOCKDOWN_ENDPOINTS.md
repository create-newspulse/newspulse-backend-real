# Security & Lockdown API Endpoints (Backend)

All endpoints return success wrapper:
```
{
  ok: true,
  success: true,
  status: 200,
  data: <payload>
}
```
Errors use:
```
{
  ok: false,
  success: false,
  status: <httpStatus>,
  message: 'Error message'
}
```
Auth: Requires either `Authorization: Bearer <token>` (placeholder accepted) or cookie `np_admin` (set by admin login). Otherwise 401.

## Threat Dashboard
GET `/api/dashboard/threat-stats`
Payload shape:
```
{
  suspiciousLogins24h: number,
  failedLogins24h: number,
  blockedIPs: number,
  firewallAlerts24h: number,
  lastUpdated: ISO string
}
```
Source: `routes/adminThreatRoutes.js`

## Smart Alerts Settings
GET `/api/alerts/settings`
PUT `/api/alerts/settings`
Payload shape:
```
{
  emailEnabled: boolean,
  dashboardAlertsEnabled: boolean,
  aiPriorityTaggingEnabled: boolean,
  escalationEnabled: boolean,
  lastUpdated: ISO string
}
```
Source: `routes/alerts.js`

## Escalation Rules
GET `/api/security/escalation-rules`
Payload shape:
```
{
  rules: [
    { id: string, name: string, severity: 'low'|'medium'|'high', enabled: boolean, match: object }
  ],
  lastUpdated: ISO string
}
```
Source: `routes/security.js`

## Incidents
GET `/api/security/incidents`
Payload shape:
```
{
  items: [
    { id, type, severity, status, detectedAt, resolvedAt?, summary }
  ],
  total: number,
  lastUpdated: ISO string
}
```
Source: `routes/security.js`

## Threat Scan
GET `/api/security/threat-scan`  (latest scan status)
POST `/api/security/threat-scan` (start new scan)
Payload shape:
```
{
  scanId: string|null,
  status: 'idle'|'running'|'complete',
  findings: [ { id, category, level, message } ],
  startedAt: ISO string|null,
  completedAt: ISO string|null
}
```
Source: `routes/security.js`

## Frontend Fetch Expectations
The admin panel `fetchJson` helper expects `{ ok: true, success: true, status: 200, data: ... }` for success; any deviation previously led to UI error banners. All new endpoints conform.

## Future Enhancements
- Replace in-memory stores with persistent database collections.
- Implement real scan workflow (async + polling).
- Add granular auth/roles and audit logging for configuration changes.
