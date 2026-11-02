import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { setupSwagger } from './swagger/swagger.js';
import { TENANT_HEADER } from './tenancy/subdomain.js';

// Browsers may call the API from the main domain and from any organization subdomain.
function isAllowedOrigin(origin: string, baseDomain: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === baseDomain || hostname.endsWith(`.${baseDomain}`);
  } catch {
    return false;
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  const baseDomain = process.env.APP_BASE_DOMAIN;
  if (baseDomain) {
    app.enableCors({
      origin: (
        origin: string | undefined,
        callback: (error: Error | null, allow?: boolean) => void,
      ) => callback(null, !origin || isAllowedOrigin(origin, baseDomain)),
      allowedHeaders: ['Authorization', 'Content-Type', TENANT_HEADER],
    });
  }
  setupSwagger(app);
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
