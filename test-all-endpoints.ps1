# test-all-endpoints.ps1
# Comprehensive test for Public Site Settings API endpoints
# Usage: .\test-all-endpoints.ps1 [base_url]
# Example: .\test-all-endpoints.ps1 http://localhost:5000
# Example: .\test-all-endpoints.ps1 https://newspulse-backend.onrender.com

param(
    [string]$BaseUrl = "http://localhost:5000"
)

Write-Host "=== Testing Public Site Settings API ===" -ForegroundColor Cyan
Write-Host "Base URL: $BaseUrl`n" -ForegroundColor Gray

$passed = 0
$failed = 0

# Test 1: Public endpoint (no auth, should return 200)
Write-Host "1. GET /api/public/settings (no auth)" -ForegroundColor Yellow
try {
    $resp = Invoke-WebRequest -Uri "$BaseUrl/api/public/settings" -UseBasicParsing -ErrorAction Stop
    if ($resp.StatusCode -eq 200) {
        $json = $resp.Content | ConvertFrom-Json
        if ($json.ok -and $json.published) {
            Write-Host "   ✅ PASS: HTTP 200, has 'ok' and 'published'" -ForegroundColor Green
            $passed++
        } else {
            Write-Host "   ❌ FAIL: HTTP 200 but missing expected fields" -ForegroundColor Red
            $failed++
        }
    } else {
        Write-Host "   ❌ FAIL: HTTP $($resp.StatusCode) (expected 200)" -ForegroundColor Red
        $failed++
    }
} catch {
    Write-Host "   ❌ FAIL: $($_.Exception.Message)" -ForegroundColor Red
    $failed++
}

# Test 2: Admin endpoint (no auth, should return 401)
Write-Host "`n2. GET /api/admin/settings/public (no auth, expect 401)" -ForegroundColor Yellow
try {
    $resp = Invoke-WebRequest -Uri "$BaseUrl/api/admin/settings/public" -UseBasicParsing -ErrorAction Stop
    Write-Host "   ❌ FAIL: HTTP $($resp.StatusCode) (expected 401 without auth)" -ForegroundColor Red
    $failed++
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 401) {
        Write-Host "   ✅ PASS: HTTP 401 (route exists, auth required)" -ForegroundColor Green
        $passed++
    } else {
        Write-Host "   ❌ FAIL: HTTP $code (expected 401)" -ForegroundColor Red
        $failed++
    }
}

# Test 3: Admin draft endpoint (no auth, should return 401)
Write-Host "`n3. GET /api/admin/settings/public/draft (no auth, expect 401)" -ForegroundColor Yellow
try {
    $resp = Invoke-WebRequest -Uri "$BaseUrl/api/admin/settings/public/draft" -UseBasicParsing -ErrorAction Stop
    Write-Host "   ❌ FAIL: HTTP $($resp.StatusCode) (expected 401 without auth)" -ForegroundColor Red
    $failed++
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 401) {
        Write-Host "   ✅ PASS: HTTP 401 (route exists, auth required)" -ForegroundColor Green
        $passed++
    } else {
        Write-Host "   ❌ FAIL: HTTP $code (expected 401)" -ForegroundColor Red
        $failed++
    }
}

# Test 4: PUT draft (no auth, should return 401)
Write-Host "`n4. PUT /api/admin/settings/public/draft (no auth, expect 401)" -ForegroundColor Yellow
try {
    $body = @{ test = "value" } | ConvertTo-Json
    $resp = Invoke-WebRequest -Uri "$BaseUrl/api/admin/settings/public/draft" -Method PUT -Body $body -ContentType "application/json" -UseBasicParsing -ErrorAction Stop
    Write-Host "   ❌ FAIL: HTTP $($resp.StatusCode) (expected 401 without auth)" -ForegroundColor Red
    $failed++
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 401) {
        Write-Host "   ✅ PASS: HTTP 401 (route exists, auth required)" -ForegroundColor Green
        $passed++
    } else {
        Write-Host "   ❌ FAIL: HTTP $code (expected 401)" -ForegroundColor Red
        $failed++
    }
}

# Test 5: POST publish (no auth, should return 401)
Write-Host "`n5. POST /api/admin/settings/public/publish (no auth, expect 401)" -ForegroundColor Yellow
try {
    $resp = Invoke-WebRequest -Uri "$BaseUrl/api/admin/settings/public/publish" -Method POST -UseBasicParsing -ErrorAction Stop
    Write-Host "   ❌ FAIL: HTTP $($resp.StatusCode) (expected 401 without auth)" -ForegroundColor Red
    $failed++
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 401) {
        Write-Host "   ✅ PASS: HTTP 401 (route exists, auth required)" -ForegroundColor Green
        $passed++
    } else {
        Write-Host "   ❌ FAIL: HTTP $code (expected 401)" -ForegroundColor Red
        $failed++
    }
}

# Summary
Write-Host "`n=== Test Results ===" -ForegroundColor Cyan
Write-Host "Passed: $passed / 5" -ForegroundColor Green
Write-Host "Failed: $failed / 5" -ForegroundColor $(if ($failed -eq 0) { "Green" } else { "Red" })

if ($failed -eq 0) {
    Write-Host "`n✅ All tests passed! Routes are correctly implemented." -ForegroundColor Green
    exit 0
} else {
    Write-Host "`n❌ Some tests failed. Check the output above." -ForegroundColor Red
    exit 1
}
