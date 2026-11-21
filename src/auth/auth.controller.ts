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
  VerifyLoginCodeDto,
} from './dto.js';
import { EmailVerificationService } from './email-verification.service.js';
import { LoginCodeService } from './login-code.service.js';
import {
  LoginCodeRequiredResponseDto,
  SessionProfileDto,
  SessionResponseDto,
  VerificationRequiredResponseDto,
  VerifyEmailResponseDto,
} from './responses.js';
import { SessionCookies } from './session-cookies.js';

const COOKIE_NOTE =
  'Tokens are set as the HttpOnly cookies `pango_access_<subdomain>` (path `/`) and ' +
  '`pango_refresh_<subdomain>` (path `/auth`) and never appear in the body; send requests with credentials.';

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
    private readonly loginCodes: LoginCodeService,
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
    summary: "Log in to the request's organization (first step)",
    description:
      'Checks the password and that the account may enter the organization (valid credentials of an account ' +
      'that does not belong to it are rejected with `NOT_A_MEMBER`), then emails a six-digit code and answers ' +
      '`202` with `LoginCodeRequiredResponse`; `POST /auth/login/verify` completes it. The pending login is kept ' +
      'in the HttpOnly cookie `pango_login_<subdomain>` (path `/auth/login`). Logging in again within a minute ' +
      'keeps the code already sent instead of emailing another. A browser trusted after an earlier code ' +
      '(cookie `pango_device_<subdomain>`, see POST /auth/login/verify) and `LOGIN_EMAIL_CODE_ENABLED=false` ' +
      `answer \`200\` with the session at once. ${COOKIE_NOTE}`,
  })
  @ApiExtraModels(SessionResponseDto, LoginCodeRequiredResponseDto)
  @ApiAcceptedResponse({
    description: 'Code emailed; enter it with POST /auth/login/verify',
    type: LoginCodeRequiredResponseDto,
  })
  @ApiOkResponse({
    description: 'Session: a trusted browser, or the emailed code disabled',
    type: SessionResponseDto,
  })
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
    const subdomain = this.tenantResolver.resolve(request);
    const device = subdomain
      ? this.cookies.readTrustedDevice(request, subdomain)
      : null;
    const result = await this.auth.login(subdomain, dto, device);
    if ('accessToken' in result) return this.cookies.issue(response, result);
    this.cookies.issueLoginChallenge(
      response,
      subdomain!,
      result.token,
      this.loginCodes.cookieMaxAgeMs,
    );
    response.status(HttpStatus.ACCEPTED);
    return result.state;
  }

  @Public()
  @Post('login/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Enter the emailed code (second step of the login)',
    description:
      'Reads the pending login from the `pango_login_<subdomain>` cookie and, with the right code, opens the ' +
      'session and clears that cookie. `LOGIN_CODE_INVALID` carries `attemptsLeft`; after the last attempt (`LOGIN_CODE_ATTEMPTS_EXCEEDED`) or with ' +
      'no pending login (`LOGIN_CHALLENGE_INVALID`) the cookie is cleared and the user must log in again. ' +
      'An expired code (`LOGIN_CODE_EXPIRED`) can be replaced with POST /auth/login/resend. The right code also ' +
      'trusts the browser: the HttpOnly cookie `pango_device_<subdomain>` (path `/auth/login`) skips the code on ' +
      'the next logins for `LOGIN_TRUSTED_DEVICE_HOURS` (default 12), or `LOGIN_REMEMBER_DEVICE_DAYS` (default 30) ' +
      `with \`rememberDevice\`. Logging out keeps it; changing the password ends it. ${COOKIE_NOTE}`,
  })
  @ApiOkResponse({ type: SessionResponseDto })
  @ApiPublic({
    tenant: true,
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: ['TENANT_REQUIRED'],
      [HttpStatus.UNAUTHORIZED]: [
        'LOGIN_CODE_INVALID',
        'LOGIN_CODE_EXPIRED',
        'LOGIN_CODE_ATTEMPTS_EXCEEDED',
        'LOGIN_CHALLENGE_INVALID',
      ],
      [HttpStatus.FORBIDDEN]: ['CSRF_REJECTED', ...SESSION_FORBIDDEN],
    },
  })
  async verifyLoginCode(
    @Req() request: Request,
    @Body() dto: VerifyLoginCodeDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const subdomain = this.tenantResolver.resolve(request);
    const token = subdomain
      ? this.cookies.readLoginChallenge(request, subdomain)
      : null;
    try {
      const { session, trust } = await this.auth.verifyLoginCode(
        subdomain,
        token,
        dto.code,
        dto.rememberDevice ?? false,
      );
      this.cookies.clearLoginChallenge(response, subdomain!);
      if (trust) {
        this.cookies.issueTrustedDevice(
          response,
          subdomain!,
          trust.token,
          trust.maxAgeMs,
        );
      }
      return this.cookies.issue(response, session);
    } catch (error) {
      if (subdomain && endsLogin(error)) {
        this.cookies.clearLoginChallenge(response, subdomain);
      }
      throw error;
    }
  }

  @Public()
  @Post('login/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Email another login code',
    description:
      'For the pending login of the `pango_login_<subdomain>` cookie: a new code replaces the previous one ' +
      'and the attempts start again. At most one per minute (`LOGIN_CODE_RESEND_TOO_SOON` carries ' +
      '`retryAfterSeconds`) and five per login (`LOGIN_CODE_RESEND_LIMIT`: log in again).',
  })
  @ApiAcceptedResponse({ type: LoginCodeRequiredResponseDto })
  @ApiPublic({
    tenant: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: ['TENANT_REQUIRED'],
      [HttpStatus.UNAUTHORIZED]: ['LOGIN_CHALLENGE_INVALID'],
      [HttpStatus.FORBIDDEN]: ['CSRF_REJECTED'],
      [HttpStatus.TOO_MANY_REQUESTS]: [
        'LOGIN_CODE_RESEND_TOO_SOON',
        'LOGIN_CODE_RESEND_LIMIT',
      ],
    },
  })
  async resendLoginCode(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const subdomain = this.tenantResolver.resolve(request);
    const token = subdomain
      ? this.cookies.readLoginChallenge(request, subdomain)
      : null;
    try {
      const state = await this.auth.resendLoginCode(subdomain, token);
      // The challenge may now live as long as its new code: renew the cookie too.
      this.cookies.issueLoginChallenge(
        response,
        subdomain!,
        token!,
        this.loginCodes.cookieMaxAgeMs,
      );
      return state;
    } catch (error) {
      if (subdomain && endsLogin(error)) {
        this.cookies.clearLoginChallenge(response, subdomain);
      }
      throw error;
    }
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate the refresh token',
    description:
      'Reads the refresh cookie of the request’s organization, revokes it and returns a new session ' +
      '(with new cookies). Reusing an already rotated token is treated as theft and ends every ' +
      'session of the account in the organization. On failure both cookies are cleared.',
  })
  @ApiCookieAuth(REFRESH_COOKIE_AUTH)
  @ApiOkResponse({ type: SessionResponseDto })
  @ApiPublic({
    tenant: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: ['TENANT_REQUIRED'],
      [HttpStatus.UNAUTHORIZED]: ['INVALID_REFRESH_TOKEN'],
      [HttpStatus.FORBIDDEN]: [
        'CSRF_REJECTED',
        'TENANT_MISMATCH',
        ...SESSION_FORBIDDEN,
      ],
    },
  })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const subdomain = this.tenantResolver.resolve(request);
    if (!subdomain) throw authErrors.tenantRequired();
    const refreshToken = this.cookies.readRefresh(request, subdomain);
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
      'Revokes the refresh token of the request’s organization and clears both cookies.',
  })
  @ApiCookieAuth(REFRESH_COOKIE_AUTH)
  @ApiNoContentResponse({ description: 'Logged out (also without a cookie)' })
  @ApiPublic({
    tenant: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: ['TENANT_REQUIRED'],
      [HttpStatus.FORBIDDEN]: ['CSRF_REJECTED'],
    },
  })
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const subdomain = this.tenantResolver.resolve(request);
    if (!subdomain) throw authErrors.tenantRequired();
    const refreshToken = this.cookies.readRefresh(request, subdomain);
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

// Errors after which the pending login is useless: the client must log in again.
const LOGIN_ENDING_CODES = new Set([
  'LOGIN_CHALLENGE_INVALID',
  'LOGIN_CODE_ATTEMPTS_EXCEEDED',
  'LOGIN_CODE_RESEND_LIMIT',
]);

function endsLogin(error: unknown): boolean {
  if (!(error instanceof HttpException)) return false;
  const body = error.getResponse();
  return (
    typeof body === 'object' &&
    LOGIN_ENDING_CODES.has((body as { code?: string }).code ?? '')
  );
}
