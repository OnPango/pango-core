import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { InvitationsModule } from './invitations/invitations.module.js';
import { MailModule } from './mail/mail.module.js';
import { MovementsModule } from './movements/movements.module.js';
import { ReplenishmentModule } from './replenishment/replenishment.module.js';
import { StockRequestsModule } from './stock-requests/stock-requests.module.js';
import { StockModule } from './stock/stock.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { DemandModule } from './demand/demand.module.js';
import { ForecastingModule } from './forecasting/forecasting.module.js';
import { DepartmentsModule } from './departments/departments.module.js';
import { OrganizationsModule } from './organizations/organizations.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RolesModule } from './roles/roles.module.js';
import { SearchModule } from './search/search.module.js';
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
    RolesModule,
    CatalogModule,
    WarehousesModule,
    SearchModule,
    DashboardModule,
    MovementsModule,
    ReplenishmentModule,
    DepartmentsModule,
    StockRequestsModule,
    StockModule,
    DemandModule,
    ForecastingModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
