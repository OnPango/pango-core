# Repository Guidelines

## Roles and Approval

Codex is the principal software architect. Read the relevant guides in `docs/` before proposing changes. Analyze requirements, risks, and dependencies. Maintain architecture decision records (ADRs) under `docs/`, define implementation tasks, and review changes. Codex's editing authority covers architecture and planning documentation under `docs/`. Feature implementation, source and test edits, and dependency additions belong to Claude, the senior developer.

Track proposals and tasks as `Proposed`, `Approved`, `Implemented`, or `Verified`. Only the human user can approve a proposal or task. Record their explicit confirmation.

## Task and Review Contracts

Every implementation task must specify its objective, scope, technical constraints, dependencies, acceptance criteria, validation requirements, and explicit out-of-scope items.

Claude provides an implementation report and validation evidence. Codex inspects the Git diff against each acceptance criterion, identifies bugs and architectural violations, reviews test execution evidence, cites files and lines, and recommends approval or rework. Report passing tests only with execution evidence. Follow the [architecture workflow](docs/architecture-workflow.md).

## Project Structure and Style

NestJS domains under `src/` group controllers, services, DTOs, and unit tests. Update Swagger decorators and the corresponding guide in `docs/` whenever API behavior changes. Read `docs/database.md` before changing the shared schema in `prisma/control/` or the per-organization schema in `prisma/tenant/`. Add migrations and preserve applied ones.

Write code and documentation in English. Reserve comments for complex, non-obvious logic. Use two spaces, single quotes, trailing commas, and `.js` extensions for relative imports. Use PascalCase classes and kebab-case filenames such as `stock-requests.service.ts`.

## Development and Testing

Use Node.js 24 and pnpm. Configure `.env` from `.env.example` as described in `README.md`.

- `pnpm install` installs dependencies. `pnpm build` generates both Prisma clients and compiles the API.
- `pnpm start:dev` starts watch mode. Swagger UI is available at `/docs`.
- `pnpm format` runs Prettier. `pnpm lint` runs type-aware Oxlint.
- `pnpm test` runs colocated Vitest `*.spec.ts` tests. `pnpm test:e2e` runs Supertest cases in `test/*.e2e-spec.ts`. `pnpm test:cov` reports coverage.

## Commits and Pull Requests

Use imperative subjects such as `feat: add product demand history endpoint`. Other prefixes include `fix:`, `docs:`, and `chore:`. Open pull requests from `feature/<name>` or `bugfix/<name>` against `dev`. Describe behavior changes, migrations, and validation results.
