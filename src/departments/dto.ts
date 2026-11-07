import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export enum DepartmentStatusFilter {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  ALL = 'ALL',
}

export class ListDepartmentsQueryDto {
  @ApiPropertyOptional({
    enum: DepartmentStatusFilter,
    enumName: 'DepartmentStatusFilter',
    default: DepartmentStatusFilter.ACTIVE,
  })
  @IsOptional()
  @IsEnum(DepartmentStatusFilter)
  status?: DepartmentStatusFilter;
}

export class CreateDepartmentDto {
  @ApiProperty({
    example: 'Production',
    maxLength: 80,
    description: 'Unique in the organization (case-insensitive)',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({
    example: 'CC-200',
    maxLength: 30,
    nullable: true,
    description: 'Omitted or null = none',
  })
  @IsOptional()
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(30)
  costCenter?: string | null;
}

export class UpdateDepartmentDto extends PartialType(CreateDepartmentDto) {
  @ApiPropertyOptional({
    example: true,
    description: 'Inactive departments cannot request stock or receive users',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
