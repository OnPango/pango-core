import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessService } from './access.service.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { CsrfGuard } from './csrf.guard.js';
import { AuthService } from './auth.service.js';
import { EmailVerificationService } from './email-verification.service.js';
import { LoginCodeService } from './login-code.service.js';
import { SessionCookies } from './session-cookies.js';
import { TokenService } from './token.service.js';

@Module({
  controllers: [AuthController],
  providers: [
    AccessService,
    AuthService,
    EmailVerificationService,
    LoginCodeService,
    SessionCookies,
    TokenService,
    // Global guards run in this order: CSRF check before authentication.
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AccessService, AuthService, SessionCookies],
})
export class AuthModule {}
