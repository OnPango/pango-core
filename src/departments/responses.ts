import { ApiProperty } from '@nestjs/swagger';

export class DepartmentDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'Production' })
  name: string;

  @ApiProperty({ example: 'CC-200', type: String, nullable: true })
  costCenter: string | null;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({ example: 4, description: 'Users that belong to it' })
  userCount: number;
}
