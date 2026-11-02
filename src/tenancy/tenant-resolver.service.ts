import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { resolveSubdomain } from './subdomain.js';

// Finds the organization subdomain a request is addressed to (see `resolveSubdomain`).
@Injectable()
export class TenantResolver {
  private readonly baseDomain: string | undefined;

  constructor(config: ConfigService) {
    this.baseDomain = config.get<string>('APP_BASE_DOMAIN');
  }

  resolve(request: Request): string | null {
    return resolveSubdomain(request.headers, request.hostname, this.baseDomain);
  }
}
