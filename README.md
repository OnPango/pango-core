# Pango Core

Pango Core is the NestJS backend for Pango, a multi-tenant inventory management
platform for small and medium-sized businesses (SMEs). It provides the API,
authentication, organization provisioning and tenant-isolated PostgreSQL data
model used by the Pango applications.

> This repository contains the core API only. The demand-forecasting service is
> a separate Python service and is not included here yet.

## Current capabilities

The `dev` branch currently provides:

- **Multi-tenant organizations** with one PostgreSQL schema per organization.
- **Account authentication** with email verification, password authentication,
  rotating refresh tokens, HttpOnly cookies and CSRF protection.
- **Organization onboarding** through owner sign-up and automatic tenant-schema
  provisioning.
- **Invitations** for adding users to an organization by email.
- **User administration** with profiles, activation/deactivation and role
  assignments.
- **Role-based permissions** with organization-wide and warehouse-scoped
  permissions.
- **Product catalog** with products, categories, units of measure, physical
  dimensions and lot-tracking configuration.
- **Warehouses and stores** with a default location created automatically.
- **Inventory movements**: inbound, outbound and adjustments, confirmed at once,
  with stock balances, lots and weighted average cost.
- **Replenishment**: safety stock and reorder point per product and warehouse,
  and stock alerts raised and resolved automatically.
- **Departments and internal stock requests**, with reservations, a status
  history and fulfilment through an outbound movement that feeds demand.
- **OpenAPI documentation** through Swagger UI.
- A database model prepared for suppliers, transfers, locations, forecasting
  and notifications.

Catalog, warehouse, movement, replenishment, alert, department and stock request
endpoints are implemented today (details in `docs/`). Transfers, drafts and
voiding of movements, location management, forecasting and notifications are
represented in the tenant schema but their API modules are still planned.

## Architecture

```text
Browser / frontend
        |
        v
Pango Core API (NestJS, port 3000)
        |
        +--> public schema: organizations, accounts, memberships, invitations,
        |                   refresh tokens and subscriptions
        |
        +--> tenant_<subdomain> schema: users, roles, catalog, warehouses,
        |                                stock, forecasts and notifications
        |
        v
Supabase PostgreSQL
```

Each organization is served from a subdomain such as
`mi-empresa.onpango.com`. The API resolves the tenant from that host or from
the `X-Tenant` header when the API and frontend use different hosts.

The `public` schema is the control plane. Every organization gets an isolated
`tenant_<subdomain>` schema, so tenant tables do not need an
`organization_id` column. The schema name is validated before it is used by
the application.

## Technology

