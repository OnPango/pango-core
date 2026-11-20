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
import { CategoriesService } from './categories.service.js';
import {
  CreateCategoryDto,
  ListCategoriesQueryDto,
  UpdateCategoryDto,
} from './dto.js';
import { CategoryDto } from './responses.js';

const idParam = ApiParam({ name: 'id', type: Number, example: 3 });

@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @RequirePermissions('catalog.read')
  @ApiOperation({
    summary: 'List product families (categories)',
    description:
      'Flat list sorted by name; build the tree with `parentId`. ' +
      requiresPermissions('catalog.read'),
  })
  @ApiOkResponse({ type: [CategoryDto] })
  @ApiSession({ permissions: ['catalog.read'], validation: true })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query() query: ListCategoriesQueryDto,
  ) {
    return this.categories.list(auth, query);
  }

  @Get(':id')
  @RequirePermissions('catalog.read')
  @ApiOperation({
    summary: 'Get a category',
    description: requiresPermissions('catalog.read'),
  })
  @idParam
  @ApiOkResponse({ type: CategoryDto })
  @ApiSession({
    permissions: ['catalog.read'],
    validation: true,
    errors: { [HttpStatus.NOT_FOUND]: ['CATEGORY_NOT_FOUND'] },
  })
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseIntPipe) id: number) {
    return this.categories.get(auth, id);
  }

  @Post()
  @RequirePermissions('category.manage')
  @ApiOperation({
    summary: 'Create a category',
    description: requiresPermissions('category.manage'),
  })
  @ApiCreatedResponse({ type: CategoryDto })
  @ApiSession({
    permissions: ['category.manage'],
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: ['CATEGORY_PARENT_INVALID'],
      [HttpStatus.CONFLICT]: ['CATEGORY_NAME_TAKEN'],
    },
  })
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateCategoryDto) {
    return this.categories.create(auth, dto);
  }

  @Patch(':id')
  @RequirePermissions('category.manage')
  @ApiOperation({
    summary: 'Rename, move or (de)activate a category',
    description:
      '`parentId: null` moves it to the top level. Deactivating requires its subcategories ' +
      'to be inactive; its products keep it, but new products cannot use it. ' +
      requiresPermissions('category.manage'),
  })
  @idParam
  @ApiOkResponse({ type: CategoryDto })
  @ApiSession({
    permissions: ['category.manage'],
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: ['CATEGORY_PARENT_INVALID', 'CATEGORY_CYCLE'],
      [HttpStatus.NOT_FOUND]: ['CATEGORY_NOT_FOUND'],
      [HttpStatus.CONFLICT]: [
        'CATEGORY_NAME_TAKEN',
        'CATEGORY_HAS_ACTIVE_CHILDREN',
      ],
    },
  })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.categories.update(auth, id, dto);
  }
}
