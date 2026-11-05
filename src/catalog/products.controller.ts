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
import {
  CreateProductDto,
  ListProductsQueryDto,
  UpdateProductDto,
} from './dto.js';
import { ProductsService } from './products.service.js';
import { ProductDetailDto, ProductDto, ProductPageDto } from './responses.js';

const idParam = ApiParam({ name: 'id', type: Number, example: 1 });

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @RequirePermissions('catalog.read')
  @ApiOperation({
    summary: 'Search the product catalog',
    description:
      'Paginated, sorted by name. `search` matches code or name; `categoryId` includes ' +
      `its subcategories; \`status\` defaults to \`ACTIVE\`. ${requiresPermissions('catalog.read')}`,
  })
  @ApiOkResponse({ type: ProductPageDto })
  @ApiSession({ permissions: ['catalog.read'], validation: true })
  list(@CurrentAuth() auth: AuthContext, @Query() query: ListProductsQueryDto) {
    return this.products.list(auth, query);
  }

  @Get(':id')
  @RequirePermissions('catalog.read')
  @ApiOperation({
    summary: 'Get a product',
    description:
      'With its on-hand stock and replenishment parameters per warehouse. ' +
      requiresPermissions('catalog.read'),
  })
  @idParam
  @ApiOkResponse({ type: ProductDetailDto })
  @ApiSession({
    permissions: ['catalog.read'],
    validation: true,
    errors: { [HttpStatus.NOT_FOUND]: ['PRODUCT_NOT_FOUND'] },
  })
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseIntPipe) id: number) {
    return this.products.get(auth, id);
  }

  @Post()
  @RequirePermissions('product.manage')
  @ApiOperation({
    summary: 'Register a product',
    description:
      'Starts with no stock. The code is unique in the organization (case-insensitive). ' +
      requiresPermissions('product.manage'),
  })
  @ApiCreatedResponse({ type: ProductDto })
  @ApiSession({
    permissions: ['product.manage'],
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: ['CATEGORY_INVALID', 'UNIT_OF_MEASURE_INVALID'],
      [HttpStatus.CONFLICT]: ['SKU_TAKEN'],
    },
  })
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateProductDto) {
    return this.products.create(auth, dto);
  }

  @Patch(':id')
  @RequirePermissions('product.manage')
  @ApiOperation({
    summary: 'Edit a product',
    description:
      'Same validations as creating. The code and lot tracking cannot change once the ' +
      'product has movements. `isActive: false` retires it (products are never deleted). ' +
      requiresPermissions('product.manage'),
  })
  @idParam
  @ApiOkResponse({ type: ProductDto })
  @ApiSession({
    permissions: ['product.manage'],
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: ['CATEGORY_INVALID', 'UNIT_OF_MEASURE_INVALID'],
      [HttpStatus.NOT_FOUND]: ['PRODUCT_NOT_FOUND'],
      [HttpStatus.CONFLICT]: ['SKU_TAKEN', 'SKU_LOCKED', 'TRACKS_LOTS_LOCKED'],
    },
  })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProductDto,
  ) {
    return this.products.update(auth, id, dto);
  }
}
