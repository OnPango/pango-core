# Pango — Authentication

Pango authenticates users itself (no external identity provider). The product is organization-first: nobody signs up as a lone user. An **owner** registers their account and organization together, and every other user joins through an **invitation** sent by email.

Code: `src/auth/` (sessions, guard), `src/invitations/`, `src/tenancy/` (subdomains, provisioning), `src/mail/` (Resend).

## Concepts

- **Account** (`public.accounts`): a login identity (email + Argon2id password). One account can belong to several organizations.
- **Membership** (`public.organization_members`): account ↔ organization. Only `ACTIVE` memberships grant access.
- **Tenant user** (`tenant_<slug>.users`): the account's profile inside the organization, with its role assignments.
- **Session**: always bound to **one** organization. Switching organizations means logging in on the other subdomain.

## Which organization a request targets

Every organization is served from its own subdomain (`mi-empresa.onpango.com`). The API resolves it, in order, from:

1. The `X-Tenant` header (the frontend sends it when the API lives on another host, e.g. `api.onpango.com`).
2. The host, when it is a direct subdomain of `APP_BASE_DOMAIN` (`mi-empresa.onpango.com` → `mi-empresa`). Reserved names (`www`, `api`, `app`, …) are never organizations.

## Isolation

- Each organization's data lives in its own schema; there is no shared tenant table to filter.
- `AuthGuard` (global) runs on every non-`@Public()` route. It:
  1. Verifies the access token.
  2. Rejects the request if the token's organization is not the one the request targets (`TENANT_MISMATCH`), so a token issued for one organization cannot read another one.
  3. Reloads the membership, account, organization and tenant user, so suspensions apply immediately.
  4. Sets `request.auth` (read with `@CurrentAuth()`), whose `organization.schemaName` is the only schema handlers may open with `TenantPrismaService.client()`.
- `@RequirePermissions('code', …)` requires every listed permission on a role assignment with no warehouse. Warehouse-scoped checks belong to the handlers that know the warehouse.

## Flows

### Owner sign-up — `POST /auth/signup` (main domain)

Creates the account, the organization and its tenant schema in one transaction (see *Provisioning* in [`database.md`](database.md)). If the email already has an account, the request must carry that account's password and the account becomes the owner of the new organization.

- **New account**: no session. A confirmation email is sent and the response is `201 { "verificationRequired": true, "email", "organization": { "subdomain" }, "verificationEmailSent" }`. Login answers `403 EMAIL_NOT_VERIFIED` until the email is confirmed.
- **Existing, verified account**: returns a session for the new organization.

### Email confirmation (owners)

- The email links to `WEB_APP_URL_TEMPLATE` (organization subdomain) + `/verify-email?token=…`. The frontend posts the token to `POST /auth/verify-email` `{ token }` → `200 { "email" }`, then sends the owner to login.
- Tokens live in `public.account_tokens` (`EMAIL_VERIFICATION`, SHA-256 only), expire after `EMAIL_VERIFICATION_TTL_HOURS` (default 24) and work once. Sending a new one invalidates the previous ones.
- `POST /auth/verify-email/resend` `{ email }` always answers `202` (it does not reveal whether the email exists) and sends at most one email per minute per account.
- Invited users do not need this step: accepting the invitation proves the address and marks it verified.

```json
{
  "name": "Ana Pérez",
  "email": "ana@miempresa.co",
  "password": "at-least-8-chars",
  "organization": {
    "legalName": "Mi Empresa SAS",
    "subdomain": "mi-empresa",
    "country": "CO",
    "city": "Medellín",
    "businessSector": "RETAIL",
    "teamSize": "SIZE_6_20",
    "productCount": "COUNT_101_500",
    "taxId": "900123456-7",
    "contactPhone": "+57 300 123 4567"
  }
}
```

### Login — `POST /auth/login` (organization subdomain)

`{ "email", "password" }`. Checks, in order:

| Check | Error |
|---|---|
| Subdomain present | `400 TENANT_REQUIRED` |
| Organization exists and is `ACTIVE` | `404 ORGANIZATION_NOT_FOUND` / `403 ORGANIZATION_INACTIVE` |
| Email and password are valid (same answer for an unknown email) | `401 INVALID_CREDENTIALS` |
| Email is confirmed | `403 EMAIL_NOT_VERIFIED` |
| Account is active | `403 ACCOUNT_DISABLED` |
| Account is a member of **this** organization | `403 NOT_A_MEMBER` ("This user does not belong to this organization") |
| Membership is not suspended | `403 MEMBERSHIP_SUSPENDED` |
| Tenant user is active | `403 USER_DISABLED` |

