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
  Delete,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ApiSession, requiresPermissions } from '../swagger/api-docs.js';
import {
  AddRoleAssignmentDto,
  ListUsersQueryDto,
  UpdateUserDto,
} from './dto.js';
import { UserDto } from './responses.js';
import { UsersService } from './users.service.js';

const idParam = ApiParam({
  name: 'id',
  type: Number,
  example: 3,
  description: 'Tenant user id',
});

const MANAGE_NOTE =
  'Unless you are the Owner, every role of the user must be on a warehouse where you hold ' +
  '`user.manage` and below yours there, so an Admin does not manage another Admin. ';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions('user.read')
  @ApiOperation({
    summary: "List the organization's users",
    description:
      'Sorted by name. The Owner sees every user; anyone else, the users with a role on a ' +
      'warehouse where they hold `user.read` (and themselves). Pending invitations are ' +
      `listed by \`GET /invitations\`. ${requiresPermissions('user.read')}`,
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
    description: `A user you cannot see answers \`404\`. ${requiresPermissions('user.read')}`,
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
      'organization it joins) and cannot be changed here. ' +
      MANAGE_NOTE +
      requiresPermissions('user.manage'),
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

  @Post(':id/role-assignments')
  @RequirePermissions('user.manage')
  @ApiOperation({
    summary: 'Grant a role to a user on a warehouse',
    description:
      'Every role except Owner needs `warehouseId`; Owner applies to every warehouse and ' +
      'only an Owner grants it. Otherwise you need `user.manage` on that warehouse and the ' +
      'role must be below yours there: fewer permissions, all of them yours, and not a role ' +
      `you hold (an Admin grants Operator, not Admin). ${requiresPermissions('user.manage')}`,
  })
  @idParam
  @ApiCreatedResponse({ type: UserDto })
  @ApiSession({
    permissions: ['user.manage'],
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: [
        'ROLE_NOT_FOUND',
        'WAREHOUSE_NOT_FOUND',
        'ASSIGNMENT_SCOPE_INVALID',
      ],
      [HttpStatus.FORBIDDEN]: ['ROLE_NOT_BELOW_YOURS'],
      [HttpStatus.NOT_FOUND]: ['USER_NOT_FOUND'],
      [HttpStatus.CONFLICT]: ['DUPLICATE_ROLE_ASSIGNMENT'],
    },
  })
  addAssignment(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddRoleAssignmentDto,
  ) {
    return this.users.addAssignment(auth, id, dto);
  }

  @Delete(':id/role-assignments/:assignmentId')
  @RequirePermissions('user.manage')
  @ApiOperation({
    summary: "Remove one of a user's role assignments",
    description:
      'Same rules as granting it. The organization must keep at least one active Owner. ' +
      requiresPermissions('user.manage'),
  })
  @idParam
  @ApiParam({ name: 'assignmentId', type: Number, example: 8 })
  @ApiOkResponse({ type: UserDto })
  @ApiSession({
    permissions: ['user.manage'],
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: ['ASSIGNMENT_SCOPE_INVALID'],
      [HttpStatus.FORBIDDEN]: ['ROLE_NOT_BELOW_YOURS'],
      [HttpStatus.NOT_FOUND]: ['USER_NOT_FOUND', 'ROLE_ASSIGNMENT_NOT_FOUND'],
      [HttpStatus.CONFLICT]: ['LAST_OWNER'],
    },
  })
  removeAssignment(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Param('assignmentId', ParseIntPipe) assignmentId: number,
  ) {
    return this.users.removeAssignment(auth, id, assignmentId);
  }

  @Post(':id/deactivate')
  @RequirePermissions('user.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deactivate a user',
    description:
      'The user can no longer log in to this organization and their sessions end. Their ' +
      'history (movements, requests) is kept. Idempotent. You cannot deactivate yourself ' +
      'or the last active Owner. ' +
      MANAGE_NOTE +
      requiresPermissions('user.manage'),
  })
  @idParam
  @ApiOkResponse({ type: UserDto })
  @ApiSession({
    permissions: ['user.manage'],
    validation: true,
    errors: {
      [HttpStatus.NOT_FOUND]: ['USER_NOT_FOUND'],
      [HttpStatus.CONFLICT]: ['SELF_DEACTIVATION', 'LAST_OWNER'],
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
    description: `Idempotent. ${MANAGE_NOTE}${requiresPermissions('user.manage')}`,
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
