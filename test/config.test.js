import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultMonitorSettings,
  normalizeMonitorSettings,
  buildMonitorConfig,
  SEED_PART_NUMBERS,
  SEED_STORE_NUMBERS,
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
} from '../src/config.js';

test('defaults seed three Shenzhen stores and six iPhone 18 Pro Max SKUs', () => {
  const settings = defaultMonitorSettings();
  assert.equal(settings.interval_seconds, 120);
  assert.equal(settings.location, '518000');
  assert.deepEqual(settings.store_numbers, SEED_STORE_NUMBERS);
  assert.deepEqual(settings.part_numbers, SEED_PART_NUMBERS);
  assert.equal(SEED_STORE_NUMBERS.length, 3);
  assert.ok(SEED_STORE_NUMBERS.every((sn) => /^R\d+$/.test(sn)));
  assert.equal(SEED_PART_NUMBERS.length, 6);
  assert.ok(SEED_PART_NUMBERS.every((pn) => /CH\/A$/.test(pn)));
});

test('normalization rejects out-of-range intervals, empty selections, duplicates', () => {
  assert.throws(() => normalizeMonitorSettings({ interval_seconds: 5, location: '518000', store_numbers: ['R761'], part_numbers: ['MJY84CH/A'] }));
  assert.throws(() => normalizeMonitorSettings({ interval_seconds: MAX_INTERVAL_SECONDS + 1, location: '518000', store_numbers: ['R761'], part_numbers: ['MJY84CH/A'] }));
  assert.throws(() => normalizeMonitorSettings({ interval_seconds: 120, location: '', store_numbers: ['R761'], part_numbers: ['MJY84CH/A'] }));
  assert.throws(() => normalizeMonitorSettings({ interval_seconds: 120, location: '518000', store_numbers: [], part_numbers: ['MJY84CH/A'] }));
  assert.throws(() => normalizeMonitorSettings({ interval_seconds: 120, location: '518000', store_numbers: ['R761', 'R761'], part_numbers: ['MJY84CH/A'] }));
  assert.throws(() => normalizeMonitorSettings({ interval_seconds: 120, location: '518000', store_numbers: ['R761'], part_numbers: [''] }));
});

test('normalization accepts arbitrary store and part numbers (no whitelist)', () => {
  const settings = normalizeMonitorSettings({
    interval_seconds: MIN_INTERVAL_SECONDS,
    location: '100000',
    store_numbers: ['R448', 'R479', 'R761'],
    part_numbers: ['MG6W4CH/A', 'MJY84CH/A'],
  });
  assert.equal(settings.interval_seconds, MIN_INTERVAL_SECONDS);
  assert.deepEqual(settings.store_numbers, ['R448', 'R479', 'R761']);
  assert.deepEqual(settings.part_numbers, ['MG6W4CH/A', 'MJY84CH/A']);
});

test('buildMonitorConfig exposes parts/storeNumbers but leaves product + store detail empty', () => {
  const config = buildMonitorConfig({
    interval_seconds: 60,
    location: '510000',
    store_numbers: ['R479', 'R761'],
    part_numbers: ['MJY84CH/A'],
  });
  assert.equal(config.intervalSeconds, 60);
  assert.equal(config.pollSeconds, 60);
  assert.equal(config.location, '510000');
  assert.deepEqual(config.parts, ['MJY84CH/A']);
  assert.deepEqual(config.storeNumbers, ['R479', 'R761']);
  assert.deepEqual(config.products, []);
  assert.deepEqual(config.stores, []);
});
