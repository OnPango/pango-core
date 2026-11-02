import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { AuthContext, AuthenticatedRequest } from './auth-context.js';

export const IS_PUBLIC_KEY = 'auth:isPublic';
export const PERMISSIONS_KEY = 'auth:permissions';

/** Skips AuthGuard: the route needs no session. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Requires every listed permission code, granted on all warehouses (a role
 * assignment with no warehouse).
 */
export const RequirePermissions = (...codes: string[]) =>
  SetMetadata(PERMISSIONS_KEY, codes);

/** The verified session of the request. Only valid on non-public routes. */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.auth) {
      throw new Error('CurrentAuth used on a route without AuthGuard');
    }
    return request.auth;
  },
);
