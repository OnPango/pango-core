import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ApiSession, requiresPermissions } from '../swagger/api-docs.js';
import { CreateRoleDto, UpdateRoleDto } from './dto.js';
import { PermissionDto, RoleDto } from './responses.js';
import { RolesService } from './roles.service.js';

const idParam = ApiParam({ name: 'id', type: Number, example: 2 });

const ESCALATION_NOTE =
  'Only the Owner can edit a role they hold or give a role permissions they do not hold.';

@ApiTags('roles')
@Controller()
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get('permissions')
  @RequirePermissions('role.read')
  @ApiOperation({
    summary: 'List the permission catalog',
    description: `Fixed catalog that roles group. ${requiresPermissions('role.read')}`,
  })
  @ApiOkResponse({ type: [PermissionDto] })
  @ApiSession({ permissions: ['role.read'] })
  listPermissions(@CurrentAuth() auth: AuthContext) {
    return this.roles.listPermissions(auth);
  }

  @Get('roles')
  @RequirePermissions('role.read')
  @ApiOperation({
    summary: 'List roles',
    description: `System roles first, then by name. ${requiresPermissions('role.read')}`,
  })
  @ApiOkResponse({ type: [RoleDto] })
  @ApiSession({ permissions: ['role.read'] })
  list(@CurrentAuth() auth: AuthContext) {
    return this.roles.list(auth);
  }

  @Get('roles/:id')
  @RequirePermissions('role.read')
  @ApiOperation({
    summary: 'Get a role',
    description: requiresPermissions('role.read'),
  })
  @idParam
  @ApiOkResponse({ type: RoleDto })
  @ApiSession({
    permissions: ['role.read'],
    validation: true,
    errors: { [HttpStatus.NOT_FOUND]: ['ROLE_NOT_FOUND'] },
  })
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseIntPipe) id: number) {
    return this.roles.get(auth, id);
  }

  @Post('roles')
  @RequirePermissions('role.manage')
  @ApiOperation({
    summary: 'Create a role',
    description:
      'The new role may register every movement type. ' +
      `${ESCALATION_NOTE} ${requiresPermissions('role.manage')}`,
  })
  @ApiCreatedResponse({ type: RoleDto })
  @ApiSession({
    permissions: ['role.manage'],
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: ['PERMISSION_NOT_FOUND'],
      [HttpStatus.FORBIDDEN]: ['ROLE_EXCEEDS_YOUR_PERMISSIONS'],
      [HttpStatus.CONFLICT]: ['ROLE_NAME_TAKEN'],
    },
  })
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateRoleDto) {
    return this.roles.create(auth, dto);
  }

  @Patch('roles/:id')
  @RequirePermissions('role.manage')
  @ApiOperation({
    summary: 'Edit a role',
    description:
      '`permissions` replaces every permission of the role; the change applies to every ' +
      `user holding it on their next request. System roles cannot change. ${ESCALATION_NOTE} ` +
      requiresPermissions('role.manage'),
  })
  @idParam
  @ApiOkResponse({ type: RoleDto })
  @ApiSession({
    permissions: ['role.manage'],
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: ['PERMISSION_NOT_FOUND'],
      [HttpStatus.FORBIDDEN]: [
        'ROLE_EXCEEDS_YOUR_PERMISSIONS',
        'ROLE_HELD_BY_YOU',
      ],
      [HttpStatus.NOT_FOUND]: ['ROLE_NOT_FOUND'],
      [HttpStatus.CONFLICT]: ['ROLE_NAME_TAKEN', 'ROLE_SYSTEM_LOCKED'],
    },
  })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRoleDto,
  ) {
    return this.roles.update(auth, id, dto);
  }

  @Delete('roles/:id')
  @RequirePermissions('role.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a role',
    description:
      'Only roles with no assignments and no pending invitations. ' +
      requiresPermissions('role.manage'),
  })
  @idParam
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiSession({
    permissions: ['role.manage'],
    validation: true,
    errors: {
      [HttpStatus.FORBIDDEN]: ['ROLE_HELD_BY_YOU'],
      [HttpStatus.NOT_FOUND]: ['ROLE_NOT_FOUND'],
      [HttpStatus.CONFLICT]: ['ROLE_SYSTEM_LOCKED', 'ROLE_IN_USE'],
    },
  })
  remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.roles.remove(auth, id);
  }
}
