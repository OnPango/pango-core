import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
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
import { DepartmentsService } from './departments.service.js';
import {
  CreateDepartmentDto,
  ListDepartmentsQueryDto,
  UpdateDepartmentDto,
} from './dto.js';
import { DepartmentDto } from './responses.js';

const idParam = ApiParam({ name: 'id', type: Number, example: 1 });

@ApiTags('departments')
@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  @Get()
  @ApiOperation({
    summary: 'List departments',
    description: 'Sorted by name; `status` defaults to `ACTIVE`.',
  })
  @ApiOkResponse({ type: [DepartmentDto] })
  @ApiSession({ validation: true })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query() query: ListDepartmentsQueryDto,
  ) {
    return this.departments.list(auth, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a department' })
  @idParam
  @ApiOkResponse({ type: DepartmentDto })
  @ApiSession({
    validation: true,
    errors: { [HttpStatus.NOT_FOUND]: ['DEPARTMENT_NOT_FOUND'] },
  })
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseIntPipe) id: number) {
    return this.departments.get(auth, id);
  }

  @Post()
  @RequirePermissions('department.manage')
  @ApiOperation({
    summary: 'Create a department',
    description: requiresPermissions('department.manage'),
  })
  @ApiCreatedResponse({ type: DepartmentDto })
  @ApiSession({
    permissions: ['department.manage'],
    validation: true,
    errors: { [HttpStatus.CONFLICT]: ['DEPARTMENT_NAME_TAKEN'] },
  })
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateDepartmentDto) {
    return this.departments.create(auth, dto);
  }

  @Patch(':id')
  @RequirePermissions('department.manage')
  @ApiOperation({
    summary: 'Edit a department',
    description: `Rename it, change its cost center or deactivate it. ${requiresPermissions('department.manage')}`,
  })
  @idParam
  @ApiOkResponse({ type: DepartmentDto })
  @ApiSession({
    permissions: ['department.manage'],
    validation: true,
    errors: {
      [HttpStatus.NOT_FOUND]: ['DEPARTMENT_NOT_FOUND'],
      [HttpStatus.CONFLICT]: ['DEPARTMENT_NAME_TAKEN'],
    },
  })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDepartmentDto,
  ) {
    return this.departments.update(auth, id, dto);
  }
}
