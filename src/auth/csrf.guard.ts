import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { isAllowedOrigin } from '../tenancy/origins.js';
import { apiError } from './auth-errors.js';
import { hasSessionCookie } from './session-cookies.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const csrfRejected = () =>
  apiError(
    HttpStatus.FORBIDDEN,
    'CSRF_REJECTED',
    'The request origin is not allowed',
  );

/**
 * CSRF defense for cookie sessions, on top of SameSite=Lax (which still lets
 * top-level GET navigations and other same-site subdomains through). An unsafe
 * request (POST, PUT, PATCH, DELETE) that carries a session cookie must come from
 * an origin under APP_BASE_DOMAIN. Requests with no Origin header (non-browser
 * clients) cannot be cross-site forgeries and pass. Runs before AuthGuard.
 * GET routes must never change state.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly baseDomain: string | undefined;

  constructor(config: ConfigService) {
    this.baseDomain = config.get<string>('APP_BASE_DOMAIN');
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method) || !hasSessionCookie(request)) {
      return true;
    }
    const origin = request.headers.origin;
    if (origin === undefined) return true;
    if (!this.baseDomain || !isAllowedOrigin(origin, this.baseDomain)) {
      throw csrfRejected();
    }
    return true;
  }
}
