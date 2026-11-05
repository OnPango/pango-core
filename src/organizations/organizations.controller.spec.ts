import type { HttpException } from '@nestjs/common';
import type { Request } from 'express';
import type { AccessService } from '../auth/access.service.js';
import { authErrors } from '../auth/auth-errors.js';
import type { TenantResolver } from '../tenancy/tenant-resolver.service.js';
import { OrganizationsController } from './organizations.controller.js';

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code: string }).code;
  }
  throw new Error('Expected the promise to reject');
}

function setup(subdomain: string | null) {
  const findActiveOrganization = vi.fn().mockResolvedValue({
    id: 3,
    subdomain: 'mi-empresa',
    legalName: 'Mi Empresa SAS',
    schemaName: 'tenant_mi_empresa',
    taxId: '900123456-7',
  });
  const controller = new OrganizationsController(
    { findActiveOrganization } as unknown as AccessService,
    { resolve: () => subdomain } as unknown as TenantResolver,
  );
  return { controller, findActiveOrganization };
}

const request = {} as Request;

describe('OrganizationsController.current', () => {
  it('returns only the public data of an active organization', async () => {
    const { controller, findActiveOrganization } = setup('mi-empresa');
    expect(await controller.current(request)).toEqual({
      subdomain: 'mi-empresa',
      legalName: 'Mi Empresa SAS',
    });
    expect(findActiveOrganization).toHaveBeenCalledWith('mi-empresa');
  });

  it('requires a subdomain', async () => {
    const { controller } = setup(null);
    expect(await errorCode(controller.current(request))).toBe(
      'TENANT_REQUIRED',
    );
  });

  it('passes on ORGANIZATION_NOT_FOUND and ORGANIZATION_INACTIVE', async () => {
    const { controller, findActiveOrganization } = setup('nope');
    findActiveOrganization.mockRejectedValueOnce(
      authErrors.organizationNotFound(),
    );
    expect(await errorCode(controller.current(request))).toBe(
      'ORGANIZATION_NOT_FOUND',
    );
    findActiveOrganization.mockRejectedValueOnce(
      authErrors.organizationInactive(),
    );
    expect(await errorCode(controller.current(request))).toBe(
      'ORGANIZATION_INACTIVE',
    );
  });
});
