import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { InvitationsModule } from './invitations/invitations.module.js';
import { MailModule } from './mail/mail.module.js';
import { OrganizationsModule } from './organizations/organizations.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { TenancyModule } from './tenancy/tenancy.module.js';
import { UsersModule } from './users/users.module.js';
import { WarehousesModule } from './warehouses/warehouses.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    TenancyModule,
    MailModule,
    AuthModule,
    InvitationsModule,
    OrganizationsModule,
    UsersModule,
    CatalogModule,
    WarehousesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
