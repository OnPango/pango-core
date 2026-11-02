import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service.js';
import { WebLinks } from './web-links.service.js';

@Global()
@Module({
  providers: [MailService, WebLinks],
  exports: [MailService, WebLinks],
})
export class MailModule {}
