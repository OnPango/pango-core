import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Builds frontend URLs for emailed links from WEB_APP_URL_TEMPLATE.
@Injectable()
export class WebLinks {
  private readonly template: string;

  constructor(config: ConfigService) {
    this.template =
      config.get<string>('WEB_APP_URL_TEMPLATE') ??
      'http://{subdomain}.localhost:5173';
  }

  /** `<organization frontend>/<path>?token=<token>` */
  withToken(subdomain: string, path: string, token: string): string {
    const base = this.template
      .replace('{subdomain}', subdomain)
      .replace(/\/+$/, '');
    return `${base}/${path}?token=${encodeURIComponent(token)}`;
  }
}
