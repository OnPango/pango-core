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

### Checking that the organization exists

Any subdomain serves the frontend (wildcard DNS), so on load the frontend calls `GET /organizations/current` (public, no session) before showing the login page:

| Case | Response |
|---|---|
| Active organization | `200 { "subdomain", "legalName" }` |
| No organization with that subdomain | `404 ORGANIZATION_NOT_FOUND` |
| Suspended or cancelled | `403 ORGANIZATION_INACTIVE` |
| No subdomain (main domain or a reserved name such as `www`) | `400 TENANT_REQUIRED` |

It returns only public data. It reveals whether a subdomain exists, as the login page already does.

## Isolation

- Each organization's data lives in its own schema; there is no shared tenant table to filter.
- `AuthGuard` (global) runs on every non-`@Public()` route. It:
  1. Verifies the access token.
  2. Rejects the request if the token's organization is not the one the request targets (`TENANT_MISMATCH`), so a token issued for one organization cannot read another one.
  3. Reloads the membership, account, organization and tenant user, so suspensions apply immediately.
  4. Sets `request.auth` (read with `@CurrentAuth()`), whose `organization.schemaName` is the only schema handlers may open with `TenantPrismaService.client()`.
- `@RequirePermissions('code', …)` requires every listed permission on at least one role assignment. `ORGANIZATION`-scope permissions then apply everywhere; handlers narrow `WAREHOUSE`-scope permissions to the warehouses that grant them (see *Roles and warehouse scope*).

## Flows

### Owner sign-up — `POST /auth/signup` (main domain)

Creates the account, the organization and its tenant schema in one transaction (see *Provisioning* in [`database.md`](../architecture/database.md)). If the email already has an account, the request must carry that account's password and the account becomes the owner of the new organization.

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

### Login — two steps (organization subdomain)

