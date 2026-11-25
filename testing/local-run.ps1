$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
# Run in a fresh PowerShell; all DB and external-service settings are overridden.
$env:DATABASE_URL = 'postgresql://pango_test:pango_test@127.0.0.1:55432/pango_test'
$env:DIRECT_URL = $env:DATABASE_URL
$env:JWT_SECRET = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
$env:NODE_ENV = 'development'
$env:PORT = '3300'
$env:APP_BASE_DOMAIN = 'localhost'
$env:WEB_APP_URL_TEMPLATE = 'http://{subdomain}.localhost:5173'
$env:COOKIE_SECURE = 'false'
$env:COOKIE_DOMAIN = ''
$env:LOGIN_EMAIL_CODE_ENABLED = 'false'
$env:RESEND_API_KEY = ''
$env:FORECAST_SERVICE_URL = 'http://127.0.0.1:1'
$env:FORECAST_SERVICE_TOKEN = 'local-unused'
$env:MAIL_FROM = 'Pango QA <qa@example.com>'
# Explicit values prevent dotenv loading external credentials from .env.
function Check($name) { if ($LASTEXITCODE -ne 0) { throw "$name failed" } }
docker compose -p pango-local-qa -f testing/local-db.yml up -d
Check 'Database startup'
$ready = $false
for ($i=0; $i -lt 60; $i++) {
    docker compose -p pango-local-qa -f testing/local-db.yml exec -T db pg_isready -U pango_test -d pango_test 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
}
if (-not $ready) { throw 'Database not ready' }
pnpm install --frozen-lockfile
Check 'Install'
pnpm prisma:generate
Check 'Prisma generation'
pnpm db:migrate:control
Check 'Local migrations'
pnpm build
Check 'Build'
New-Item -ItemType Directory -Force validation-results | Out-Null
if (Get-NetTCPConnection -LocalPort 3300 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 3300 is already in use' }
$api = Start-Process node -ArgumentList 'dist/main' -PassThru -RedirectStandardOutput validation-results/local-api.log -RedirectStandardError validation-results/local-api-error.log
try {
    $ready = $false
    for ($i=0; $i -lt 60; $i++) {
        if ($api.HasExited) { throw 'Core exited; inspect local-api-error.log' }
        try { $r = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3300/' -TimeoutSec 2; if ($r.StatusCode -eq 200) { $ready=$true; break } } catch {}
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Core did not start' }
    node testing/local-api.mjs
    Check 'API validation'
} finally {
    if (-not $api.HasExited) { Stop-Process -Id $api.Id }
}