### Session response

Returned by login, refresh, invitation acceptance and the sign-up of a verified account (`GET /auth/me` returns the same without the tokens):

```json
{
  "tokenType": "Bearer",
  "accessToken": "<JWT>",
  "expiresIn": 900,
  "refreshToken": "<opaque>",
  "refreshTokenExpiresAt": "2026-11-30T12:00:00.000Z",
  "account": { "id": 1, "email": "ana@miempresa.co", "name": "Ana Pérez" },
  "organization": { "id": 3, "subdomain": "mi-empresa", "legalName": "Mi Empresa SAS" },
  "user": {
    "id": 1,
    "jobTitle": null,
    "roles": [
      {
        "id": 1,
        "name": "Owner",
        "isSystem": true,
        "warehouse": null,
        "permissions": ["role.manage", "role.read", "user.manage", "..."]
      }
    ]
  }
}
```

`warehouse: null` means the role applies to every warehouse.

### Tokens

- **Access token**: HS256 JWT signed with `JWT_SECRET`; `sub` = account id, `org` = organization id; lifetime `JWT_ACCESS_TTL_SECONDS` (default 900). Sent as `Authorization: Bearer <token>`.
- **Refresh token**: random opaque string; only its SHA-256 is stored (`public.refresh_tokens`); lifetime `REFRESH_TOKEN_TTL_DAYS` (default 30).
  - `POST /auth/refresh` `{ "refreshToken" }` on the organization's subdomain rotates it: the old token is revoked and a new session is returned.
  - Presenting a token that was already rotated or revoked is treated as theft and revokes every session of that account in the organization.
  - `POST /auth/logout` `{ "refreshToken" }` revokes it (`204`).

### Invitations

| Endpoint | Access | Purpose |
|---|---|---|
| `POST /invitations` `{ email, roleId, warehouseId? }` | `user.manage` | Invite an email with a tenant role, on one warehouse or all. Replaces any pending invitation for that email and sends the email. Only holders of a system role (Owner) on every warehouse can grant a system role. |
| `GET /invitations` | `user.read` | Pending invitations (including expired ones). |
| `DELETE /invitations/:id` | `user.manage` | Revoke a pending invitation. |
| `GET /invitations/preview?token=` | public | Organization, email and `hasAccount` for the accept page. |
| `POST /invitations/accept` `{ token, password, name? }` | public, on the organization's subdomain | Join and log in. New email: `name` + new password. Existing account: its current password. |

The email links to `WEB_APP_URL_TEMPLATE` (with `{subdomain}` replaced) + `/invitations/accept?token=…`. Invitations expire after `INVITATION_TTL_HOURS` (default 72) and can be used once. Only the token's SHA-256 is stored.

Accepting creates the account if needed, then the tenant user with the role (idempotent), then claims the invitation and activates the membership in one transaction, so a failed attempt can be retried.

## Errors

Auth errors have the shape `{ "statusCode", "code", "message" }`; the frontend should branch on `code`. Validation errors keep Nest's default shape (`message` is an array).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | — (required, ≥ 32 chars) | Signs access tokens. |
| `JWT_ACCESS_TTL_SECONDS` | `900` | Access token lifetime. |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh token lifetime. |
| `INVITATION_TTL_HOURS` | `72` | Invitation lifetime. |
| `EMAIL_VERIFICATION_TTL_HOURS` | `24` | Email confirmation link lifetime. |
| `APP_BASE_DOMAIN` | — | Base domain of organization subdomains; also enables CORS for them. |
| `WEB_APP_URL_TEMPLATE` | `http://{subdomain}.localhost:5173` | Frontend URL used in invitation and confirmation links. |
| `RESEND_API_KEY` | — | Resend API key. Without it emails are only logged; required when `NODE_ENV=production`. |
| `MAIL_FROM` | `Pango <onboarding@resend.dev>` | Sender (must be a domain verified in Resend). |
| `TENANT_MIGRATIONS_DIR` | `prisma/tenant/migrations` | Tenant migrations applied when an organization signs up. |

## Not done yet

- Rate limiting of `login`, `signup`, `refresh` and `invitations/accept`.
- Password reset (`account_tokens` is ready for another purpose).
- Managing members (suspend, change roles) and switching organizations from the UI.
