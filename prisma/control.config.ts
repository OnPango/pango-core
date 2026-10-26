import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Control plane (`public` schema).
export default defineConfig({
  schema: 'control/schema.prisma',
  migrations: { path: 'control/migrations' },
  datasource: { url: process.env.DIRECT_URL ?? '' },
});
