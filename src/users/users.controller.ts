import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ApiSession, requiresPermissions } from '../swagger/api-docs.js';
import { ListUsersQueryDto, SetUserRolesDto, UpdateUserDto } from './dto.js';
import { UserDto } from './responses.js';
import { UsersService } from './users.service.js';

const idParam = ApiParam({
  name: 'id',
  type: Number,
  example: 3,
  description: 'Tenant user id',
});

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions('user.read')
  @ApiOperation({
    summary: "List the organization's users",
    description:
      'Sorted by name. Pending invitations are listed by `GET /invitations`. ' +
      requiresPermissions('user.read'),
  })
  @ApiOkResponse({ type: [UserDto] })
  @ApiSession({ permissions: ['user.read'], validation: true })
  list(@CurrentAuth() auth: AuthContext, @Query() query: ListUsersQueryDto) {
    return this.users.list(auth, query);
  }

  @Get(':id')
  @RequirePermissions('user.read')
  @ApiOperation({
    summary: 'Get a user',
    description: requiresPermissions('user.read'),
  })
  @idParam
  @ApiOkResponse({ type: UserDto })
  @ApiSession({
    permissions: ['user.read'],
    validation: true,
    errors: { [HttpStatus.NOT_FOUND]: ['USER_NOT_FOUND'] },
  })
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseIntPipe) id: number) {
    return this.users.get(auth, id);
  }

  @Patch(':id')
  @RequirePermissions('user.manage')
  @ApiOperation({
    summary: "Update a user's profile in the organization",
    description:
      'Job title and department. Name and email belong to the account (shared by every ' +
      'organization it joins) and cannot be changed here. Only administrators can change ' +
      `another administrator. ${requiresPermissions('user.manage')}`,
  })
  @idParam
  @ApiOkResponse({ type: UserDto })
  @ApiSession({
    permissions: ['user.manage'],
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: ['DEPARTMENT_NOT_FOUND'],
      [HttpStatus.NOT_FOUND]: ['USER_NOT_FOUND'],
    },
  })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
  ) {
    return this.users.update(auth, id, dto);
  }

  @Put(':id/roles')
  @RequirePermissions('user.manage')
  @ApiOperation({
    summary: "Replace a user's roles",
    description:
      'Each role applies to one warehouse or to all of them. Only administrators (a system ' +
      'role on every warehouse) can grant system roles or change another administrator. ' +
      'The organization must keep at least one active administrator. ' +
      requiresPermissions('user.manage'),
  })
  @idParam
  @ApiOkResponse({ type: UserDto })
  @ApiSession({
    permissions: ['user.manage'],
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: [
        'ROLE_NOT_FOUND',
        'WAREHOUSE_NOT_FOUND',
        'DUPLICATE_ROLE_ASSIGNMENT',
      ],
      [HttpStatus.NOT_FOUND]: ['USER_NOT_FOUND'],
      [HttpStatus.CONFLICT]: ['LAST_ADMIN'],
    },
  })
  setRoles(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetUserRolesDto,
  ) {
    return this.users.setRoles(auth, id, dto);
  }

  @Post(':id/deactivate')
  @RequirePermissions('user.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deactivate a user',
    description:
      'The user can no longer log in to this organization and their sessions end. Their ' +
      'history (movements, requests) is kept. Idempotent. You cannot deactivate yourself ' +
      'or the last active administrator. ' +
      requiresPermissions('user.manage'),
  })
  @idParam
  @ApiOkResponse({ type: UserDto })
  @ApiSession({
    permissions: ['user.manage'],
    validation: true,
    errors: {
      [HttpStatus.NOT_FOUND]: ['USER_NOT_FOUND'],
      [HttpStatus.CONFLICT]: ['SELF_DEACTIVATION', 'LAST_ADMIN'],
    },
  })
  deactivate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.users.deactivate(auth, id);
  }

  @Post(':id/activate')
  @RequirePermissions('user.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reactivate a user',
    description: `Idempotent. ${requiresPermissions('user.manage')}`,
  })
  @idParam
  @ApiOkResponse({ type: UserDto })
  @ApiSession({
    permissions: ['user.manage'],
    validation: true,
    errors: { [HttpStatus.NOT_FOUND]: ['USER_NOT_FOUND'] },
  })
  activate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.users.activate(auth, id);
  }
}
