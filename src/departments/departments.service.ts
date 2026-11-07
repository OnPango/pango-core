import { HttpStatus, Injectable } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { apiError } from '../auth/auth-errors.js';
import type { Prisma } from '../generated/prisma/tenant/client.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import {
  type CreateDepartmentDto,
  type ListDepartmentsQueryDto,
  DepartmentStatusFilter,
  type UpdateDepartmentDto,
} from './dto.js';
import type { DepartmentDto } from './responses.js';

type Tx = Prisma.TransactionClient;

export const departmentErrors = {
  notFound: () =>
    apiError(
      HttpStatus.NOT_FOUND,
      'DEPARTMENT_NOT_FOUND',
      'Department not found',
    ),
  nameTaken: () =>
    apiError(
      HttpStatus.CONFLICT,
      'DEPARTMENT_NAME_TAKEN',
      'A department with this name already exists in the organization',
    ),
};

const departmentInclude = {
  _count: { select: { users: true } },
} satisfies Prisma.DepartmentInclude;

type DepartmentWithCount = Prisma.DepartmentGetPayload<{
  include: typeof departmentInclude;
}>;

function toDto(department: DepartmentWithCount): DepartmentDto {
  return {
    id: department.id,
    name: department.name,
    costCenter: department.costCenter,
    isActive: department.isActive,
    userCount: department._count.users,
  };
}

// Departments (areas, RN-015): they request stock (CU-08) and group users. Any
// session can read them; `department.manage` creates and edits them.
@Injectable()
export class DepartmentsService {
  constructor(private readonly tenants: TenantPrismaService) {}

  async list(
    auth: AuthContext,
    query: ListDepartmentsQueryDto,
  ): Promise<DepartmentDto[]> {
    const status = query.status ?? DepartmentStatusFilter.ACTIVE;
    const departments = await this.tenant(auth).department.findMany({
      where:
        status === DepartmentStatusFilter.ALL
          ? {}
          : { isActive: status === DepartmentStatusFilter.ACTIVE },
      include: departmentInclude,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return departments.map(toDto);
  }

  async get(auth: AuthContext, id: number): Promise<DepartmentDto> {
    const department = await this.tenant(auth).department.findUnique({
      where: { id },
      include: departmentInclude,
    });
    if (!department) throw departmentErrors.notFound();
    return toDto(department);
  }

  async create(
    auth: AuthContext,
    dto: CreateDepartmentDto,
  ): Promise<DepartmentDto> {
    const tenant = this.tenant(auth);
    await this.assertNameFree(tenant, dto.name);
    const department = await tenant.department.create({
      data: { name: dto.name, costCenter: dto.costCenter || null },
      include: departmentInclude,
    });
    return toDto(department);
  }

  async update(
    auth: AuthContext,
    id: number,
    dto: UpdateDepartmentDto,
  ): Promise<DepartmentDto> {
    const tenant = this.tenant(auth);
    const existing = await tenant.department.findUnique({ where: { id } });
    if (!existing) throw departmentErrors.notFound();
    if (dto.name !== undefined) await this.assertNameFree(tenant, dto.name, id);
    const department = await tenant.department.update({
      where: { id },
      data: {
        name: dto.name,
        costCenter:
          dto.costCenter === undefined ? undefined : dto.costCenter || null,
        isActive: dto.isActive,
      },
      include: departmentInclude,
    });
    return toDto(department);
  }

  private tenant(auth: AuthContext) {
    return this.tenants.client(auth.organization.schemaName);
  }

  private async assertNameFree(tenant: Tx, name: string, exceptId?: number) {
    const existing = await tenant.department.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId !== undefined && { id: { not: exceptId } }),
      },
      select: { id: true },
    });
    if (existing) throw departmentErrors.nameTaken();
  }
}
