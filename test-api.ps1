# Test script for Public Site Settings API endpoints
# Run with: .\test-api.ps1 or .\test-api.ps1 -AdminToken "your-token"

param(
    [string]$BaseUrl = "http://localhost:5000",
    [string]$AdminToken = $env:ADMIN_TOKEN
)

function Test-Endpoint {
    param(
        [string]$Method,
        [string]$Url,
        [string]$Token = $null,
        [object]$Body = $null
    )

    $headers = @{}
    if ($Token) {
        $headers["Authorization"] = "Bearer $Token"
    }
    $headers["Content-Type"] = "application/json"

    try {
        $params = @{
            Uri = $Url
            Method = $Method
            Headers = $headers
            UseBasicParsing = $true
        }

        if ($Body) {
            $params["Body"] = ($Body | ConvertTo-Json -Depth 10)
        }

        $response = Invoke-WebRequest @params
        return @{
            Success = $true
            Status = $response.StatusCode
            Data = ($response.Content | ConvertFrom-Json)
        }
    }
    catch {
        return @{
            Success = $false
            Status = $_.Exception.Response.StatusCode.value__
            Error = $_.Exception.Message
        }
    }
}

Write-Host "`n=== Public Site Settings API Tests ===" -ForegroundColor Cyan
Write-Host "Server: $BaseUrl"
Write-Host "Admin Token: $(if ($AdminToken) { '✓ Set' } else { '✗ Not set' })`n"

# Test 1: Public endpoint (no auth)
Write-Host "Test 1: GET /api/public/settings (no auth)" -ForegroundColor Yellow
$result = Test-Endpoint -Method "GET" -Url "$BaseUrl/api/public/settings"
if ($result.Success) {
    Write-Host "  ✓ Status: $($result.Status)" -ForegroundColor Green
    Write-Host "  ✓ Has published settings: $($null -ne $result.Data.published)" -ForegroundColor Green
    if ($result.Data.published) {
        Write-Host "  - Homepage modules: $($result.Data.published.homepage.modules.PSObject.Properties.Name -join ', ')" -ForegroundColor Gray
    }
}
else {
    Write-Host "  ✗ Failed: $($result.Error)" -ForegroundColor Red
}

if (-not $AdminToken) {
    Write-Host "`n⚠ Skipping admin endpoint tests - no admin token provided" -ForegroundColor Yellow
    Write-Host "  Run with -AdminToken parameter or set ADMIN_TOKEN env var`n"
    exit 0
}

# Test 2: Get both draft and published (admin)
Write-Host "`nTest 2: GET /api/admin/settings/public" -ForegroundColor Yellow
$result = Test-Endpoint -Method "GET" -Url "$BaseUrl/api/admin/settings/public" -Token $AdminToken
if ($result.Success) {
    Write-Host "  ✓ Status: $($result.Status)" -ForegroundColor Green
    Write-Host "  ✓ Has draft: $($null -ne $result.Data.draft)" -ForegroundColor Green
    Write-Host "  ✓ Has published: $($null -ne $result.Data.published)" -ForegroundColor Green
}
else {
    Write-Host "  ✗ Failed: Status $($result.Status) - $($result.Error)" -ForegroundColor Red
}

# Test 3: Get draft only (admin)
Write-Host "`nTest 3: GET /api/admin/settings/public/draft" -ForegroundColor Yellow
$result = Test-Endpoint -Method "GET" -Url "$BaseUrl/api/admin/settings/public/draft" -Token $AdminToken
if ($result.Success) {
    Write-Host "  ✓ Status: $($result.Status)" -ForegroundColor Green
    Write-Host "  ✓ Has draft: $($null -ne $result.Data.draft)" -ForegroundColor Green
}
else {
    Write-Host "  ✗ Failed: Status $($result.Status) - $($result.Error)" -ForegroundColor Red
}

# Test 4: Update draft (admin)
Write-Host "`nTest 4: PUT /api/admin/settings/public/draft" -ForegroundColor Yellow
$draftData = @{
    homepage = @{
        modules = @{
            categoryStrip = @{ enabled = $false; order = 1 }
            trendingStrip = @{ enabled = $true; order = 2 }
        }
    }
    tickers = @{
        breaking = @{
            enabled = $true
            speedSeconds = 45
            showWhenEmpty = $true
            mode = "demo"
        }
    }
}
$result = Test-Endpoint -Method "PUT" -Url "$BaseUrl/api/admin/settings/public/draft" -Token $AdminToken -Body $draftData
if ($result.Success) {
    Write-Host "  ✓ Status: $($result.Status)" -ForegroundColor Green
    Write-Host "  ✓ Message: $($result.Data.message)" -ForegroundColor Green
}
else {
    Write-Host "  ✗ Failed: Status $($result.Status) - $($result.Error)" -ForegroundColor Red
}

# Test 5: Publish draft (admin)
Write-Host "`nTest 5: POST /api/admin/settings/public/publish" -ForegroundColor Yellow
$result = Test-Endpoint -Method "POST" -Url "$BaseUrl/api/admin/settings/public/publish" -Token $AdminToken
if ($result.Success) {
    Write-Host "  ✓ Status: $($result.Status)" -ForegroundColor Green
    Write-Host "  ✓ Message: $($result.Data.message)" -ForegroundColor Green
}
else {
    Write-Host "  ✗ Failed: Status $($result.Status) - $($result.Error)" -ForegroundColor Red
}

# Test 6: Verify published settings changed
Write-Host "`nTest 6: Verify published settings updated" -ForegroundColor Yellow
$result = Test-Endpoint -Method "GET" -Url "$BaseUrl/api/public/settings"
if ($result.Success) {
    Write-Host "  ✓ Status: $($result.Status)" -ForegroundColor Green
    Write-Host "  - Category strip enabled: $($result.Data.published.homepage.modules.categoryStrip.enabled)" -ForegroundColor Gray
    Write-Host "  - Breaking ticker speed: $($result.Data.published.tickers.breaking.speedSeconds)s" -ForegroundColor Gray
    Write-Host "  - Breaking ticker mode: $($result.Data.published.tickers.breaking.mode)" -ForegroundColor Gray
}
else {
    Write-Host "  ✗ Failed: $($result.Error)" -ForegroundColor Red
}

Write-Host "`n=== Tests Complete ===" -ForegroundColor Cyan
Write-Host ""
