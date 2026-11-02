import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantResolver } from '../tenancy/tenant-resolver.service.js';
import { AccessService } from './access.service.js';
import {
  type AuthenticatedRequest,
  organizationWidePermissions,
} from './auth-context.js';
import { authErrors } from './auth-errors.js';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY } from './decorators.js';
import { type AccessClaims, TokenService } from './token.service.js';

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

// Global guard: every route needs a valid access token unless marked @Public().
// The token's organization must be the one the request is addressed to, and the
// membership is re-checked on every request so suspensions apply immediately.
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly access: AccessService,
    private readonly tenantResolver: TenantResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(request.headers.authorization);
    if (!token) throw authErrors.unauthenticated();

    let claims: AccessClaims;
    try {
      claims = await this.tokens.verifyAccessToken(token);
    } catch {
      throw authErrors.unauthenticated();
    }

    const subdomain = this.tenantResolver.resolve(request);
    if (!subdomain) throw authErrors.tenantRequired();

    const auth = await this.access.loadContext(
      claims.accountId,
      claims.organizationId,
    );
    if (auth.organization.subdomain !== subdomain) {
      throw authErrors.tenantMismatch();
    }

    const required =
      this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets) ??
      [];
    if (required.length > 0) {
      const granted = organizationWidePermissions(auth.user.roles);
      if (!required.every((code) => granted.has(code))) {
        throw authErrors.forbidden();
      }
    }

    request.auth = auth;
    return true;
  }
}
