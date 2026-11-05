// Response shapes for Swagger. RolesService declares them as its return types,
// so the compiler flags drift between the documentation and the API.
import { ApiProperty } from '@nestjs/swagger';
import { PermissionScope } from '../generated/prisma/tenant/enums.js';

export class PermissionDto {
  @ApiProperty({ example: 'product.manage' })
  code: string;

  @ApiProperty({ example: 'product' })
  module: string;

  @ApiProperty({
    enum: PermissionScope,
    enumName: 'PermissionScope',
    description:
      '`ORGANIZATION` applies to the whole organization once any assignment grants it; ' +
      '`WAREHOUSE` applies only to the warehouse of the assignment',
  })
  scope: PermissionScope;

  @ApiProperty({ example: 'Create and edit products' })
  description: string;
}

export class RoleDto {
  @ApiProperty({ example: 2 })
  id: number;

  @ApiProperty({ example: 'Admin' })
  name: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  description: string | null;

  @ApiProperty({
    example: false,
    description: 'System roles (Owner) cannot be edited or deleted',
  })
  isSystem: boolean;

  @ApiProperty({ type: [String], example: ['catalog.read', 'user.manage'] })
  permissions: string[];

  @ApiProperty({ example: 4, description: 'Role assignments using it' })
  assignmentCount: number;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}
