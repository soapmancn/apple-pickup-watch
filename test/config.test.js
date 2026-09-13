import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultMonitorSettings,
  normalizeMonitorSettings,
  buildMonitorConfig,
  REGIONS,
  SEED_REGION_PART_NUMBERS,
  SEED_REGION_STORE_NUMBERS,
} from '../src/config.js';

test('defaults seed three Shenzhen stores and six iPhone 18 Pro Max SKUs in CN region', () => {
  const settings = defaultMonitorSettings();
  assert.equal(settings.interval_seconds, 120);
  assert.equal(Object.keys(settings.regions).length, REGIONS.length);
  const cn = settings.regions.cn;
  const hk = settings.regions.hk;
  assert.equal(cn.enabled, true);
  assert.equal(cn.location, '518000');
  assert.deepEqual(cn.store_numbers, SEED_REGION_STORE_NUMBERS.cn);
  assert.deepEqual(cn.part_numbers, SEED_REGION_PART_NUMBERS.cn);
  assert.equal(hk.enabled, false);
  assert.deepEqual(hk.store_numbers, SEED_REGION_STORE_NUMBERS.hk);
  assert.deepEqual(hk.part_numbers, SEED_REGION_PART_NUMBERS.hk);
});

test('normalization rejects out-of-range intervals, empty regions, duplicates', () => {
  assert.throws(() => normalizeMonitorSettings({ interval_seconds: 5, regions: { cn: { enabled: true, location: '518000', store_numbers: ['R761'], part_numbers: ['MJY84CH/A'] } } }));
  assert.throws(() => normalizeMonitorSettings({ interval_seconds: 120, regions: { cn: { enabled: true, location: '', store_numbers: ['R761'], part_numbers: ['MJY84CH/A'] } } }));
  assert.throws(() => normalizeMonitorSettings({ interval_seconds: 120, regions: { cn: { enabled: true, location: '518000', store_numbers: [], part_numbers: ['MJY84CH/A'] } } }));
  assert.throws(() => normalizeMonitorSettings({ interval_seconds: 120, regions: { cn: { enabled: true, location: '518000', store_numbers: ['R761', 'R761'], part_numbers: ['MJY84CH/A'] } } }));
  assert.throws(() => normalizeMonitorSettings({ interval_seconds: 120, regions: { cn: { enabled: true, location: '518000', store_numbers: ['R761'], part_numbers: [''] } } }));
});

test('normalization accepts arbitrary store and part numbers across regions', () => {
  const settings = normalizeMonitorSettings({
    interval_seconds: 10,
    regions: {
      cn: { enabled: true, location: '518000', store_numbers: ['R761', 'R448'], part_numbers: ['MJY84CH/A', 'MJYD4CH/A'] },
      hk: { enabled: true, location: '中環', store_numbers: ['R428'], part_numbers: ['MJXW4ZA/A', 'MJP74ZA/A'], keyword_alert: 'Pro Max,1TB,酒红色' },
    },
  });
  assert.equal(settings.interval_seconds, 10);
  assert.deepEqual(settings.regions.cn.store_numbers, ['R761', 'R448']);
  assert.deepEqual(settings.regions.cn.part_numbers, ['MJY84CH/A', 'MJYD4CH/A']);
  assert.equal(settings.regions.cn.keyword_alert, '');
  assert.deepEqual(settings.regions.hk.store_numbers, ['R428']);
  assert.equal(settings.regions.hk.location, '中環');
  assert.equal(settings.regions.hk.keyword_alert, 'Pro Max | 1TB | 酒红色');
});

test('disabled regions can have empty store/part arrays', () => {
  const settings = normalizeMonitorSettings({
    interval_seconds: 60,
    regions: {
      cn: { enabled: false, location: '518000', store_numbers: [], part_numbers: [] },
      hk: { enabled: true, location: '中環', store_numbers: ['R428'], part_numbers: ['MJXW4ZA/A'] },
    },
  });
  assert.equal(settings.regions.cn.enabled, false);
  assert.deepEqual(settings.regions.cn.store_numbers, []);
  assert.equal(settings.regions.hk.enabled, true);
});

test('buildMonitorConfig exposes regions with empty products/stores (filled in by room)', () => {
  const config = buildMonitorConfig({
    interval_seconds: 60,
    regions: {
      cn: { enabled: true, location: '518000', store_numbers: ['R761'], part_numbers: ['MJY84CH/A'] },
      hk: { enabled: false, location: '中環', store_numbers: [], part_numbers: [] },
    },
  });
  assert.equal(config.intervalSeconds, 60);
  assert.equal(config.pollSeconds, 60);
  assert.equal(config.regions.length, REGIONS.length);
  const cn = config.regions.find((r) => r.id === 'cn');
  const hk = config.regions.find((r) => r.id === 'hk');
  assert.equal(cn.enabled, true);
  assert.equal(cn.location, '518000');
  assert.deepEqual(cn.parts, ['MJY84CH/A']);
  assert.deepEqual(cn.storeNumbers, ['R761']);
  assert.equal(cn.keywordAlert, '');
  assert.equal(hk.enabled, false);
  assert.equal(hk.parts.length, 0);
});
