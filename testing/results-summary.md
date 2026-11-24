# PANGO Core validation results

- Date: 2026-11-24
- Branch: `testing`
- Commit tested: `8937306a3c4b455ece0634135887a6787e4065ed`
- Environment: Windows PowerShell 5.1, Node.js 24.15.0, pnpm 10.33.2

## Validation

| Step | Result |
| --- | --- |
| Dependency installation | Passed |
| Prisma client generation | Passed |
| Unit tests with coverage | Passed: 29 files, 289 tests |
| Lint | Passed |
| Build | Passed |
| Root E2E | Not run (`RUN_E2E` was not enabled) |

The initial literal PowerShell invocation stopped when PowerShell 5.1 treated Prisma's informational stderr output as a terminating error. The same runner was then completed with a temporary `pnpm` wrapper that redirected stderr to stdout; no repository source files were changed to work around it.

## Coverage

| Module | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| All files | 81.56% | 72.34% | 77.31% | 83.45% |
| `src/auth` | 72.99% | 64.16% | 74.78% | 76.11% |
| `src/catalog` | 82.72% | 77.33% | 84.44% | 84.84% |
| `src/dashboard` | 80.31% | 63.84% | 72.28% | 80.71% |
| `src/demand` | 93.90% | 79.48% | 89.47% | 97.22% |
| `src/departments` | 73.68% | 45.83% | 76.92% | 73.52% |
| `src/forecasting` | 71.49% | 59.09% | 68.51% | 73.60% |
| `src/control/internal` | 86.04% | 100.00% | 25.00% | 86.04% |
| `src/tenant/internal` | 92.00% | 100.00% | 25.00% | 92.00% |
| `src/mail` | 27.02% | 11.11% | 25.00% | 27.02% |
| `src/movement-imports` | 93.77% | 86.16% | 90.52% | 95.19% |
| `src/movements` | 77.04% | 68.65% | 74.25% | 80.47% |
| `src/prisma` | 34.78% | 50.00% | 22.22% | 36.36% |
| `src/replenishment` | 91.37% | 82.41% | 83.63% | 94.05% |
| `src/roles` | 85.71% | 71.42% | 88.88% | 87.23% |
| `src/search` | 92.85% | 82.35% | 83.33% | 92.30% |
| `src/stock` | 92.39% | 73.77% | 89.65% | 94.04% |
| `src/stock-requests` | 89.57% | 76.19% | 81.25% | 91.75% |
| `src/swagger` | 57.50% | 29.72% | 55.55% | 59.45% |
| `src/tenancy` | 35.06% | 60.00% | 20.00% | 33.33% |
| `src/users` | 82.73% | 74.44% | 80.48% | 88.43% |
| `src/warehouses` | 83.49% | 74.32% | 95.00% | 86.66% |

The test output included mocked `Resend is down` and HTTP 503 scenarios; they were logged during passing tests and did not fail the suite. A Vite `vite-tsconfig-paths` advisory was also printed.

This sanitized summary excludes raw logs, generated coverage files, credentials, and host-specific paths. Raw validation logs and coverage artifacts remain local and untracked.
