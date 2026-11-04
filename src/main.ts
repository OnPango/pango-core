import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { setupSwagger } from './swagger/swagger.js';
import { isAllowedOrigin } from './tenancy/origins.js';
import { TENANT_HEADER } from './tenancy/subdomain.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // Browsers may call the API from the main domain and any organization subdomain.
  const baseDomain = process.env.APP_BASE_DOMAIN;
  if (baseDomain) {
    app.enableCors({
      origin: (
        origin: string | undefined,
        callback: (error: Error | null, allow?: boolean) => void,
      ) => callback(null, !origin || isAllowedOrigin(origin, baseDomain)),
      allowedHeaders: ['Authorization', 'Content-Type', TENANT_HEADER],
      // Session tokens are HttpOnly cookies; requests must carry credentials.
      credentials: true,
    });
  }
  setupSwagger(app);
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
