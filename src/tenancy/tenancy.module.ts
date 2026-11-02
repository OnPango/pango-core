import { Global, Module } from '@nestjs/common';
import { ProvisioningService } from './provisioning.service.js';
import { TenantResolver } from './tenant-resolver.service.js';

@Global()
@Module({
  providers: [ProvisioningService, TenantResolver],
  exports: [ProvisioningService, TenantResolver],
})
export class TenancyModule {}
