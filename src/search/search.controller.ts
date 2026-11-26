import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { ApiSession } from '../swagger/api-docs.js';
import { SearchQueryDto } from './dto.js';
import { SearchResultDto } from './responses.js';
import { SearchService } from './search.service.js';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @ApiOperation({
    summary: 'Search across modules',
    description:
      'The header search: a few products, categories, warehouses, open alerts ' +
      'and users matching `q`, each group with its total. A group the user ' +
      'cannot read comes back `null`; each group shows only what its own list ' +
      'endpoint would show.',
  })
  @ApiOkResponse({ type: SearchResultDto })
  @ApiSession({ validation: true })
  search(@CurrentAuth() auth: AuthContext, @Query() query: SearchQueryDto) {
    return this.searchService.search(auth, query);
  }
}