- [NestJS 12](https://nestjs.com/)
- TypeScript 6 and ESM
- Prisma 7 with two generated clients
- PostgreSQL on Supabase
- `pg` and `@prisma/adapter-pg`
- Argon2id password hashing
- JWT access tokens and rotating opaque refresh tokens
- Resend for transactional email
- Swagger / OpenAPI
- Vitest, Supertest and Oxlint
- Node.js 24
- pnpm

## Repository structure

```text
.
├── docs/
│   ├── auth.md                 # Authentication and invitation flows
│   ├── catalog.md              # Product catalog API
│   ├── database.md             # Database design and migration workflow
│   └── warehouses.md           # Warehouse API
├── prisma/
│   ├── control/                # Public/control-plane schema and migrations
│   ├── tenant/                 # Tenant schema and migrations
│   ├── control.config.ts
│   └── tenant.config.ts
├── scripts/
│   └── tenants.ts              # Tenant creation and migration commands
├── src/
│   ├── auth/
│   ├── catalog/
│   ├── invitations/
│   ├── mail/
│   ├── prisma/
│   ├── swagger/
│   ├── tenancy/
│   ├── users/
│   └── warehouses/
├── test/                       # End-to-end tests
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## Requirements

- Node.js 24
- pnpm
- Git
- PostgreSQL compatible with Prisma (Supabase is the supported deployment
  target)
- Docker and Docker Compose, if running the containerized API

Enable pnpm through Corepack if it is not already available:

```bash
corepack enable
```

## Configuration

Create a local environment file:

```bash
cp .env.example .env
```

At minimum, configure:

| Variable | Required | Description |
|---|---:|---|
| `DATABASE_URL` | Yes | Supabase transaction-mode pooler URL for application queries |
| `DIRECT_URL` | Yes | Supabase session-mode pooler URL for migrations |
| `JWT_SECRET` | Yes | At least 32 characters; signs access tokens |
| `APP_BASE_DOMAIN` | Yes | Base domain used to resolve organization subdomains |
| `WEB_APP_URL_TEMPLATE` | Yes | Frontend URL template, for example `http://{subdomain}.localhost:5173` |
| `COOKIE_DOMAIN` | Production | Usually `.onpango.com`; leave empty for host-only local cookies |
| `RESEND_API_KEY` | Production | Resend API key; without it emails are logged only |
| `MAIL_FROM` | Production | Sender using a domain verified in Resend |

Important authentication defaults include 15-minute access tokens,
30-day refresh tokens, 72-hour invitations and 24-hour email-verification
links. See [`docs/auth.md`](docs/auth.md) for the complete configuration
reference.

## Local development

Install dependencies:

```bash
pnpm install
```

Generate both Prisma clients:

```bash
pnpm prisma:generate
```

Apply control-plane migrations:

```bash
pnpm db:migrate:control
```

Create an organization and its tenant schema:

```bash
pnpm tenant:create --subdomain demo \
  --tax-id 900000000-1 \
  --legal-name "Demo SME SAS" \
  --country CO \
  --city Bogota \
  --business-sector RETAIL \
  --team-size SIZE_1_5 \
  --product-count COUNT_1_100 \
  --email owner@demo.pango.local \
  --name "Demo Owner" \
  --password "change-me-123"
```

Apply pending migrations to every existing tenant:

```bash
pnpm tenant:migrate
```

Start the API in watch mode:

```bash
pnpm start:dev
```

The API listens on `http://localhost:3000` by default. The root endpoint
returns the basic application response, and Swagger is available at
`http://localhost:3000/docs`. The OpenAPI document is available at
`http://localhost:3000/docs-json`.

## Docker

Build and start the API:

```bash
docker compose up --build
```

The container exposes port `3000`. Database credentials and application
configuration still come from the environment; the Compose file does not run
a local PostgreSQL container.

## API overview

### Public and session endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/auth/signup` | Create an owner account and organization |
| `POST` | `/auth/verify-email` | Confirm an owner's email |
| `POST` | `/auth/verify-email/resend` | Request another confirmation email |
| `POST` | `/auth/login` | Start an organization session |
| `POST` | `/auth/refresh` | Rotate the refresh token |
| `POST` | `/auth/logout` | Revoke the session |
| `GET` | `/auth/me` | Read the current account, organization and permissions |
| `GET` | `/invitations/preview` | Preview an invitation without consuming it |
| `POST` | `/invitations/accept` | Accept an invitation and start a session |

Browser sessions use HttpOnly cookies named
`pango_access_<subdomain>` and `pango_refresh_<subdomain>`. Non-browser
clients may send the access token with the `Authorization` header. Tokens are
bound to the organization that issued them.

### Implemented modules

| Module | Main endpoints | Permissions |
|---|---|---|
| Users | `/users` | `user.read`, `user.manage` |
| Invitations | `/invitations` | `user.read`, `user.manage` |
| Products | `/products` | `catalog.read`, `product.manage` |
| Categories | `/categories` | `catalog.read`, `category.manage` |
| Units | `/units-of-measure` | `catalog.read` |
| Warehouses | `/warehouses` | `warehouse.read`, `warehouse.manage` |

Application errors use the shape
`{ "statusCode": number, "code": string, "message": string }`. Clients
should branch on the stable `code` value. Validation errors use Nest's
standard response format.

## Database and tenancy

Pango uses two independent Prisma configurations:

- `prisma/control.config.ts` targets the shared `public` schema.
- `prisma/tenant.config.ts` targets one `tenant_<subdomain>` schema at a time.

The control plane stores organizations, accounts, memberships, invitations,
refresh tokens and subscription records. Tenant schemas store users, roles,
permissions, catalog data, warehouses and the future inventory and forecasting
data model.

Tenant provisioning creates the schema, applies all tenant migrations, creates
the organization and adds the owner in a single workflow. New schema changes
must be added as migrations; already-applied migrations must not be edited.
Read [`docs/database.md`](docs/database.md) before changing either schema.

## Testing and quality checks

```bash
pnpm test                # Unit tests
pnpm test:e2e            # End-to-end tests
pnpm lint                # Type-aware Oxlint
pnpm build               # Generate Prisma clients and compile NestJS
pnpm format              # Format source and test files
```

Generated Prisma clients under `src/generated/` are not committed. Run
`pnpm prisma:generate` after schema changes or after a fresh checkout.

## Documentation

- [`docs/auth.md`](docs/auth.md): sessions, cookies, CSRF, email verification,
  invitations and user administration.
- [`docs/catalog.md`](docs/catalog.md): product and category behavior,
  validation rules and catalog endpoints.
- [`docs/warehouses.md`](docs/warehouses.md): warehouse types, permissions
  and default locations.
- [`docs/database.md`](docs/database.md): schemas, naming conventions,
  migrations, provisioning and data-model rules.

## Development workflow

- `main` is the production branch.
- `dev` is the integration branch.
- Use `feature/<name>`, `bugfix/<name>`, `release/<version>` or
  `hotfix/<version>` branches.
- Merge changes through pull requests; do not commit directly to `main` or
  `dev`.
- Use commit prefixes such as `feat:`, `fix:`, `docs:` and `chore:`.
- Never commit `.env`, credentials, secrets or raw datasets.

## Roadmap

The tenant schema already includes the foundation for the following planned
capabilities:

- Transfers between warehouses, draft movements and voiding with a reversing
  movement.
- Location hierarchies and product relocation.
- Suppliers and supplier-product relationships.
- Custom product attributes.
- Lead times and calculated reorder points by product and warehouse.
- Demand forecasting and forecast runs.
- In-app and email notifications.
- Audit logs for user, catalog and warehouse changes.
- Rate limiting for authentication and invitation flows.
- Password reset and organization switching in the frontend.

## License

This project is currently unlicensed (`UNLICENSED` in `package.json`).
