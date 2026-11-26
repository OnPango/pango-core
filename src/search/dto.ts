import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_DEFAULT_LIMIT = 5;

export class SearchQueryDto {
  @ApiProperty({
    example: 'torn',
    minLength: SEARCH_MIN_LENGTH,
    maxLength: 100,
    description: 'Case-insensitive text matched against every group',
  })
  @Transform(trim)
  @IsString()
  @MinLength(SEARCH_MIN_LENGTH)
  @MaxLength(100)
  q: string;

  @ApiPropertyOptional({
    example: SEARCH_DEFAULT_LIMIT,
    default: SEARCH_DEFAULT_LIMIT,
    minimum: 1,
    maximum: 10,
    description: 'Most results per group; `total` still counts every match',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  limit?: number;
}
