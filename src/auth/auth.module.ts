import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessService } from './access.service.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { EmailVerificationService } from './email-verification.service.js';
import { TokenService } from './token.service.js';

@Module({
  controllers: [AuthController],
  providers: [
    AccessService,
    AuthService,
    EmailVerificationService,
    TokenService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AccessService, AuthService],
})
export class AuthModule {}
