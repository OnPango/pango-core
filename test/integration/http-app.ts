// Boots the whole Pango app for HTTP tests, configured as src/main.ts configures
// it, against the local test database only.
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { testDatabaseUrl } from './database.js';

export async function bootApp() {
  // The app reads its database from the environment: never Supabase here.
  process.env.DATABASE_URL = testDatabaseUrl();
  process.env.DIRECT_URL = testDatabaseUrl();
  const { AppModule } = await import('../../src/app.module.js');
  const { TokenService } = await import('../../src/auth/token.service.js');
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  app.useBodyParser('json', { limit: '1mb' });
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();
  return { app, tokens: app.get(TokenService) };
}
