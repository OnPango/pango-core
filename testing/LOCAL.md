# Local validation
Prerequisites: Docker Desktop running, Node 24, pnpm. Use a fresh PowerShell and the testing branch. Run:
```powershell
powershell -ExecutionPolicy Bypass -File testing/local-run.ps1
```
This uses a separate PostgreSQL container bound to loopback port 55432 and Core port 3300, overrides database and service credentials, provisions two new synthetic tenants, obtains real access tokens via login (email code disabled for this local process only), creates categories/products, checks isolation and runs the existing short-burst API benchmark. No frontend or Supabase required. No production writes. Reports: validation-results/api-check.json and local-isolation.json. Inspect and commit only these sanitized JSON reports; keep logs private. Stop database with docker compose -p pango-local-qa -f testing/local-db.yml down. Test data persists in its dedicated volume. No real prediction service is used in this run. This is local integration evidence, not deployed performance.
