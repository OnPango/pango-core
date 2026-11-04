import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { TENANT_HEADER } from '../tenancy/subdomain.js';

export const BEARER_AUTH = 'access-token';
export const TENANT_AUTH = 'tenant';
export const REFRESH_COOKIE_AUTH = 'refresh-cookie';
export const DOCS_PATH = 'docs';

/** Swagger UI at /docs and the OpenAPI JSON at /docs-json. Off in production unless SWAGGER_ENABLED=true. */
export function setupSwagger(app: INestApplication): void {
  const enabled =
    process.env.SWAGGER_ENABLED === 'true' ||
    (process.env.SWAGGER_ENABLED !== 'false' &&
      process.env.NODE_ENV !== 'production');
  if (!enabled) return;

  const config = new DocumentBuilder()
    .setTitle('Pango Core API')
    .setDescription(
      [
        'Backend of Pango, a multi-tenant inventory SaaS for SMEs.',
        '',
        '**Organization (tenant):** every organization is served from its subdomain (`mi-empresa.onpango.com`).',
        `When calling the API from another host, send the subdomain in the \`${TENANT_HEADER}\` header (\`tenant\` scheme in *Authorize*).`,
        '',
        '**Session:** `POST /auth/login` returns an access token; send it as `Authorization: Bearer <token>` (`access-token` scheme).',
        'A token only works on the organization it was issued for.',
        '',
        '**Errors:** application errors have the shape `{ statusCode, code, message }`; branch on `code`.',
        "Validation errors keep Nest's shape, with `message` as an array.",
      ].join('\n'),
    )
    .setVersion(process.env.npm_package_version ?? '0.0.1')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Access token from login, refresh or invitation acceptance',
      },
      BEARER_AUTH,
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: TENANT_HEADER,
        description: 'Organization subdomain, e.g. `mi-empresa`',
      },
      TENANT_AUTH,
    )
    .addCookieAuth(
      'pango_refresh_<subdomain>',
      {
        type: 'apiKey',
        in: 'cookie',
        description:
          'HttpOnly refresh cookie set by login; the browser sends it automatically',
      },
      REFRESH_COOKIE_AUTH,
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(DOCS_PATH, app, document, {
    jsonDocumentUrl: `${DOCS_PATH}-json`,
    swaggerOptions: { persistAuthorization: true },
  });
}
