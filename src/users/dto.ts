import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export enum UserStatusFilter {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  ALL = 'ALL',
}

export class ListUsersQueryDto {
  @ApiPropertyOptional({
    example: 'carlos',
    maxLength: 150,
    description: 'Case-insensitive match on name or email',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(150)
  search?: string;

  @ApiPropertyOptional({
    enum: UserStatusFilter,
    enumName: 'UserStatusFilter',
    default: UserStatusFilter.ALL,
  })
  @IsOptional()
  @IsEnum(UserStatusFilter)
  status?: UserStatusFilter;

  @ApiPropertyOptional({
    example: 2,
    description: 'Only users holding this role (on any warehouse)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  roleId?: number;
}

export class UpdateUserDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Warehouse clerk',
    maxLength: 80,
    description: 'null or an empty string clears it',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  jobTitle?: string | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    example: 1,
    description: 'Department the user belongs to; null removes it',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  departmentId?: number | null;
}

export class RoleAssignmentInputDto {
  @ApiProperty({ example: 2 })
  @IsInt()
  @Min(1)
  roleId: number;

  @ApiPropertyOptional({
    example: 1,
    description: 'Warehouse the role applies to; omitted = every warehouse',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  warehouseId?: number;
}

export class SetUserRolesDto {
  @ApiProperty({
    type: [RoleAssignmentInputDto],
    description: 'Replaces every role assignment of the user',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RoleAssignmentInputDto)
  roles: RoleAssignmentInputDto[];
}
