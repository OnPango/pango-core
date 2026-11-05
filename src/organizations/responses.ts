// Response shapes for Swagger, declared as the controller's return types so the
// documentation cannot drift from the API.
import { ApiProperty } from '@nestjs/swagger';

/** What anyone may learn about an organization from its subdomain. */
export class PublicOrganizationDto {
  @ApiProperty({ example: 'mi-empresa' })
  subdomain: string;

  @ApiProperty({ example: 'Mi Empresa SAS' })
  legalName: string;
}
