import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ForecastRequest, ForecastResponse } from './contract.js';

/** The service could not be reached, refused the request or timed out. */
export class ForecastServiceError extends Error {
  constructor(
    message: string,
    /** Worth retrying: unreachable, timed out or 5xx. */
    readonly retryable = false,
  ) {
    super(message);
  }
}

// HTTP client of the forecasting service (`POST /v1/forecasts`), authenticated
// with a service token, never an end-user JWT.
@Injectable()
export class ForecastClient {
  private readonly logger = new Logger(ForecastClient.name);
  private readonly url: string | null;
  private readonly token: string | null;
  readonly timeoutMs: number;
  /** MAX_SERIES_PER_REQUEST of the service; larger runs are split. */
  readonly maxSeries: number;
  /** Weeks forecast; must equal the horizon of the service's model policy. */
  readonly horizon: number;
  /** Pause before the single retry. */
  retryDelayMs = 1000;

  constructor(config: ConfigService) {
    this.url =
      config.get<string>('FORECAST_SERVICE_URL')?.replace(/\/+$/, '') || null;
    this.token = config.get<string>('FORECAST_SERVICE_TOKEN') || null;
    this.timeoutMs = Number(config.get('FORECAST_TIMEOUT_MS') ?? 120_000);
    this.maxSeries = Number(config.get('FORECAST_MAX_SERIES') ?? 500);
    this.horizon = Number(config.get('FORECAST_HORIZON') ?? 4);
  }

  get configured(): boolean {
    return this.url !== null && this.token !== null;
  }

  /**
   * Sends one batch. A network failure, a timeout or a 5xx is retried once with
   * the same `request_id` and payload (contract section 18); a 4xx is not.
   */
  async forecast(body: ForecastRequest): Promise<ForecastResponse> {
    try {
      return await this.send(body);
    } catch (error) {
      if (!(error instanceof ForecastServiceError) || !error.retryable) {
        throw error;
      }
      this.logger.warn(
        `request_id=${body.request_id} retrying: ${error.message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      return this.send(body);
    }
  }

  private async send(body: ForecastRequest): Promise<ForecastResponse> {
    if (!this.url || !this.token) {
      throw new ForecastServiceError(
        'The forecasting service is not configured',
      );
    }
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.url}/v1/forecasts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ForecastServiceError(
        `The forecasting service did not answer: ${(error as Error).message}`,
        true,
      );
    }
    const text = await response.text();
    let parsed: ForecastResponse | null = null;
    try {
      parsed = JSON.parse(text) as ForecastResponse;
    } catch {
      parsed = null;
    }
    this.logger.log(
      `request_id=${body.request_id} forecast_run_id=${body.forecast_run_id} ` +
        `series_count=${body.series.length} status=${response.status} ` +
        `policy_version=${parsed?.policy_version ?? '-'} ` +
        `duration_ms=${Date.now() - started}`,
    );
    if (!response.ok) {
      throw new ForecastServiceError(
        `The forecasting service answered ${response.status}: ${text.slice(0, 500)}`,
        response.status >= 500,
      );
    }
    if (!parsed) {
      throw new ForecastServiceError(
        'The forecasting service answered invalid JSON',
      );
    }
    return parsed;
  }
}
