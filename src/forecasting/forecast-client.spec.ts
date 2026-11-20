import type { ConfigService } from '@nestjs/config';
import type { ForecastRequest } from './contract.js';
import { ForecastClient, ForecastServiceError } from './forecast-client.js';

const env: Record<string, string> = {
  FORECAST_SERVICE_URL: 'http://forecast.test/',
  FORECAST_SERVICE_TOKEN: 'secret',
};
const client = () => {
  const c = new ForecastClient({
    get: (k: string) => env[k],
  } as unknown as ConfigService);
  c.retryDelayMs = 0;
  return c;
};
const body = {
  request_id: 'req-1',
  forecast_run_id: 1,
  series: [],
} as unknown as ForecastRequest;
const reply = (status: number, json: unknown = {}) =>
  new Response(JSON.stringify(json), { status });

afterEach(() => vi.unstubAllGlobals());

describe('ForecastClient', () => {
  it('posts with the service token and parses the answer', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(200, { results: [] }));
    vi.stubGlobal('fetch', fetch);
    expect(await client().forecast(body)).toEqual({ results: [] });
    expect(fetch).toHaveBeenCalledWith(
      'http://forecast.test/v1/forecasts',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
      }),
    );
  });

  it('retries a 5xx once with the same request, but never a 4xx', async () => {
    const flaky = vi
      .fn()
      .mockResolvedValueOnce(reply(503))
      .mockResolvedValueOnce(reply(200, { results: [] }));
    vi.stubGlobal('fetch', flaky);
    await client().forecast(body);
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(flaky.mock.calls[1][1].body).toBe(flaky.mock.calls[0][1].body);

    const refused = vi.fn().mockResolvedValue(reply(422, { detail: 'bad' }));
    vi.stubGlobal('fetch', refused);
    await expect(client().forecast(body)).rejects.toBeInstanceOf(
      ForecastServiceError,
    );
    expect(refused).toHaveBeenCalledTimes(1);
  });
});
