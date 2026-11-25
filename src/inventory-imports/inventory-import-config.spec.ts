import type { ConfigService } from '@nestjs/config';
import { InventoryImportConfig } from './inventory-import-config.js';

const configWith = (values: Record<string, string>) =>
  ({ get: (name: string) => values[name] }) as unknown as ConfigService;

describe('InventoryImportConfig', () => {
  it('uses the approved defaults', () => {
    const config = new InventoryImportConfig(configWith({}));
    expect(config).toMatchObject({
      maxRows: 5000,
      maxBatchRows: 5000,
      expiryHours: 24,
      confirmTimeoutMs: 120_000,
      maxRequestBytes: 1024 * 1024,
    });
  });

  it('reads each limit from the environment', () => {
    const config = new InventoryImportConfig(
      configWith({
        INVENTORY_IMPORT_MAX_ROWS: '2000',
        INVENTORY_IMPORT_MAX_BATCH_ROWS: '500',
        INVENTORY_IMPORT_EXPIRY_HOURS: '6',
        INVENTORY_IMPORT_CONFIRM_TIMEOUT_MS: '60000',
      }),
    );
    expect(config).toMatchObject({
      maxRows: 2000,
      maxBatchRows: 500,
      expiryHours: 6,
      confirmTimeoutMs: 60_000,
    });
  });

  it.each(['0', '-5', '1.5', 'many'])('refuses %s as a limit', (value) => {
    expect(
      () =>
        new InventoryImportConfig(
          configWith({ INVENTORY_IMPORT_MAX_ROWS: value }),
        ),
    ).toThrow('INVENTORY_IMPORT_MAX_ROWS must be a positive integer');
  });
});
