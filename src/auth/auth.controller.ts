import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { ApiPublic, ApiSession } from '../swagger/api-docs.js';
import { TenantResolver } from '../tenancy/tenant-resolver.service.js';
import { type AuthContext, toSessionProfile } from './auth-context.js';
import { AuthService } from './auth.service.js';
import { CurrentAuth, Public } from './decorators.js';
import {
  LoginDto,
  RefreshTokenDto,
  ResendVerificationDto,
  SignupDto,
  VerifyEmailDto,
} from './dto.js';
import { EmailVerificationService } from './email-verification.service.js';
import {
  SessionProfileDto,
  SessionResponseDto,
  VerificationRequiredResponseDto,
  VerifyEmailResponseDto,
} from './responses.js';

// Errors of every endpoint that opens a session (AccessService.loadContext).
const SESSION_FORBIDDEN = [
  'NOT_A_MEMBER',
  'MEMBERSHIP_SUSPENDED',
  'ACCOUNT_DISABLED',
  'EMAIL_NOT_VERIFIED',
  'ORGANIZATION_INACTIVE',
  'USER_DISABLED',
];

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tenantResolver: TenantResolver,
    private readonly verification: EmailVerificationService,
  ) {}

  @Public()
  @Post('signup')
  @ApiOperation({
    summary: 'Owner sign-up: create an account and its organization',
    description:
      'The only open registration. Provisions the organization and its tenant schema. ' +
      'A new account gets a confirmation email and no session (`verificationRequired`); ' +
      'an existing account must send its current password, and is logged in if its email is already verified. ' +
      'Call it from the main domain (no tenant needed).',
  })
  @ApiExtraModels(SessionResponseDto, VerificationRequiredResponseDto)
  @ApiCreatedResponse({
    description:
      '`VerificationRequiredResponse` for a new account, `SessionResponse` for a verified existing one',
    schema: {
      oneOf: [
        { $ref: getSchemaPath(VerificationRequiredResponseDto) },
        { $ref: getSchemaPath(SessionResponseDto) },
      ],
    },
  })
  @ApiPublic({
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: ['SUBDOMAIN_INVALID'],
      [HttpStatus.FORBIDDEN]: ['ACCOUNT_DISABLED'],
      [HttpStatus.CONFLICT]: ['EMAIL_TAKEN', 'SUBDOMAIN_TAKEN', 'TAX_ID_TAKEN'],
    },
  })
  signup(@Body() dto: SignupDto) {
    return this.auth.signup(dto);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Confirm the owner's email",
    description:
      'Consumes the token of the emailed `verify-email?token=` link. Tokens work once.',
  })
  @ApiOkResponse({ type: VerifyEmailResponseDto })
  @ApiPublic({
    validation: true,
    errors: { [HttpStatus.BAD_REQUEST]: ['VERIFICATION_TOKEN_INVALID'] },
  })
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.verification.verify(dto.token);
  }

  @Public()
  @Post('verify-email/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Send a new confirmation email',
    description:
      'Always answers 202, whether or not the email exists, and sends at most one email per minute per account. ' +
      "With a tenant, the link points to that organization's subdomain.",
  })
  @ApiAcceptedResponse({ description: 'Accepted; no body' })
  @ApiPublic({ tenant: true, validation: true })
  async resendVerification(
    @Req() request: Request,
    @Body() dto: ResendVerificationDto,
  ): Promise<void> {
    await this.verification.resend(
      dto.email,
      this.tenantResolver.resolve(request),
    );
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Log in to the request's organization",
    description:
      'Valid credentials of an account that does not belong to the organization are rejected with `NOT_A_MEMBER`. ' +
      'Returns the tokens and the user’s roles and permissions in that organization.',
  })
  @ApiOkResponse({ type: SessionResponseDto })
  @ApiPublic({
    tenant: true,
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: ['TENANT_REQUIRED'],
      [HttpStatus.UNAUTHORIZED]: ['INVALID_CREDENTIALS'],
      [HttpStatus.FORBIDDEN]: SESSION_FORBIDDEN,
      [HttpStatus.NOT_FOUND]: ['ORGANIZATION_NOT_FOUND'],
    },
  })
  login(@Req() request: Request, @Body() dto: LoginDto) {
    return this.auth.login(this.tenantResolver.resolve(request), dto);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate the refresh token',
    description:
      'Revokes the given refresh token and returns a new session. Reusing an already rotated token ' +
      'is treated as theft and ends every session of the account in the organization.',
  })
  @ApiOkResponse({ type: SessionResponseDto })
  @ApiPublic({
    tenant: true,
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: ['TENANT_REQUIRED'],
      [HttpStatus.UNAUTHORIZED]: ['INVALID_REFRESH_TOKEN'],
      [HttpStatus.FORBIDDEN]: ['TENANT_MISMATCH', ...SESSION_FORBIDDEN],
    },
  })
  refresh(@Req() request: Request, @Body() dto: RefreshTokenDto) {
    return this.auth.refresh(
      this.tenantResolver.resolve(request),
      dto.refreshToken,
    );
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Log out',
    description:
      'Revokes the refresh token. The access token stays valid until it expires.',
  })
  @ApiNoContentResponse({ description: 'Logged out (also for unknown tokens)' })
  @ApiPublic({ validation: true })
  logout(@Body() dto: RefreshTokenDto) {
    return this.auth.logout(dto.refreshToken);
  }

  @Get('me')
  @ApiOperation({
    summary: 'Current session',
    description:
      'Account, organization, and the user’s roles and permissions in it.',
  })
  @ApiOkResponse({ type: SessionProfileDto })
  @ApiSession()
  me(@CurrentAuth() auth: AuthContext) {
    return toSessionProfile(auth);
  }
}
