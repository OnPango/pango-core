// Response shapes for Swagger. UsersService declares them as its return types,
// so the compiler flags drift between the documentation and the API.
import { ApiProperty } from '@nestjs/swagger';
import { WarehouseRefDto } from '../auth/responses.js';

export class DepartmentRefDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'Production' })
  name: string;
}

export class UserRoleDto {
  @ApiProperty({
    example: 8,
    description:
      'Role assignment id (`DELETE /users/:id/role-assignments/:assignmentId`)',
  })
  assignmentId: number;

  @ApiProperty({ example: 2, description: 'Role id' })
  id: number;

  @ApiProperty({ example: 'Operator' })
  name: string;

  @ApiProperty({
    example: false,
    description: 'System roles (Owner) apply to every warehouse',
  })
  isSystem: boolean;

  @ApiProperty({
    type: WarehouseRefDto,
    nullable: true,
    description: 'Warehouse the role applies to; null = every warehouse',
  })
  warehouse: WarehouseRefDto | null;
}

export class UserDto {
  @ApiProperty({ example: 3, description: 'Tenant user id' })
  id: number;

  @ApiProperty({ example: 7 })
  accountId: number;

  @ApiProperty({ example: 'carlos@miempresa.co' })
  email: string;

  @ApiProperty({ example: 'Carlos Gómez' })
  name: string;

  @ApiProperty({ type: String, nullable: true, example: 'Warehouse clerk' })
  jobTitle: string | null;

  @ApiProperty({ type: DepartmentRefDto, nullable: true })
  department: DepartmentRefDto | null;

  @ApiProperty({
    example: true,
    description: 'false = deactivated: cannot log in to this organization',
  })
  isActive: boolean;

  @ApiProperty({
    example: false,
    description: 'Holds the Owner role: administers every warehouse',
  })
  isOwner: boolean;

  @ApiProperty({ type: [UserRoleDto] })
  roles: UserRoleDto[];

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  joinedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}
