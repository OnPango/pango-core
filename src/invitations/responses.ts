// Response shapes for Swagger. InvitationsService declares them as its return
// types, so the compiler flags drift between the documentation and the API.
import { ApiProperty } from '@nestjs/swagger';

export class RoleRefDto {
  @ApiProperty({ example: 2 })
  id: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Viewer',
    description: 'null if the role was deleted after the invitation',
  })
  name: string | null;
}

export class InviterDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'Ana Pérez' })
  name: string;
}

export class InvitationDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'carlos@miempresa.co' })
  email: string;

  @ApiProperty({ type: RoleRefDto })
  role: RoleRefDto;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: null,
    description: 'Warehouse the role applies to; null = every warehouse',
  })
  warehouseId: number | null;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export class PendingInvitationDto extends InvitationDto {
  @ApiProperty({ type: InviterDto })
  invitedBy: InviterDto;

  @ApiProperty({
    example: false,
    description: 'Past `expiresAt`; invite again to send a new link',
  })
  expired: boolean;
}

export class InvitationOrganizationDto {
  @ApiProperty({ example: 'mi-empresa' })
  subdomain: string;

  @ApiProperty({ example: 'Mi Empresa SAS' })
  legalName: string;
}

export class InvitationPreviewDto {
  @ApiProperty({ example: 'carlos@miempresa.co' })
  email: string;

  @ApiProperty({ type: InvitationOrganizationDto })
  organization: InvitationOrganizationDto;

  @ApiProperty({ example: 'Ana Pérez', description: "Inviter's name" })
  invitedBy: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;

  @ApiProperty({
    example: false,
    description:
      'False: the form must ask for `name` and a new password. True: the current password.',
  })
  hasAccount: boolean;
}
