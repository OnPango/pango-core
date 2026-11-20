import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, Public, RequirePermissions } from '../auth/decorators.js';
import { SessionResponseDto } from '../auth/responses.js';
import { SessionCookies } from '../auth/session-cookies.js';
import {
  ApiPublic,
  ApiSession,
  requiresPermissions,
} from '../swagger/api-docs.js';
import { TenantResolver } from '../tenancy/tenant-resolver.service.js';
import { AcceptInvitationDto, CreateInvitationDto } from './dto.js';
import { InvitationsService } from './invitations.service.js';
import {
  InvitationDto,
  InvitationPreviewDto,
  PendingInvitationDto,
} from './responses.js';

@ApiTags('invitations')
@Controller('invitations')
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly tenantResolver: TenantResolver,
    private readonly cookies: SessionCookies,
  ) {}

  @Post()
  @RequirePermissions('user.manage')
  @ApiOperation({
    summary: 'Invite an email to the organization',
    description:
      'Emails a single-use link to join with the given role. Every role except Owner needs ' +
      '`warehouseId`; unless you are the Owner you need `user.manage` there and the role must be ' +
      'below yours there (fewer permissions, all of them yours, and not a role you hold). ' +
      'Only an Owner invites an Owner. Replaces any pending invitation for that email. ' +
      requiresPermissions('user.manage'),
  })
  @ApiCreatedResponse({ type: InvitationDto })
  @ApiSession({
    permissions: ['user.manage'],
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: [
        'ROLE_NOT_FOUND',
        'WAREHOUSE_NOT_FOUND',
        'ASSIGNMENT_SCOPE_INVALID',
      ],
      [HttpStatus.FORBIDDEN]: ['ROLE_NOT_BELOW_YOURS'],
      [HttpStatus.CONFLICT]: ['ALREADY_MEMBER'],
      [HttpStatus.BAD_GATEWAY]: ['MAIL_DELIVERY_FAILED'],
    },
  })
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateInvitationDto) {
    return this.invitations.create(auth, dto);
  }

  @Get()
  @RequirePermissions('user.read')
  @ApiOperation({
    summary: 'List pending invitations',
    description:
      'Not accepted and not revoked, including expired ones. The Owner sees all; anyone ' +
      `else, the ones for warehouses where they hold \`user.read\`. ${requiresPermissions('user.read')}`,
  })
  @ApiOkResponse({ type: [PendingInvitationDto] })
  @ApiSession({ permissions: ['user.read'] })
  list(@CurrentAuth() auth: AuthContext) {
    return this.invitations.listPending(auth);
  }

  @Delete(':id')
  @RequirePermissions('user.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke a pending invitation',
    description:
      'Needs `user.manage` on its warehouse (the Owner revokes any). ' +
      requiresPermissions('user.manage'),
  })
  @ApiParam({ name: 'id', type: Number, example: 1 })
  @ApiNoContentResponse({ description: 'Revoked' })
  @ApiSession({
    permissions: ['user.manage'],
    validation: true,
    errors: { [HttpStatus.NOT_FOUND]: ['INVITATION_NOT_FOUND'] },
  })
  revoke(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.invitations.revoke(auth, id);
  }

  @Public()
  @Get('preview')
  @ApiOperation({
    summary: 'Preview an invitation',
    description:
      'What the accept page shows before the invitee submits the form. Does not consume the token.',
  })
  @ApiQuery({
    name: 'token',
    description: 'Token from the `invitations/accept?token=` link',
  })
  @ApiOkResponse({ type: InvitationPreviewDto })
  @ApiPublic({
    validation: true,
    errors: { [HttpStatus.NOT_FOUND]: ['INVITATION_INVALID'] },
  })
  preview(@Query('token') token: string | undefined) {
    if (!token) throw new BadRequestException('token is required');
    return this.invitations.preview(token);
  }

  @Public()
  @Post('accept')
  @ApiOperation({
    summary: 'Accept an invitation and log in',
    description:
      "Call it on the invitation's organization. A new email needs `name` and a new password; " +
      'an existing account sends its current password. Accepting also confirms the email. ' +
      'Tokens are set as the HttpOnly cookies `pango_access_<subdomain>` and `pango_refresh_<subdomain>`.',
  })
  @ApiCreatedResponse({ type: SessionResponseDto })
  @ApiPublic({
    tenant: true,
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: ['TENANT_REQUIRED', 'NAME_REQUIRED'],
      [HttpStatus.UNAUTHORIZED]: ['INVALID_CREDENTIALS'],
      [HttpStatus.FORBIDDEN]: [
        'TENANT_MISMATCH',
        'ACCOUNT_DISABLED',
        'USER_DISABLED',
      ],
      [HttpStatus.NOT_FOUND]: ['INVITATION_INVALID'],
    },
  })
  async accept(
    @Req() request: Request,
    @Body() dto: AcceptInvitationDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const session = await this.invitations.accept(
      this.tenantResolver.resolve(request),
      dto,
    );
    return this.cookies.issue(response, session);
  }
}