The password alone does not open a session: a six-digit code emailed to the account completes the login. After the code, the browser is trusted for a while and the next logins ask for the password only ([Trusted devices](#trusted-devices)).

#### 1. `POST /auth/login`

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

Every check passes before any email goes out. A [trusted browser](#trusted-devices) gets the session at once (`200`). Otherwise the API emails a code and answers `202` without a session:

```json
{
  "codeRequired": true,
  "email": "a**@miempresa.co",
  "codeLength": 6,
  "expiresAt": "2026-11-19T15:10:00.000Z",
  "resendAvailableAt": "2026-11-19T15:01:00.000Z",
  "emailSent": true,
  "trustedDeviceHours": 12,
  "rememberDeviceDays": 30
}
```

- The pending login lives in `public.login_challenges` and the client holds its token in the HttpOnly cookie `pango_login_<subdomain>` (path `/auth/login`). Typed on another browser, the code alone is useless.
- Only the SHA-256 of the token and an HMAC-SHA256 of the code are stored. The HMAC is keyed with `JWT_SECRET` and bound to the challenge, so a leaked table does not reveal the codes and a code never works for another login.
- Entering the password again within the resend cooldown keeps the code already sent (no new email), so repeating the login cannot flood the inbox. After the cooldown it starts over with a new code and the previous pending login stops working.
- `emailSent: false`: the email failed; `POST /auth/login/resend` retries.
- `LOGIN_EMAIL_CODE_ENABLED=false` turns the second step off: login answers `200` with the session, as before. Only for local development, scripts and end-to-end tests.

#### 2. `POST /auth/login/verify`

`{ "code": "482193", "rememberDevice": false }`, with the `pango_login_<subdomain>` cookie. The right code opens the session (the [session response](#session-response) and its cookies), clears the login cookie and trusts the browser ([Trusted devices](#trusted-devices); `rememberDevice: true` for longer). A code works once.

| Case | Error |
|---|---|
| No pending login, already used, or started in another organization | `401 LOGIN_CHALLENGE_INVALID`: log in again |
| Wrong code | `401 LOGIN_CODE_INVALID` with `attemptsLeft` |
| Last attempt failed (`LOGIN_CODE_MAX_ATTEMPTS`, default 5) | `401 LOGIN_CODE_ATTEMPTS_EXCEEDED`: the login ends, log in again |
| Code expired (`LOGIN_CODE_TTL_MINUTES`, default 10) | `401 LOGIN_CODE_EXPIRED`: request a new one |

The checks of the session (membership, suspension, …) run again when it opens. The login cookie is cleared with `LOGIN_CHALLENGE_INVALID` and `LOGIN_CODE_ATTEMPTS_EXCEEDED`.

#### Another code — `POST /auth/login/resend`

No body, with the `pango_login_<subdomain>` cookie. Emails a new code (the previous one stops working, the attempts start again) and answers `202` with the same body as the login. At most one per `LOGIN_CODE_RESEND_SECONDS` (default 60; `429 LOGIN_CODE_RESEND_TOO_SOON` with `retryAfterSeconds`) and `LOGIN_CODE_MAX_SENDS` per login (default 5, the first one included; then `429 LOGIN_CODE_RESEND_LIMIT` and the user logs in again).

#### Trusted devices

So that logging out by accident, or coming back the next day, does not ask for another code:

- The right code sets the HttpOnly cookie `pango_device_<subdomain>` (path `/auth/login`, so only the login reads it). While it lasts, `POST /auth/login` with the same account in the same organization answers `200` with the session after the password, without a code. The password and every other check of the table above still apply.
- It lasts `LOGIN_TRUSTED_DEVICE_HOURS` (default 12) after every code, or `LOGIN_REMEMBER_DEVICE_DAYS` (default 30) when the user asks to be remembered (`rememberDevice: true`). `LOGIN_TRUSTED_DEVICE_HOURS=0` asks for the code every time unless the user asks to be remembered. The login body tells the frontend both values (`trustedDeviceHours`, `rememberDeviceDays`).
- The cookie holds `<account>.<organization>.<expiry>.<signature>`, an HMAC-SHA256 keyed with `JWT_SECRET` over those values and the account's password hash. Nothing is stored: changing the password ends every trust of the account, and rotating `JWT_SECRET` ends them all. It cannot be stretched or moved to another account or organization.
- Logging out keeps the cookie (that is the point). Another account logging in on the same browser gets the code and, after it, replaces the cookie.

Signing up with an already verified account and accepting an invitation still open a session directly: the invitation email already proves the address. `POST /auth/refresh` keeps a session alive without the code.

### Session response

Returned by login, refresh, invitation acceptance and the sign-up of a verified account, together with the two session cookies (`GET /auth/me` returns the same without `expiresIn` / `refreshTokenExpiresAt`). The body never contains a token:

```json
{
  "expiresIn": 900,
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

### Tokens and cookies

The frontend never handles a token: both live in HttpOnly cookies set by the API.

| Cookie | Content | Path | Lifetime |
|---|---|---|---|
| `pango_access_<subdomain>` | Access token: HS256 JWT signed with `JWT_SECRET`; `sub` = account id, `org` = organization id | `/` | `JWT_ACCESS_TTL_SECONDS` (default 900) |
| `pango_refresh_<subdomain>` | Refresh token: random opaque string; only its SHA-256 is stored (`public.refresh_tokens`) | `/auth` (refresh and logout only) | `REFRESH_TOKEN_TTL_DAYS` (default 30) |

- Flags: `HttpOnly; SameSite=Lax`, `Secure` (`COOKIE_SECURE`, default on in production) and `Domain=COOKIE_DOMAIN` (`.onpango.com` in production; unset in development, so cookies are host-only).
- One pair per organization: with `Domain=.onpango.com` every subdomain receives every cookie, and sessions in two organizations must not overwrite each other. `AuthGuard` only reads the cookie of the request's organization.
- The frontend sends every request with credentials (`fetch(..., { credentials: 'include' })`); CORS allows credentials for origins under `APP_BASE_DOMAIN`. It schedules `POST /auth/refresh` before `expiresIn` runs out, and calls it on page load to restore the session.
- `Authorization: Bearer <access token>` is still accepted for non-browser clients (scripts, tests); the access cookie wins when both are present.
- `POST /auth/refresh` (no body) on the organization's subdomain reads the refresh cookie and rotates it: the old token is revoked and both cookies are replaced. On a rejected token both cookies are cleared.
- Presenting a refresh token that was already rotated or revoked is treated as theft and revokes every session of that account in the organization.
- `POST /auth/logout` (no body) revokes the refresh token and clears both cookies (`204`).

### CSRF

Cookie sessions are sent by the browser automatically, so cross-site request forgery is handled in two layers:

1. `SameSite=Lax`: browsers do not attach the cookies to cross-site POST/PUT/PATCH/DELETE requests or subresource loads. They are still sent on top-level GET navigations, so **GET routes must never change state**.
2. `CsrfGuard` (global, runs before `AuthGuard`): an unsafe request that carries a `pango_*` cookie must have an `Origin` under `APP_BASE_DOMAIN`; otherwise `403 CSRF_REJECTED`. This also covers other same-site hosts that `Lax` lets through. Requests without `Origin` (non-browser clients) pass.

### Invitations

| Endpoint | Access | Purpose |
|---|---|---|
| `POST /invitations` `{ email, roleId, warehouseId? }` | `user.manage` on the warehouse | Invite an email with a role on a warehouse (`warehouseId` required except for Owner). Same rules as granting a role (see below). Replaces any pending invitation for that email and sends the email. |
| `GET /invitations` | `user.read` | Pending invitations (including expired ones): all for the Owner, otherwise the ones for warehouses where you hold `user.read`. |
| `DELETE /invitations/:id` | `user.manage` on its warehouse | Revoke a pending invitation (the Owner revokes any). |
| `GET /invitations/preview?token=` | public | Organization, email and `hasAccount` for the accept page. |
| `POST /invitations/accept` `{ token, password, name? }` | public, on the organization's subdomain | Join and log in. New email: `name` + new password. Existing account: its current password. |

The email links to `WEB_APP_URL_TEMPLATE` (with `{subdomain}` replaced) + `/invitations/accept?token=…`. Invitations expire after `INVITATION_TTL_HOURS` (default 72) and can be used once. Only the token's SHA-256 is stored.

Accepting creates the account if needed, then the tenant user with the role (idempotent), then claims the invitation and activates the membership in one transaction, so a failed attempt can be retried.

### Roles and warehouse scope

Warehouses (storage warehouses and stores) are the unit of administration. A **role** groups permissions and is organization-wide; a **role assignment** grants it to a user on one warehouse. A user can hold several assignments (e.g. Admin on North, Operator on South).

- **Owner** (system role) is the only role assigned with no warehouse: it administers every warehouse, holds every permission and cannot be edited. Only an Owner grants it.
- Permissions have a scope (`GET /permissions`):
  - `ORGANIZATION` (catalog, creating warehouses, roles, settings, forecasts…): applies to the whole organization once any assignment grants it.
  - `WAREHOUSE` (users, stock, movements, requests, alerts…): applies only on the warehouse of the assignment. `user.read` / `user.manage` are warehouse-scoped, so an Admin manages the users of their warehouse.
- Seeded roles (all editable except Owner): `Owner`; `Admin` (`warehouse_scoped_roles` migration: every permission except `role.manage` and `settings.manage`); `Operator` (operations, no user or role administration).
- **Granting or removing a role** on a warehouse (assignments and invitations) needs `user.manage` on that warehouse, and the role must be **below the actor's level** there (`403 ROLE_NOT_BELOW_YOURS`): fewer permissions than the actor holds there, all of them held by the actor, and not a role the actor holds there. So an Admin grants Operator but not Admin (nor a role with the same permissions). The Owner grants any role. A non-system role needs a warehouse and Owner needs none (`400 ASSIGNMENT_SCOPE_INVALID`).

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /permissions` | `role.read` | Permission catalog with `scope`. |
| `GET /roles`, `GET /roles/:id` | `role.read` | Roles with their permissions and `assignmentCount`. |
| `POST /roles` `{ name, description?, permissions }` | `role.manage` | Create a role (it may register every movement type). |
| `PATCH /roles/:id` | `role.manage` | Rename it or replace its permissions; applies to its holders on their next request. |
| `DELETE /roles/:id` | `role.manage` | Only without assignments and pending invitations (`409 ROLE_IN_USE`). |

The Owner decides what each role can do. Anyone else given `role.manage` cannot edit a role they hold (`403 ROLE_HELD_BY_YOU`) nor give a role permissions they do not hold (`403 ROLE_EXCEEDS_YOUR_PERMISSIONS`). System roles cannot change (`409 ROLE_SYSTEM_LOCKED`).

### Users (CU-02)

The organization's users are tenant `users` rows joined with their `public.accounts` (name, email) and membership. Name and email belong to the account, which can be shared by several organizations, so they cannot be changed here. New users join through invitations (above).

The Owner sees and manages every user. Anyone else **sees** the users with an assignment on a warehouse where they hold `user.read` (plus themselves; others answer `404`), and **manages** (profile, deactivation) the ones whose every assignment is on a warehouse where they hold `user.manage` and is below their level there (`403 ROLE_NOT_BELOW_YOURS`), so an Admin does not manage another Admin. Only an Owner changes an Owner.

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /users?search=&status=&roleId=&warehouseId=` | `user.read` | Users sorted by name. `search` matches name or email; `status` is `ACTIVE`, `INACTIVE` or `ALL` (default). Each role in `roles` has its `assignmentId`. |
| `GET /users/:id` | `user.read` | One user. |
| `PATCH /users/:id` `{ jobTitle?, departmentId? }` | `user.manage` | Job title and department (`null` clears them). |
| `POST /users/:id/role-assignments` `{ roleId, warehouseId? }` | `user.manage` on the warehouse | Grant a role on a warehouse (`409 DUPLICATE_ROLE_ASSIGNMENT` if it already has it). |
| `DELETE /users/:id/role-assignments/:assignmentId` | `user.manage` on its warehouse | Remove one assignment. |
| `POST /users/:id/deactivate` | `user.manage` | Sets `users.is_active = false` and revokes the user's refresh tokens in the organization; the access token stops working on the next request because `AuthGuard` reloads the user. History is kept. Idempotent. |
| `POST /users/:id/activate` | `user.manage` | Reactivates the user. Idempotent. |

Rules:

- The organization always keeps at least one active Owner (`409 LAST_OWNER`). Removing assignments and deactivating lock the system roles (`SELECT … FOR UPDATE`) and check this inside the transaction, so concurrent requests cannot both remove the last one.
- Users cannot deactivate themselves (`409 SELF_DEACTIVATION`).

## Errors

Auth errors have the shape `{ "statusCode", "code", "message" }`; the frontend should branch on `code`. Validation errors keep Nest's default shape (`message` is an array).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | — (required, ≥ 32 chars) | Signs access tokens. |
| `JWT_ACCESS_TTL_SECONDS` | `900` | Access token lifetime. |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh token (and cookie) lifetime. |
| `COOKIE_SECURE` | `true` when `NODE_ENV=production`, else `false` | `Secure` flag of the session cookies (HTTPS only). |
| `COOKIE_DOMAIN` | — (host-only) | `Domain` of the session cookies; `.onpango.com` in production. |
| `INVITATION_TTL_HOURS` | `72` | Invitation lifetime. |
| `EMAIL_VERIFICATION_TTL_HOURS` | `24` | Email confirmation link lifetime. |
| `APP_BASE_DOMAIN` | — | Base domain of organization subdomains; also enables CORS (with credentials) for them and is the allowed origin of `CsrfGuard`. |
| `WEB_APP_URL_TEMPLATE` | `http://{subdomain}.localhost:5173` | Frontend URL used in invitation and confirmation links. |
| `RESEND_API_KEY` | — | Resend API key. Without it emails are only logged; required when `NODE_ENV=production`. |
| `MAIL_FROM` | `Pango <onboarding@resend.dev>` | Sender (must be a domain verified in Resend). |
| `TENANT_MIGRATIONS_DIR` | `prisma/tenant/migrations` | Tenant migrations applied when an organization signs up. |

## Not done yet

- Rate limiting of `login`, `signup`, `refresh`, `invitations/accept` and `organizations/current`.
- Password reset (`account_tokens` is ready for another purpose).
- Switching organizations from the UI.
- Audit log of user management actions (CU-15).
