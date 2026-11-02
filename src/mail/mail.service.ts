import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

// Sends email through Resend. Without RESEND_API_KEY (local development only) the
// message is written to the log instead.
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly resend: Resend | null;
  private readonly from: string;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('RESEND_API_KEY');
    if (!apiKey && config.get<string>('NODE_ENV') === 'production') {
      throw new Error('RESEND_API_KEY is required in production');
    }
    this.resend = apiKey ? new Resend(apiKey) : null;
    this.from =
      config.get<string>('MAIL_FROM') ?? 'Pango <onboarding@resend.dev>';
  }

  async send(message: MailMessage): Promise<void> {
    if (!this.resend) {
      this.logger.warn(
        `RESEND_API_KEY is not set; email not sent.\nTo: ${message.to}\nSubject: ${message.subject}\n\n${message.text}`,
      );
      return;
    }
    const { error } = await this.resend.emails.send({
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    if (error) {
      throw new Error(`Resend failed to send email: ${error.message}`);
    }
  }
}
