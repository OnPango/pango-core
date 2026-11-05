import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { ApiSession, requiresPermissions } from '../swagger/api-docs.js';
import { UnitOfMeasureDto } from './responses.js';

@ApiTags('units-of-measure')
@Controller('units-of-measure')
export class UnitsController {
  constructor(private readonly tenants: TenantPrismaService) {}

  @Get()
  @RequirePermissions('catalog.read')
  @ApiOperation({
    summary: 'List units of measure',
    description: `Sorted by code. ${requiresPermissions('catalog.read')}`,
  })
  @ApiOkResponse({ type: [UnitOfMeasureDto] })
  @ApiSession({ permissions: ['catalog.read'] })
  list(@CurrentAuth() auth: AuthContext): Promise<UnitOfMeasureDto[]> {
    return this.tenants
      .client(auth.organization.schemaName)
      .unitOfMeasure.findMany({ orderBy: { code: 'asc' } });
  }
}
