import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  HttpException,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiPublic, ApiSession } from '../swagger/api-docs.js';
import { REFRESH_COOKIE_AUTH } from '../swagger/swagger.js';
import { TenantResolver } from '../tenancy/tenant-resolver.service.js';
import { type AuthContext, toSessionProfile } from './auth-context.js';
import { AuthService } from './auth.service.js';
import { authErrors } from './auth-errors.js';
import { CurrentAuth, Public } from './decorators.js';
import {
  LoginDto,
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
import { SessionCookies } from './session-cookies.js';

const COOKIE_NOTE =
  'The refresh token is set as the HttpOnly cookie `pango_refresh_<subdomain>` (path `/auth`) ' +
  'and is not in the body; send requests with credentials.';

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
    private readonly cookies: SessionCookies,
  ) {}

  @Public()
  @Post('signup')
  @ApiOperation({
    summary: 'Owner sign-up: create an account and its organization',
    description:
      'The only open registration. Provisions the organization and its tenant schema. ' +
      'A new account gets a confirmation email and no session (`verificationRequired`); ' +
      'an existing account must send its current password, and is logged in if its email is already verified. ' +
      `Call it from the main domain (no tenant needed). ${COOKIE_NOTE}`,
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
  async signup(
    @Body() dto: SignupDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.signup(dto);
    return 'accessToken' in result
      ? this.cookies.issue(response, result)
      : result;
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
      'Returns the access token and the user’s roles and permissions in that organization. ' +
      COOKIE_NOTE,
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
  async login(
    @Req() request: Request,
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const session = await this.auth.login(
      this.tenantResolver.resolve(request),
      dto,
    );
    return this.cookies.issue(response, session);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate the refresh token',
    description:
      'Reads the refresh cookie of the request’s organization, revokes it and returns a new session ' +
      '(with a new cookie). Reusing an already rotated token is treated as theft and ends every ' +
      'session of the account in the organization. On failure the cookie is cleared.',
  })
  @ApiCookieAuth(REFRESH_COOKIE_AUTH)
  @ApiOkResponse({ type: SessionResponseDto })
  @ApiPublic({
    tenant: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: ['TENANT_REQUIRED'],
      [HttpStatus.UNAUTHORIZED]: ['INVALID_REFRESH_TOKEN'],
      [HttpStatus.FORBIDDEN]: ['TENANT_MISMATCH', ...SESSION_FORBIDDEN],
    },
  })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const subdomain = this.tenantResolver.resolve(request);
    if (!subdomain) throw authErrors.tenantRequired();
    const refreshToken = this.cookies.read(request, subdomain);
    if (!refreshToken) throw authErrors.invalidRefreshToken();
    try {
      const session = await this.auth.refresh(subdomain, refreshToken);
      return this.cookies.issue(response, session);
    } catch (error) {
      // A rejected token is useless; drop it so the client stops sending it.
      if (error instanceof HttpException && error.getStatus() < 500) {
        this.cookies.clear(response, subdomain);
      }
      throw error;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Log out',
    description:
      'Revokes the refresh cookie of the request’s organization and clears it. ' +
      'The access token stays valid until it expires; the frontend should discard it.',
  })
  @ApiCookieAuth(REFRESH_COOKIE_AUTH)
  @ApiNoContentResponse({ description: 'Logged out (also without a cookie)' })
  @ApiPublic({
    tenant: true,
    errors: { [HttpStatus.BAD_REQUEST]: ['TENANT_REQUIRED'] },
  })
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const subdomain = this.tenantResolver.resolve(request);
    if (!subdomain) throw authErrors.tenantRequired();
    const refreshToken = this.cookies.read(request, subdomain);
    if (refreshToken) await this.auth.logout(refreshToken);
    this.cookies.clear(response, subdomain);
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
