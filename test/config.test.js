import test from 'node:test';
import assert from 'node:assert/strict';

import { getMonitorConfig, isScheduledCheckDue } from '../src/config.js';

test('uses existing monitor defaults when variables are absent', () => {
  const config = getMonitorConfig({});
  assert.equal(config.intervalMinutes, 2);
  assert.equal(config.pollSeconds, 120);
  assert.equal(config.products.length, 6);
  assert.equal(config.stores.length, 3);
  assert.equal(config.location, '518000');
});

test('parses interval, stores, products and location from variables', () => {
  const config = getMonitorConfig({
    CHECK_INTERVAL_MINUTES: '5',
    MONITOR_LOCATION: '200000',
    MONITOR_STORES_JSON: JSON.stringify([
      { store_number: 'R001', store_name: '测试门店', city: '上海' },
    ]),
    MONITOR_PRODUCTS_JSON: JSON.stringify([
      { part_number: 'TEST/A', model: 'iPhone Test', capacity: '1TB', color: '黑色' },
    ]),
  });

  assert.equal(config.intervalMinutes, 5);
  assert.equal(config.pollSeconds, 300);
  assert.deepEqual(config.storeNumbers, ['R001']);
  assert.deepEqual(config.parts, ['TEST/A']);
  assert.equal(config.products[0].capacity, '1TB');
  assert.equal(config.location, '200000');
});

test('runs only on minute buckets matching the configured interval', () => {
  assert.equal(isScheduledCheckDue(10 * 60_000, 5), true);
  assert.equal(isScheduledCheckDue(11 * 60_000, 5), false);
  assert.equal(isScheduledCheckDue(11 * 60_000, 1), true);
});

test('rejects malformed or unsafe variable values', () => {
  assert.throws(
    () => getMonitorConfig({ CHECK_INTERVAL_MINUTES: '0' }),
    /integer from 1 to 1440/,
  );
  assert.throws(
    () => getMonitorConfig({ MONITOR_STORES_JSON: 'not-json' }),
    /valid JSON/,
  );
  assert.throws(
    () => getMonitorConfig({
      MONITOR_PRODUCTS_JSON: JSON.stringify([
        { part_number: 'X', model: 'A', capacity: '1TB' },
        { part_number: 'X', model: 'B', capacity: '2TB' },
      ]),
    }),
    /must be unique/,
  );
});
