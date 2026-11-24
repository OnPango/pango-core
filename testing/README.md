# Validation
Use Node 24, pnpm and a local test environment. Never use production database credentials for E2E.
Run PowerShell: `powershell -ExecutionPolicy Bypass -File testing/run.ps1`.
Set RUN_E2E=1 only with a disposable database; existing E2E only tests root.
For read-only API checks use an authorized staging environment:
```powershell
$env:BASE_URL="http://localhost:3000"
$env:TENANT="test-a"
$env:TOKEN="your-test-access-token"
$env:TEST_AUTHORIZED="1"
node testing/api-check.mjs
```
Optional: OTHER_TENANT, OTHER_TOKEN, OTHER_PRODUCT_ID (known product of B) enable cross-tenant checks. Use distinct test organizations and valid tokens. Missing optional variables mean isolation not evaluated. The benchmark measures short bursts, not sustained capacity. Record environment, dataset size and deployment commit. Never commit tokens or raw private evidence. Save validation-results and coverage privately.
