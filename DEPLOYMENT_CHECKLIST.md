# Public Site Settings API - Deployment Checklist

## ✅ Implementation Status

All required routes have been implemented and tested locally:

### Routes Implemented

1. **GET /api/public/settings** - Public endpoint (no auth)
   - Returns published settings only
   - Status: ✅ Working (HTTP 200)

2. **GET /api/admin/settings/public** - Admin endpoint (auth required)
   - Returns both draft and published settings
   - Status: ✅ Working (HTTP 401 without token, 200 with token)

3. **GET /api/admin/settings/public/draft** - Admin draft endpoint (auth required)
   - Returns draft settings only
   - Status: ✅ Working (HTTP 401 without token, 200 with token)

4. **PUT /api/admin/settings/public/draft** - Update draft (auth required)
   - Saves draft settings
   - Status: ✅ Working (HTTP 401 without token, 200 with token)

5. **POST /api/admin/settings/public/publish** - Publish draft (auth required)
   - Copies draft to published
   - Status: ✅ Working (HTTP 401 without token, 200 with token)

### Files Created/Modified

- ✅ `models/PublicSiteSettings.js` - Mongoose model with draft/published fields
- ✅ `controllers/publicSiteSettingsController.js` - All endpoint handlers
- ✅ `routes/publicSettings.routes.js` - Public endpoint route
- ✅ `routes/adminPublicSettings.routes.js` - Admin endpoints routes
- ✅ `server.js` - Routes mounted at correct paths
- ✅ `middleware/adminAuth.js` - Returns 401 (not 404) for unauthorized requests
- ✅ `verify-endpoints.js` - Quick verification script
- ✅ `test-all-endpoints.ps1` - Comprehensive PowerShell test
- ✅ `README.md` - Updated with test commands and deployment steps

## 🔒 Authentication & CORS

### Auth Middleware
- ✅ Returns 401 for missing/invalid tokens (not 404)
- ✅ Routes exist and are accessible (confirmed via 401 responses)
- ✅ Public route accessible without auth

### CORS Configuration
Server allows these origins (via `CORS_ORIGIN` env var or hardcoded):
- ✅ `http://localhost:5173` (local dev)
- ✅ `https://admin.newspulse.co.in` (production admin)
- ✅ `https://newspulse.co.in` (production frontend)

## 🚀 Deployment to Render

### Pre-Deployment Checklist

1. **Environment Variables** (set in Render dashboard):
    - [ ] `MONGODB_URI` - MongoDB connection string
       - Dev should use DB name `newspulse_dev`
       - Production must use DB name `newspulse_prod`
   - [ ] `JWT_SECRET` - Token signing secret
   - [ ] `FOUNDER_EMAIL` - Admin email
   - [ ] `FOUNDER_PASSWORD` - Admin password
   - [ ] `CORS_ORIGIN` - Comma-separated allowed origins:
     ```
     http://localhost:5173,https://admin.newspulse.co.in,https://newspulse.co.in
     ```
   - [ ] `NODE_ENV` - Set to `production`

2. **Git Repository**:
   - [ ] All changes committed to main branch
   - [ ] Pushed to GitHub/GitLab
   - [ ] Render connected to correct repo and branch

3. **Render Settings**:
   - [ ] Build Command: `npm install`
   - [ ] Start Command: `npm start` (runs `node server.js`)
   - [ ] Root Directory: `.` (repo root)

### Deployment Steps

1. **Commit and push** all changes:
   ```bash
   git add .
   git commit -m "Add Public Site Settings API endpoints"
   git push origin main
   ```

2. **Render auto-deploy**: Wait for Render to detect the push and start deployment
   - Check Render dashboard for deployment status
   - Monitor logs for any errors

3. **Verify deployment**:
   ```bash
   # Replace <YOUR_DOMAIN> with actual Render URL
   curl https://<YOUR_DOMAIN>/api/public/settings
   curl https://<YOUR_DOMAIN>/api/admin/settings/public
   ```

4. **Run comprehensive test**:
   ```powershell
   .\test-all-endpoints.ps1 https://<YOUR_DOMAIN>
   ```

### Post-Deployment Verification

Expected results after successful deployment:

```bash
# Public endpoint - should return 200
curl https://<YOUR_DOMAIN>/api/public/settings
# Expected: {"ok":true,"published":{...}}

# Admin endpoint without token - should return 401
curl https://<YOUR_DOMAIN>/api/admin/settings/public
# Expected: {"ok":false,"success":false,"status":401,"code":"UNAUTHORIZED","message":"Unauthorized"}
```

✅ If both return expected status codes, deployment is successful!

## 🐛 Troubleshooting

### Issue: Routes return 404 on Render

**Possible causes:**
1. Routes not mounted in server.js
2. Files not committed/pushed to git
3. Render using wrong branch or old commit

**Solutions:**
1. Check Render logs for startup errors
2. Verify latest commit hash in Render matches GitHub
3. Trigger manual deploy from Render dashboard
4. Check server.js has these lines:
   ```javascript
   app.use('/api/public', publicSettingsRouter);
   app.use('/api/admin', adminPublicSettingsRouter);
   ```

### Issue: Admin endpoints return 404 (not 401)

**Possible causes:**
1. Routes not mounted before 404 handler
2. Middleware authentication not applied

**Solutions:**
1. Ensure routes mounted before `app.use('*', ...)` catch-all
2. Check middleware is imported and applied

### Issue: CORS errors in browser

**Possible causes:**
1. `CORS_ORIGIN` env var not set in Render
2. Admin domain not in allowlist

**Solutions:**
1. Set `CORS_ORIGIN` in Render dashboard environment variables
2. Include all required origins separated by commas

### Issue: 500 Internal Server Error

**Possible causes:**
1. MongoDB connection failed
2. Missing environment variables
3. Controller/model error

**Solutions:**
1. Check Render logs for error details
2. Verify `MONGODB_URI` is correct and points to `newspulse_prod`
3. Check model imports in controllers

## 📝 Testing Commands

### Local Testing
```powershell
# Quick test
node verify-endpoints.js

# Comprehensive test
.\test-all-endpoints.ps1
```

### Production Testing
```powershell
# Test all endpoints on Render
.\test-all-endpoints.ps1 https://newspulse-backend.onrender.com

# Manual cURL tests
curl https://newspulse-backend.onrender.com/api/public/settings
curl https://newspulse-backend.onrender.com/api/admin/settings/public
```

## 🎯 Success Criteria

All checkboxes must be ✅ for successful deployment:

- [x] Routes exist in codebase
- [x] Routes mounted in server.js
- [x] Auth middleware returns 401 (not 404)
- [x] Public route returns 200 without auth
- [x] Admin routes return 401 without auth
- [x] CORS configured for required domains
- [x] Local testing passes all 5 tests
- [ ] Deployed to Render
- [ ] Production testing passes all 5 tests
- [ ] Admin panel can connect to endpoints

## 📚 Next Steps

After deployment verification:

1. Test from admin panel UI
2. Verify draft/publish workflow
3. Check settings persistence in MongoDB
4. Monitor Render logs for any errors
5. Update frontend to use new endpoints
