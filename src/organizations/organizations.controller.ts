import { Controller, Get, HttpStatus, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AccessService } from '../auth/access.service.js';
import { authErrors } from '../auth/auth-errors.js';
import { Public } from '../auth/decorators.js';
import { ApiPublic } from '../swagger/api-docs.js';
import { TenantResolver } from '../tenancy/tenant-resolver.service.js';
import { PublicOrganizationDto } from './responses.js';

@ApiTags('organizations')
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly access: AccessService,
    private readonly tenantResolver: TenantResolver,
  ) {}

  @Public()
  @Get('current')
  @ApiOperation({
    summary: "Resolve the request's organization",
    description:
      'Needs no session. The frontend calls it when it loads on a subdomain, before ' +
      'showing the login page, to tell apart an organization that does not exist ' +
      '(`404 ORGANIZATION_NOT_FOUND`) or is suspended (`403 ORGANIZATION_INACTIVE`). ' +
      'Returns only public data.',
  })
  @ApiOkResponse({ type: PublicOrganizationDto })
  @ApiPublic({
    tenant: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: ['TENANT_REQUIRED'],
      [HttpStatus.FORBIDDEN]: ['ORGANIZATION_INACTIVE'],
      [HttpStatus.NOT_FOUND]: ['ORGANIZATION_NOT_FOUND'],
    },
  })
  async current(@Req() request: Request): Promise<PublicOrganizationDto> {
    const subdomain = this.tenantResolver.resolve(request);
    if (!subdomain) throw authErrors.tenantRequired();
    const organization = await this.access.findActiveOrganization(subdomain);
    return {
      subdomain: organization.subdomain,
      legalName: organization.legalName,
    };
  }
}
